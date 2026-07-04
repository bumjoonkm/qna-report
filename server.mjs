import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import ExcelJS from 'exceljs';
// 분류 로직(프롬프트·기준)은 classifier.mjs에 격리. 분류 기준 변경 시 그 파일만 수정.
import { classify, shouldReject, extractQuestionText, MONITOR_CONFIDENCE_THRESHOLD } from './classifier.mjs';

const API = 'https://qna-admin-api.hiconsysvc.com';
const PORT = process.env.PORT || 3000;
const PAGE_SIZE = 100;
const CONCURRENCY = 20;
const CACHE_TTL = 10 * 60 * 1000; // 10분
const CACHE_DIR = '/tmp/qna-cache';

// ── 인메모리 캐시 (단기) ──
const cache = new Map();
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, ts: Date.now() }); return data; });
}

// ── 디스크 캐시 (로컬 /tmp) + Upstash Redis (영구) ──
//   로컬: dyno 라이프타임 내 빠른 읽기.
//   Upstash: dyno 재시작·재배포 후에도 유지. env 미설정 시 fallback (로컬만).
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UPSTASH_ENABLED = !!(UPSTASH_URL && UPSTASH_TOKEN);
if (UPSTASH_ENABLED) console.log('[cache] Upstash 영속 캐시 활성화');
else console.log('[cache] Upstash env 없음 — 로컬 /tmp 캐시만 사용');

async function upstashGet(key) {
  if (!UPSTASH_ENABLED) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body == null || body.result == null) return null;
    return JSON.parse(body.result);
  } catch { return null; }
}
function upstashSet(key, data) {
  if (!UPSTASH_ENABLED) return Promise.resolve(false);
  // 기본은 fire-and-forget(응답 지연 방지)이되, 호출부가 await하면 영속 보장 가능.
  return fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(data),
  }).then(r => r.ok).catch(() => false);
}
// 임의 Redis 명령 (Upstash REST: 명령 배열을 base URL에 POST). HSET/HVALS/EXPIRE 등.
// 반환은 {result}의 result. 미설정/실패 시 null.
async function upstashCmd(...args) {
  if (!UPSTASH_ENABLED) return null;
  try {
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body == null ? null : body.result;
  } catch { return null; }
}

async function diskGet(key) {
  // 1) 로컬 hit
  const p = `${CACHE_DIR}/${key}.json`;
  if (existsSync(p)) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch {}
  }
  // 2) Upstash hit → 로컬에도 백필
  const remote = await upstashGet(key);
  if (remote != null) {
    try { writeFileSync(p, JSON.stringify(remote)); } catch {}
    return remote;
  }
  return null;
}
function diskSet(key, data) {
  try { writeFileSync(`${CACHE_DIR}/${key}.json`, JSON.stringify(data)); } catch {}
  upstashSet(key, data);
}
// 영속이 반드시 필요한 값(1회용 회전 refreshToken 등)용: Upstash 기록을 await.
// Render 무료 dyno는 재배포·절전 기동마다 로컬 파일이 사라지므로, 새 dyno가
// 낡은(=폐기된) refreshToken을 읽지 않도록 새 토큰을 Upstash에 확정 저장한 뒤 진행한다.
async function diskSetDurable(key, data) {
  try { writeFileSync(`${CACHE_DIR}/${key}.json`, JSON.stringify(data)); } catch {}
  if (!UPSTASH_ENABLED) return true;
  for (let i = 0; i < 3; i++) {
    if (await upstashSet(key, data)) return true;
  }
  return false;
}

const BRANCHES = [
  { code: 'Z1', name: 'N관' },
  { code: 'Z2', name: 'M3관' },
  { code: 'Z3', name: '신관' },
  { code: 'Z6', name: 'W관' },
  { code: 'Y1', name: '목동관' },
  { code: 'G1', name: '기숙관' },
];

const AI_TA_IDS = new Set(['aiowl']);
const USD_TO_KRW = 1450;

// ── 학습무관 질문 자동 검열 감시기 설정 (형식/인프라) ──
// 분류 기준(모델·프롬프트·신뢰도 임계·이미지가드)은 classifier.mjs로 분리됨.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MONITOR_SECRET = process.env.MONITOR_SECRET || '';
const MONITOR_STATUS_WAIT = 'QA120002';   // 답변대기 (스캔 대상 상태)
const MONITOR_DIVISION = 'QA110002';      // 온라인 질문 (스캔 대상 구분)
const REJECT_REASON_CODE = 'QA250004';    // 기타사유 (ETC) — 거절 처리 코드
const REJECT_REASON_TEXT = '자동 질문 거절처리 되었습니다. 질문 수정 후 다시 질문해주세요.\n(ex. 단순 감정적인 질문, 장난스러운 질문, 학습범위 밖의 내용이 포함된 질문, TA 신변/사담, 오락 자료 요청, 과목 무관 잡상식, 생활 잡담 등)';
const MONITOR_CLASSIFY_CONCURRENCY = 5;
const MONITOR_SEEN_CAP = 20000;          // 하루치 답변대기 중복처리 방지
const MONITOR_LOG_CAP = 500;             // UI 최근 로그 상한 (durable 저장; 전체 이력은 monitor:judg HASH)
const MONITOR_INTERVAL_MS = 60 * 1000;    // 인프로세스 폴링 주기 (외부 cron 보조)

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function dtToDays(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function daysToDt(days) {
  const d = new Date(days * 86400000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function todayLocalDt() {
  const n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
}

// KST(UTC+9) 기준 '오늘' 날짜. Render는 UTC로 동작하므로 서버 로컬시각으로 '오늘'을
// 계산하면 KST 00:00~09:00 사이 등록분이 하루 늦은 날짜창에서 누락된다. getTime()은
// 절대시각(TZ 무관)이라 +9h 후 getUTC*로 읽으면 서버 TZ와 무관하게 항상 KST 벽시계.
function kstDateFromTs(ts) {
  const k = new Date(ts + 9 * 3600 * 1000);
  return k.getUTCFullYear() + '-' + String(k.getUTCMonth() + 1).padStart(2, '0') + '-' + String(k.getUTCDate()).padStart(2, '0');
}
function kstTodayDt() { return kstDateFromTs(Date.now()); }
// KST 전체 일시 문자열 (엑셀 표시용)
function kstTsString(ts) {
  if (!ts) return '';
  const k = new Date(ts + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())}`;
}

// startDt부터 X일씩 자르기. 마지막 미완성 구간(< X일)은 버림.
function splitPeriodByDays(startDt, endDt, daysPerBucket) {
  const startDays = dtToDays(startDt);
  const endDays = dtToDays(endDt);
  if (daysPerBucket < 1) return [];
  const out = [];
  let cursor = startDays;
  while (cursor + daysPerBucket - 1 <= endDays) {
    out.push({ start: daysToDt(cursor), end: daysToDt(cursor + daysPerBucket - 1) });
    cursor += daysPerBucket;
  }
  return out;
}

function shiftDate(dt, targetYear) {
  const [, m, d] = dt.split('-').map(Number);
  const last = lastDayOfMonth(targetYear, m);
  return `${targetYear}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

function shiftYearTo(periodArr, targetYear) {
  return periodArr.map(p => ({ start: shiftDate(p.start, targetYear), end: shiftDate(p.end, targetYear) }));
}

// ── API 헬퍼 ──

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://qna-admin.hiconsysvc.com',
      'Referer': 'https://qna-admin.hiconsysvc.com/login',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path, token, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return res.json();
    if (res.status === 500 && i < retries - 1) { await new Promise(r => setTimeout(r, 1000 * (i + 1))); continue; }
    throw new Error(`API ${res.status}`);
  }
}

async function parallelMap(arr, fn, concurrency) {
  const results = new Array(arr.length);
  let idx = 0;
  async function worker() {
    while (idx < arr.length) { const i = idx++; results[i] = await fn(arr[i]); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, arr.length) }, () => worker()));
  return results;
}

// ── 동영상 재활용 헬퍼 ──

const VIDEO_EXTS = new Set(['mp4', 'mov']);
function isVideoFile(name) {
  if (!name) return false;
  const e = name.split('.').pop().toLowerCase();
  return VIDEO_EXTS.has(e);
}
function buildAttachmentUrl(filePathways, fileName) {
  return `https://qna-image.hiconsysvc.com/${filePathways}/${fileName}`;
}
async function fetchHead(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return {
      etag: (res.headers.get('etag') || '').replace(/"/g, ''),
      contentLength: parseInt(res.headers.get('content-length') || '0', 10),
    };
  } catch (e) { return { error: e.message }; }
}

// ── 답변불가 리포트 ──

async function fetchReport(token, startDt, endDt) {
  const first = await get(`/v1/qna/list?page=1&pageSize=1&startDt=${startDt}&endDt=${endDt}&questionStatusCommonCode=QA120006&searchType=taName`, token);
  const total = first.data.totalCount;
  const pages = Math.ceil(total / PAGE_SIZE) || 1;
  const items = [];
  for (let p = 1; p <= pages; p++) {
    const body = await get(`/v1/qna/list?page=${p}&pageSize=${PAGE_SIZE}&startDt=${startDt}&endDt=${endDt}&questionStatusCommonCode=QA120006&searchType=taName`, token);
    items.push(...(body.data.contents || []));
  }
  const details = await parallelMap(items, async (item) => {
    try {
      const body = await get(`/v1/qna/${item.qnaQuestionMasterSerialNo}`, token);
      return { taId: item.taId || '', taName: item.taName || '', reasonName: body.data.answerNoAdmittedReasonCommonCodeName || null };
    } catch { return { taId: item.taId || '', taName: item.taName || '', reasonName: null }; }
  }, CONCURRENCY);
  const reasonDist = {}, taMap = {};
  for (const d of details) {
    const r = d.reasonName || '(사유 없음)';
    reasonDist[r] = (reasonDist[r] || 0) + 1;
    if (d.reasonName === '제한 시간 내 TA 미답변') {
      const k = d.taId || d.taName;
      if (!taMap[k]) taMap[k] = { taId: d.taId, name: d.taName, count: 0 };
      taMap[k].count++;
    }
  }
  const taList = Object.values(taMap).sort((a, b) => b.count - a.count);
  const timeoutCount = taList.reduce((s, t) => s + t.count, 0);
  return { period: { start: startDt, end: endDt }, totalUnanswerable: total, timeoutCount, taCount: taList.length, reasonDist, taList };
}

// ── TA Meet 스케줄 ──

async function fetchSchedule(token, year, month, branchCode) {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const startDt = `${year}-${mm}-01`;
  const endDt = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;

  const result = await get(
    `/v1/ta/schedule/work/list?startDt=${startDt}&endDt=${endDt}&erpBranchCode=${branchCode}&workDivisionCommonCode=QA510001&onlineYn=A&includeCanceled=false&orderType=scheduleDtAsc&limit=9999`,
    token,
  );

  const counts = {};
  for (const w of (result.data.works || [])) {
    if (w.deleteYn === 'Y') continue;
    const dt = w.scheduleDt;
    const time = w.workTimeCommonCodeName.split('(')[0];
    if (!counts[dt]) counts[dt] = {};
    counts[dt][time] = (counts[dt][time] || 0) + 1;
  }
  // 급여 계산
  const rate = branchCode === 'G1' ? 42000 : 52500;
  let totalSlots = 0;
  for (const dt of Object.keys(counts)) {
    for (const time of Object.keys(counts[dt])) {
      totalSlots += counts[dt][time];
    }
  }
  return { year, month, branchCode, counts, slots: totalSlots, salary: totalSlots * rate };
}

async function fetchSalaryAll(token, year, month) {
  const results = await Promise.all(
    BRANCHES.map(b => fetchSchedule(token, year, month, b.code).then(r => ({ code: b.code, name: b.name, salary: r.salary, slots: r.slots })))
  );
  const total = results.reduce((s, r) => s + r.salary, 0);
  const totalSlots = results.reduce((s, r) => s + r.slots, 0);
  return { year, month, branches: results, total, totalSlots };
}

// ── TA 성과 ──

// 하루치 데이터 가져오기 (디스크 캐시 활용)
async function fetchDayItems(token, dt) {
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `perf2-${dt}`;
  if (dt < today) {
    const cached = await diskGet(cacheKey);
    if (cached) return cached;
  }
  const items = [];
  const first = await get(`/v1/qna/list?page=1&pageSize=${PAGE_SIZE}&startDt=${dt}&endDt=${dt}&questionStatusCommonCode=QA120004&searchType=taName`, token);
  items.push(...(first.data.contents || []));
  const pages = Math.ceil((first.data.totalCount || 0) / PAGE_SIZE);
  for (let p = 2; p <= pages; p++) {
    const body = await get(`/v1/qna/list?page=${p}&pageSize=${PAGE_SIZE}&startDt=${dt}&endDt=${dt}&questionStatusCommonCode=QA120004&searchType=taName`, token);
    items.push(...(body.data.contents || []));
  }
  const simplified = items.filter(i => i.taId || i.taName).map(i => ({
    taId: i.taId, taName: i.taName, admitAt: i.consultationAdmissionAt, answerEndAt: i.answerEndAt, starScore: i.starScore,
    aiCostTotal: i.aiCostTotal ?? 0,
  }));
  if (dt < today) diskSet(cacheKey, simplified);
  return simplified;
}

// 날짜 범위를 일별로 분할해서 병렬 조회 (과거는 캐시 히트, 빠름)
async function fetchPerformance(token, startDt, endDt) {
  const dates = [];
  for (let d = new Date(startDt); d <= new Date(endDt); d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  const dayResults = await parallelMap(dates, (dt) => fetchDayItems(token, dt), 3);
  const items = dayResults.flat();
  const taMap = {};
  for (const item of items) {
    const k = item.taId || item.taName;
    if (!taMap[k]) taMap[k] = { taId: item.taId, name: item.taName, count: 0, totalMin: 0, totalStar: 0, starCount: 0 };
    taMap[k].count++;
    if (item.admitAt && item.answerEndAt) {
      const diff = (new Date(item.answerEndAt) - new Date(item.admitAt)) / 60000;
      if (diff >= 0) taMap[k].totalMin += diff;
    }
    if (item.starScore != null) {
      taMap[k].totalStar += item.starScore;
      taMap[k].starCount++;
    }
  }
  const taList = Object.values(taMap).map(t => ({
    taId: t.taId, name: t.name, count: t.count,
    avgMin: t.count > 0 ? Math.round(t.totalMin / t.count) : 0,
    avgStar: t.starCount > 0 ? (t.totalStar / t.starCount).toFixed(1) : '-',
  })).sort((a, b) => b.count - a.count);
  const totalCount = taList.reduce((s, t) => s + t.count, 0);
  const totalMin = taList.reduce((s, t) => s + t.avgMin * t.count, 0);
  const totalStar = taList.reduce((s, t) => s + (t.avgStar !== '-' ? parseFloat(t.avgStar) * t.count : 0), 0);
  const starItems = taList.reduce((s, t) => s + (t.avgStar !== '-' ? t.count : 0), 0);
  return {
    period: { start: startDt, end: endDt }, totalAnswered: items.length, taCount: taList.length,
    avgMin: totalCount > 0 ? Math.round(totalMin / totalCount) : 0,
    avgStar: starItems > 0 ? (totalStar / starItems).toFixed(1) : '-',
    taList,
  };
}

// ── 별점 비교 (25 vs 26) ──

// 대면(QA110001)은 TA Meet 답변완료(QA010009 + meetonYn=A), 온라인(QA110002)은 문제해결(QA120004).
const RATING_DIV_STATUS = {
  QA110001: 'QA010009&meetonYn=A',
  QA110002: 'QA120004',
};

// (date, division) 1일치: 리뷰 starScores 배열 + 답변완료 totalCount.
// 과거일만 디스크 캐시 (immutable). 오늘일은 매번 fresh.
async function fetchRatingDay(token, dt, division) {
  const today = todayLocalDt();
  const cacheKey = `rating-day-v2-${division}-${dt}`;
  const isPast = dt < today;
  if (isPast) {
    const c = await diskGet(cacheKey);
    if (c) return c;
  }
  // 1) /v1/review/list 페이지네이션 → starScores 모음
  const starScores = [];
  const first = await get(`/v1/review/list?page=1&pageSize=${PAGE_SIZE}&startDt=${dt}&endDt=${dt}&questionDivisionCommonCode=${division}&searchType=memberName`, token);
  const fd = first?.data || {};
  const reviewTotal = fd.totalElements ?? fd.totalCount ?? fd.total ?? 0;
  for (const r of (fd.contents || [])) if (r.starScore != null) starScores.push(r.starScore);
  const pages = Math.ceil(reviewTotal / PAGE_SIZE);
  for (let p = 2; p <= pages; p++) {
    const body = await get(`/v1/review/list?page=${p}&pageSize=${PAGE_SIZE}&startDt=${dt}&endDt=${dt}&questionDivisionCommonCode=${division}&searchType=memberName`, token);
    for (const r of (body?.data?.contents || [])) if (r.starScore != null) starScores.push(r.starScore);
  }
  // 2) 답변완료 분모 — division별로 status 코드 분기
  const statusFrag = RATING_DIV_STATUS[division];
  const cnt = await get(`/v1/qna/list?page=1&pageSize=1&startDt=${dt}&endDt=${dt}&questionDivisionCommonCode=${division}&questionStatusCommonCode=${statusFrag}&searchType=taName`, token);
  const cd = cnt?.data || {};
  const resolvedCount = cd.totalElements ?? cd.totalCount ?? cd.total ?? 0;

  const result = { starScores, resolvedCount };
  if (isPast) diskSet(cacheKey, result);
  return result;
}

async function fetchRatingComparison(token, startDt, endDt) {
  const today = todayLocalDt();
  const refEnd = endDt > today ? today : endDt;
  const refStart = startDt;
  const refYear = parseInt(refStart.split('-')[0]);
  const [prevPeriod] = shiftYearTo([{ start: refStart, end: refEnd }], refYear - 1);

  const refDates = [];
  for (let d = dtToDays(refStart); d <= dtToDays(refEnd); d++) refDates.push(daysToDt(d));
  const prevDates = [];
  for (let d = dtToDays(prevPeriod.start); d <= dtToDays(prevPeriod.end); d++) prevDates.push(daysToDt(d));

  const divisions = ['QA110001', 'QA110002'];
  const tasks = [];
  for (const dt of refDates) for (const div of divisions) tasks.push({ year: 'ref', dt, div });
  for (const dt of prevDates) for (const div of divisions) tasks.push({ year: 'prev', dt, div });
  const results = await parallelMap(tasks, async (t) => {
    const r = await fetchRatingDay(token, t.dt, t.div);
    return { ...t, ...r };
  }, CONCURRENCY);

  function aggregate(filterFn) {
    const subset = results.filter(filterFn);
    const allStars = subset.flatMap(s => s.starScores);
    const n = allStars.length;
    const sum = allStars.reduce((a, b) => a + b, 0);
    const positive = allStars.filter(s => s === 5).length;
    const negative = allStars.filter(s => s === 1 || s === 2).length;
    return {
      avgStar: n > 0 ? +(sum / n).toFixed(2) : null,
      resolvedCount: subset.reduce((s, r) => s + r.resolvedCount, 0),
      reviewCount: n,
      positiveRate: n > 0 ? +((positive / n) * 100).toFixed(1) : null,
      negativeRate: n > 0 ? +((negative / n) * 100).toFixed(1) : null,
    };
  }

  return {
    refYear, prevYear: refYear - 1,
    refPeriod: { start: refStart, end: refEnd },
    prevPeriod: { start: prevPeriod.start, end: prevPeriod.end },
    inPerson: {
      prev: aggregate(r => r.year === 'prev' && r.div === 'QA110001'),
      ref:  aggregate(r => r.year === 'ref'  && r.div === 'QA110001'),
    },
    online: {
      prev: aggregate(r => r.year === 'prev' && r.div === 'QA110002'),
      ref:  aggregate(r => r.year === 'ref'  && r.div === 'QA110002'),
    },
  };
}

// ── 동영상 재활용 ──

// 캐시 정책: 과거일(< today)은 영구. 오늘일(== today)은 30분 stale 허용.
// envelope 포맷 {savedAt, data}로 저장. 옛 array 포맷도 읽기 호환.
const VIDREUSE_DAY_TODAY_TTL_MS = 30 * 60 * 1000;
const VIDREUSE_RESULT_TODAY_TTL_MS = 60 * 60 * 1000;

// 하루치: 온라인 + 문제해결 질문의 비디오 첨부만 추출. 디스크 캐시 + Upstash 영속.
// 캐시 entry에 HEAD 결과(etag/contentLength)까지 박아둬서 재검색 시 HEAD 재호출 안 함.
// 파일 URL은 immutable이라 한 번 채우면 변하지 않음.
async function fetchDayVideoFiles(token, dt) {
  const today = todayLocalDt();
  const cacheKey = `vidreuse-day-v2-${dt}`;
  const isPast = dt < today;

  const c = await diskGet(cacheKey);
  if (c) {
    if (Array.isArray(c)) {
      // 옛 포맷 (과거일만 저장됐었음) — 영구 hit
      if (isPast) return c;
    } else if (c && typeof c.savedAt === 'number' && Array.isArray(c.data)) {
      if (isPast || Date.now() - c.savedAt < VIDREUSE_DAY_TODAY_TTL_MS) return c.data;
    }
  }

  // 1) 일별 온라인+문제해결 list 페이지네이션
  const listItems = [];
  const first = await get(`/v1/qna/list?page=1&pageSize=${PAGE_SIZE}&startDt=${dt}&endDt=${dt}&questionDivisionCommonCode=QA110002&questionStatusCommonCode=QA120004&searchType=taName`, token);
  listItems.push(...(first.data.contents || []));
  const pages = Math.ceil((first.data.totalCount || 0) / PAGE_SIZE);
  for (let p = 2; p <= pages; p++) {
    const body = await get(`/v1/qna/list?page=${p}&pageSize=${PAGE_SIZE}&startDt=${dt}&endDt=${dt}&questionDivisionCommonCode=QA110002&questionStatusCommonCode=QA120004&searchType=taName`, token);
    listItems.push(...(body.data.contents || []));
  }
  // 2) 각 question의 detail에서 비디오 첨부만 추출 (병렬)
  const enriched = await parallelMap(listItems, async (item) => {
    if (!item.taId && !item.taName) return null;
    try {
      const body = await get(`/v1/qna/${item.qnaQuestionMasterSerialNo}`, token);
      const d = body.data || {};
      const videos = (d.answerFiles || []).filter(f => isVideoFile(f.fileName));
      if (videos.length === 0) return null;
      const qd = item.questionDetails?.[0] || {};
      return {
        masterSerialNo: item.qnaQuestionMasterSerialNo,
        taId: item.taId || '',
        taName: item.taName || '',
        registerAt: item.registerAt || '',
        subjectDomain: qd.erpSubjectDomainCodeName || '',
        subjectClass: qd.erpSubjectClassificationCodeName || '',
        contents: qd.questionContsNm || '',
        turnOrd: qd.questionTurnOrd ?? '',
        problemNo: qd.questionExampprAnssheetNo ?? '',
        videoFiles: videos.map(f => ({
          filePathways: f.filePathways,
          fileName: f.fileName,
          qnaFileSerialNo: f.qnaFileSerialNo,
          url: buildAttachmentUrl(f.filePathways, f.fileName),
        })),
      };
    } catch { return null; }
  }, CONCURRENCY);
  const result = enriched.filter(x => x !== null);
  // 3) HEAD로 etag/contentLength 채우기 → 캐시 entry에 영속화 (CDN 파일 URL immutable)
  const flatFiles = [];
  for (const q of result) for (const f of q.videoFiles) flatFiles.push(f);
  await parallelMap(flatFiles, async (f) => {
    const h = await fetchHead(f.url);
    f.etag = h.etag || null;
    f.contentLength = h.contentLength || 0;
    if (h.error) f.headError = h.error;
  }, CONCURRENCY);
  // 과거일은 무기한 / 오늘일은 30분 stale 허용. 둘 다 envelope 포맷으로 저장.
  diskSet(cacheKey, { savedAt: Date.now(), data: result });
  return result;
}

async function fetchVideoReuse(token, startDt, endDt) {
  const startDays = dtToDays(startDt);
  const endDays = dtToDays(endDt);
  if (endDays < startDays) throw new Error('시작일이 종료일보다 이후입니다.');

  // 일별 수집 (병렬 3)
  const dates = [];
  for (let d = startDays; d <= endDays; d++) dates.push(daysToDt(d));
  const dayResults = await parallelMap(dates, (dt) => fetchDayVideoFiles(token, dt), 3);
  const dayItems = dayResults.flat();

  // 첨부 평면화 + (masterSerialNo, qnaFileSerialNo) dedup (페이지네이션 보호)
  // etag/contentLength는 fetchDayVideoFiles에서 이미 채워져 있음 (캐시 hit 시 HEAD 0회)
  const seen = new Set();
  const heads = [];
  for (const q of dayItems) {
    for (const f of q.videoFiles) {
      const k = `${q.masterSerialNo}|${f.qnaFileSerialNo}`;
      if (seen.has(k)) continue;
      seen.add(k);
      heads.push({
        url: f.url || buildAttachmentUrl(f.filePathways, f.fileName),
        fileName: f.fileName,
        etag: f.etag || null,
        contentLength: f.contentLength || 0,
        masterSerialNo: q.masterSerialNo,
        taId: q.taId,
        taName: q.taName,
        registerAt: q.registerAt,
        subjectDomain: q.subjectDomain,
        subjectClass: q.subjectClass,
        contents: q.contents,
        turnOrd: q.turnOrd,
        problemNo: q.problemNo,
      });
    }
  }

  // ETag 그룹핑
  const byEtag = new Map();
  for (const h of heads) {
    if (!h.etag) continue;
    if (!byEtag.has(h.etag)) byEtag.set(h.etag, []);
    byEtag.get(h.etag).push(h);
  }

  // TA별 재활용 파일 모으기 (같은 TA의 ETag가 ≥2회, masterSerialNo dedup 후도 ≥2)
  const taAgg = new Map();
  for (const [etag, group] of byEtag) {
    if (group.length < 2) continue;
    // TA별 분리
    const byTa = new Map();
    for (const h of group) {
      if (!byTa.has(h.taId)) byTa.set(h.taId, []);
      byTa.get(h.taId).push(h);
    }
    for (const [taId, subset] of byTa) {
      if (subset.length < 2) continue;
      // masterSerialNo dedup
      const byQ = new Map();
      for (const h of subset) {
        if (!byQ.has(h.masterSerialNo)) byQ.set(h.masterSerialNo, h);
      }
      const deduped = [...byQ.values()].sort((a, b) => (a.registerAt || '').localeCompare(b.registerAt || ''));
      if (deduped.length < 2) continue;

      const original = deduped[0];
      const reuses = deduped.slice(1);

      const agg = taAgg.get(taId) || {
        taId,
        taName: original.taName,
        originalCount: 0,
        totalUses: 0,
        files: [],
      };
      agg.taName = agg.taName || original.taName;
      agg.originalCount += 1;
      agg.totalUses += deduped.length;
      agg.files.push({
        fileName: original.fileName,
        url: original.url,
        contentLength: original.contentLength,
        etag,
        totalUses: deduped.length,
        original: pickMeta(original),
        reuses: reuses.map(pickMeta),
      });
      taAgg.set(taId, agg);
    }
  }

  const taList = [...taAgg.values()].map(t => {
    // 파일들은 재사용 횟수 내림차순
    t.files.sort((a, b) => b.totalUses - a.totalUses);
    return { ...t, extraUses: t.totalUses - t.originalCount };
  }).sort((a, b) => b.extraUses - a.extraUses);

  const totalOriginals = taList.reduce((s, t) => s + t.originalCount, 0);
  const totalUses = taList.reduce((s, t) => s + t.totalUses, 0);
  const totalExtra = taList.reduce((s, t) => s + t.extraUses, 0);

  return {
    period: { start: startDt, end: endDt },
    totalAttachments: heads.length,
    totalQuestionsWithVideo: dayItems.length,
    totalOriginals,
    totalUses,
    totalExtra,
    taCount: taList.length,
    taList,
  };
}

function pickMeta(h) {
  return {
    masterSerialNo: h.masterSerialNo,
    registerAt: h.registerAt,
    subjectDomain: h.subjectDomain,
    subjectClass: h.subjectClass,
    contents: h.contents,
    turnOrd: h.turnOrd,
    problemNo: h.problemNo,
  };
}

// ── 정산 데이터 (온라인 질문 TA 급여) ──

async function fetchSettleMonth(token, year, month) {
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const cacheKey = `settle-v2-${ym}`;
  const today = todayLocalDt();
  const monthEnd = `${ym}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`;
  if (monthEnd < today) {
    const c = await diskGet(cacheKey);
    if (c) return c;
  }
  try {
    const res = await get(`/v1/qna/settle/online/detail?year=${year}&month=${month}&workDivisionCommonCode=QA510001`, token);
    const rows = Array.isArray(res?.data) ? res.data : (res?.data?.contents ?? []);
    const byDate = {};
    for (const r of rows) {
      if (!r.basisDt || r.taId === 'aiowl') continue;
      // onlineQuestionSettleAccountsAmount는 영상 답변 인센티브(sumAnswerGradeVideoAmount)를
      // 누락하므로 함께 더해야 CSV 정산금액과 일치 (99.4% 정확도).
      const amt = (r.onlineQuestionSettleAccountsAmount || 0) + (r.sumAnswerGradeVideoAmount || 0);
      byDate[r.basisDt] = (byDate[r.basisDt] || 0) + amt;
    }
    if (monthEnd < today) diskSet(cacheKey, byDate);
    return byDate;
  } catch (e) {
    return {};
  }
}

async function fetchSettleForRange(token, startDt, endDt) {
  const [ys, ms] = startDt.split('-').map(Number);
  const [ye, me] = endDt.split('-').map(Number);
  const months = [];
  for (let y = ys; y <= ye; y++) {
    const mFrom = y === ys ? ms : 1;
    const mTo = y === ye ? me : 12;
    for (let mo = mFrom; mo <= mTo; mo++) months.push({ y, m: mo });
  }
  const maps = await parallelMap(months, ({ y, m }) => fetchSettleMonth(token, y, m), 6);
  const merged = {};
  for (const m of maps) Object.assign(merged, m);
  return merged;
}

// ── AI 현황 보고 ──

async function fetchAiStatus(token, monthA, monthB, daysPerBucket) {
  const refYear = parseInt(monthA.split('-')[0]);
  const aMonth = parseInt(monthA.split('-')[1]);
  const bMonth = parseInt(monthB.split('-')[1]);
  const refStart = `${refYear}-${String(aMonth).padStart(2, '0')}-01`;
  const monthEnd = `${refYear}-${String(bMonth).padStart(2, '0')}-${String(lastDayOfMonth(refYear, bMonth)).padStart(2, '0')}`;
  // B월 마지막날이 미래면 오늘로 클램프 (refYear == 올해일 때만 의미 있음)
  const today = todayLocalDt();
  const refEnd = monthEnd > today ? today : monthEnd;

  const periodsRef = splitPeriodByDays(refStart, refEnd, daysPerBucket);
  const periodsPrev = shiftYearTo(periodsRef, refYear - 1);

  const allDates = new Set();
  [...periodsRef, ...periodsPrev].forEach(p => {
    const sd = dtToDays(p.start), ed = dtToDays(p.end);
    for (let day = sd; day <= ed; day++) allDates.add(daysToDt(day));
  });

  const dayMap = {};
  await parallelMap([...allDates], async (dt) => { dayMap[dt] = await fetchDayItems(token, dt); }, CONCURRENCY);

  const refRangeStart = periodsRef[0]?.start;
  const refRangeEnd = periodsRef[periodsRef.length - 1]?.end;
  const prevRangeStart = periodsPrev[0]?.start;
  const prevRangeEnd = periodsPrev[periodsPrev.length - 1]?.end;
  const [settleRef, settlePrev] = await Promise.all([
    refRangeStart ? fetchSettleForRange(token, refRangeStart, refRangeEnd) : Promise.resolve({}),
    prevRangeStart ? fetchSettleForRange(token, prevRangeStart, prevRangeEnd) : Promise.resolve({}),
  ]);

  const isAI = (item) => AI_TA_IDS.has(item.taId);
  const sumRange = (period, predicate) => {
    let total = 0;
    const sd = dtToDays(period.start), ed = dtToDays(period.end);
    for (let day = sd; day <= ed; day++) {
      total += (dayMap[daysToDt(day)] || []).filter(predicate).length;
    }
    return total;
  };
  const sumSettleRange = (period, byDate) => {
    let total = 0;
    const sd = dtToDays(period.start), ed = dtToDays(period.end);
    for (let day = sd; day <= ed; day++) total += byDate[daysToDt(day)] || 0;
    return total;
  };
  const sumAiCostRange = (period) => {
    let usd = 0;
    const sd = dtToDays(period.start), ed = dtToDays(period.end);
    for (let day = sd; day <= ed; day++) {
      for (const item of (dayMap[daysToDt(day)] || [])) {
        if (AI_TA_IDS.has(item.taId)) usd += item.aiCostTotal || 0;
      }
    }
    return Math.round(usd * USD_TO_KRW);
  };

  const periods = periodsRef.map((pRef, i) => {
    const pPrev = periodsPrev[i];
    const costPrev = sumSettleRange(pPrev, settlePrev);
    const costRefHuman = sumSettleRange(pRef, settleRef);
    const costRefAi = sumAiCostRange(pRef);
    const costRef = costRefHuman + costRefAi;
    const savingsPct = costPrev > 0 ? ((costPrev - costRef) / costPrev) * 100 : null;
    return {
      labelRef: `${pRef.start} ~ ${pRef.end}`,
      labelPrev: `${pPrev.start} ~ ${pPrev.end}`,
      yPrev_human: sumRange(pPrev, x => !isAI(x)),
      yRef_human: sumRange(pRef, x => !isAI(x)),
      yRef_ai: sumRange(pRef, x => isAI(x)),
      costPrev,
      costRefHuman,
      costRefAi,
      costRef,
      savingsPct,
    };
  });

  const daily = [];
  const sdRef = dtToDays(refStart), edRef = dtToDays(refEnd);
  for (let day = sdRef; day <= edRef; day++) {
    const dt = daysToDt(day);
    const items = dayMap[dt] || [];
    const total = items.length;
    const ai = items.filter(isAI).length;
    daily.push({
      date: dt,
      aiCount: ai,
      totalCount: total,
      ratio: total > 0 ? ai / total : null,
    });
  }

  return { refYear, prevYear: refYear - 1, periods, daily };
}

// ── 바우처 내역 (xlsx 다운로드) ──

const VOUCHER_COLUMNS = [
  { header: '번호', key: 'memberSerialNo', width: 8 },
  { header: '아이디', key: 'erpMemberId', width: 12 },
  { header: '이름', key: 'memberName', width: 12 },
  { header: '학생연락처', key: 'studentTelephoneNumber', width: 16 },
  { header: '관정보', key: 'erpBranchCodeName', width: 14 },
  { header: '배부 TA meet 시간(분)', key: 'meetIssued', width: 18 },
  { header: '이용 TA meet 시간(분)', key: 'meetUsed', width: 18 },
  { header: '배부 TA meet (online) 시간(분)', key: 'meetonIssued', width: 24 },
  { header: '이용 TA meet (online) 시간(분)', key: 'meetonUsed', width: 24 },
  { header: '배부 질문하기 답변(회)', key: 'questionIssued', width: 18 },
  { header: '이용 질문하기 답변(회)', key: 'questionUsed', width: 18 },
  { header: '배부 AI 질문(회)', key: 'aiQuestionIssued', width: 16 },
  { header: '이용 AI 질문(회)', key: 'aiQuestionUsed', width: 16 },
  { header: '배부 SA 멘토링(회)', key: 'mentoringIssued', width: 16 },
  { header: '이용 SA 멘토링(회)', key: 'mentoringUsed', width: 16 },
];

function pair(total, remain) {
  if (total == null) return ['-', '-'];
  return [total, total - remain];
}

function voucherCells(v) {
  if (!v) return {
    meetIssued: '-', meetUsed: '-',
    meetonIssued: '-', meetonUsed: '-',
    questionIssued: '-', questionUsed: '-',
    aiQuestionIssued: '-', aiQuestionUsed: '-',
    mentoringIssued: '-', mentoringUsed: '-',
  };
  const [meetI, meetU] = pair(v.meetTotalVoucherHourCount, v.meetRemainVoucherHourCount);
  const [meetonI, meetonU] = pair(v.meetonTotalVoucherHourCount, v.meetonRemainVoucherHourCount);
  const [qI, qU] = pair(v.questionTotalVoucherCount, v.questionRemainVoucherCount);
  const [aiI, aiU] = pair(v.aiQuestionTotalVoucherCount, v.aiQuestionRemainVoucherCount);
  const [mI, mU] = pair(v.mentoringTotalVoucherCount, v.mentoringRemainVoucherCount);
  return {
    meetIssued: meetI, meetUsed: meetU,
    meetonIssued: meetonI, meetonUsed: meetonU,
    questionIssued: qI, questionUsed: qU,
    aiQuestionIssued: aiI, aiQuestionUsed: aiU,
    mentoringIssued: mI, mentoringUsed: mU,
  };
}

function extractVouchers(rawData) {
  if (rawData == null) return [];
  if (Array.isArray(rawData)) return rawData;
  if (Array.isArray(rawData.memberVouchers)) return rawData.memberVouchers;
  if (Array.isArray(rawData.vouchers)) return rawData.vouchers;
  if (Array.isArray(rawData.contents)) return rawData.contents;
  return [];
}

async function fetchMemberDetail(token, id) {
  // get()이 404를 throw하므로 404는 null 반환으로 처리.
  let info, vouchers;
  try {
    [info, vouchers] = await Promise.all([
      get(`/v1/member/${id}`, token).catch(e => {
        if (String(e.message).includes('404')) return null;
        throw e;
      }),
      get(`/v1/member/${id}/vouchers`, token).catch(e => {
        if (String(e.message).includes('404')) return null;
        throw e;
      }),
    ]);
  } catch (e) {
    throw e;
  }
  if (!info) return null;
  const m = info.data ?? info;
  const vs = extractVouchers(vouchers?.data ?? vouchers ?? null);
  return {
    id, memberSerialNo: id,
    erpMemberId: m?.erpMemberId ?? '',
    memberName: m?.memberName ?? '',
    studentTelephoneNumber: m?.studentTelephoneNumber ?? '',
    erpBranchCodeName: m?.erpBranchCodeName ?? '',
    vouchers: vs,
  };
}

function monthsInRange(monthStart, monthEnd) {
  const [ys, ms] = monthStart.split('-').map(Number);
  const [ye, me] = monthEnd.split('-').map(Number);
  const out = [];
  for (let y = ys; y <= ye; y++) {
    const mFrom = y === ys ? ms : 1;
    const mTo = y === ye ? me : 12;
    for (let mo = mFrom; mo <= mTo; mo++) {
      out.push(`${y}-${String(mo).padStart(2, '0')}`);
    }
  }
  return out;
}

async function exportVouchers(token, monthStart, monthEnd, idStart, idEnd) {
  const ids = [];
  for (let id = idStart; id <= idEnd; id++) ids.push(id);

  const results = await parallelMap(ids, (id) => fetchMemberDetail(token, id), CONCURRENCY);
  const members = results.filter(m => m).sort((a, b) => a.id - b.id);

  const months = monthsInRange(monthStart, monthEnd);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'qna-report';
  wb.created = new Date();

  for (const ym of months) {
    const sheet = wb.addWorksheet(`${parseInt(ym.slice(5), 10)}월`);
    sheet.columns = VOUCHER_COLUMNS;
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    for (const m of members) {
      const v = m.vouchers.find(v => v.startDt && v.startDt.slice(0, 7) === ym);
      sheet.addRow({
        memberSerialNo: m.memberSerialNo,
        erpMemberId: m.erpMemberId,
        memberName: m.memberName,
        studentTelephoneNumber: m.studentTelephoneNumber,
        erpBranchCodeName: m.erpBranchCodeName,
        ...voucherCells(v),
      });
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── 라우팅 ──

function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d)); });
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ════════════════════════════════════════════════════════════════════
//  학습무관 질문 자동 검열 감시기
//  온라인 "답변대기" 질문을 폴링 → Claude로 분류 → 학습무관만 답변불가 처리.
//  그림자 모드(기본): 실제 거절 없이 "거절했을 것"만 기록. 자동 모드: 실거절.
// ════════════════════════════════════════════════════════════════════

// MONITOR_SYS_PROMPT, classifyQuestion, classifyOne, extractQuestionText →
// 분류 로직은 classifier.mjs로 이동 (분류 기준 변경 시 그 파일만 수정).

let monitorRunning = false;

// PATCH 헬퍼 (거절 처리용). get()과 동일 인증 + Origin/Referer 헤더.
async function patch(path, token, body, retries = 2) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`${API}${path}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': 'https://qna-admin.hiconsysvc.com',
        'Referer': 'https://qna-admin.hiconsysvc.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) { try { return await res.json(); } catch { return {}; } }
    if (res.status >= 500 && i < retries - 1) { await new Promise(r => setTimeout(r, 800 * (i + 1))); continue; }
    const t = await res.text().catch(() => '');
    throw new Error(`PATCH ${res.status} ${t.slice(0, 200)}`);
  }
}

function jwtPayload(token) {
  try {
    const seg = token.split('.')[1];
    return JSON.parse(Buffer.from(seg, 'base64').toString('utf8'));
  } catch { return {}; }
}
function jwtExpMs(token) { const p = jwtPayload(token); return (p.exp || 0) * 1000; }
function jwtClaim(token, key) { return jwtPayload(token)[key]; }

// verify(2FA) 응답에서 감시용 인증정보 추출 + 영속 저장 (Upstash 기록 await)
async function saveMonitorAuth(data) {
  if (!data || !data.accessToken) return;
  const auth = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || null,
    managerAccountSerialNo:
      data.managerAccountSerialNo ?? data.managerSerialNo ??
      jwtClaim(data.accessToken, 'managerAccountSerialNo') ??
      jwtClaim(data.accessToken, 'sub') ?? null,
    savedAt: Date.now(),
  };
  await diskSetDurable('monitor:auth', auth);
}

// refreshToken으로 access 토큰 강제 재발급(exp와 무관). 성공 시 새 토큰을 durable 저장 후 반환.
// 공유 forestta 계정이 다른 곳에서 로그인하면 모니터의 access 토큰이 서버측에서 무효화되는데
// (JWT exp는 미래라 ensureMonitorToken은 갱신 안 함) → API 401. 그 401을 이걸로 자가복구한다.
let lastRefreshErr = null; // 진단용: 마지막 refresh 실패 사유 (자격증명 없음)
async function refreshMonitorToken() {
  const auth = await diskGet('monitor:auth');
  if (!auth || !auth.refreshToken || auth.managerAccountSerialNo == null) {
    lastRefreshErr = { at: Date.now(), reason: 'stored auth 불완전', hasRefreshToken: !!(auth && auth.refreshToken), managerSerialSet: auth?.managerAccountSerialNo != null };
    throw new Error('NEED_LOGIN');
  }
  let r;
  try {
    r = await post('/v1/manager/auth/refresh', {
      managerAccountSerialNo: auth.managerAccountSerialNo,
      refreshToken: auth.refreshToken,
    });
  } catch (e) {
    lastRefreshErr = { at: Date.now(), reason: 'refresh 요청 예외: ' + (e.message || '') };
    throw new Error('NEED_LOGIN');
  }
  const data = r && r.data;
  if (!data || !data.accessToken || !data.refreshToken) {
    lastRefreshErr = { at: Date.now(), reason: 'refresh 응답에 토큰 없음', code: r?.code ?? null, message: r?.message ?? null, dataKeys: data ? Object.keys(data) : null };
    throw new Error('NEED_LOGIN');
  }
  lastRefreshErr = null;
  // 회전형 1회용 토큰: refresh 성공 순간 옛 refreshToken은 폐기됨. 새 토큰을
  // Upstash에 확정 저장한 뒤 사용해야 dyno 교체 시 죽은 토큰을 물려받지 않는다.
  const next = { ...auth, accessToken: data.accessToken, refreshToken: data.refreshToken, savedAt: Date.now() };
  const persisted = await diskSetDurable('monitor:auth', next);
  if (!persisted) console.warn('[monitor] refreshToken Upstash 영속 저장 실패 — 재배포/절전 시 재로그인 필요할 수 있음');
  return next.accessToken;
}

// refresh를 단일 in-flight로 직렬화. 동시(병렬 상세조회 등)에 여러 401이 나도
// refresh는 한 번만 실행 → 회전형 refreshToken을 폐기본으로 재사용(R40110)하는 것 방지.
let monitorRefreshInflight = null;
function refreshMonitorTokenOnce() {
  if (!monitorRefreshInflight) {
    monitorRefreshInflight = refreshMonitorToken().finally(() => { monitorRefreshInflight = null; });
  }
  return monitorRefreshInflight;
}

// 만료 임박 시 refresh로 2FA 없이 토큰 연장. 실패 시 'NEED_LOGIN'.
async function ensureMonitorToken() {
  const auth = await diskGet('monitor:auth');
  if (!auth || !auth.accessToken) throw new Error('NEED_LOGIN');
  if (jwtExpMs(auth.accessToken) - Date.now() > 5 * 60 * 1000) return auth.accessToken;
  if (!auth.refreshToken || auth.managerAccountSerialNo == null) throw new Error('NEED_LOGIN');
  return refreshMonitorTokenOnce();
}

// (분류: classify / shouldReject — classifier.mjs)

// 답변불가(거절) 처리. SPA와 동일하게 PATCH .../status/answer-no-admit.
// "최대한 다시질문 가능" → reQuestionableYn:'Y'. (재질문 플래그 정확한 키는 실제 캡처로 확정 권장)
async function rejectQuestion(token, serial) {
  const payload = {
    qnaQuestionMasterSerialNo: serial,
    answerNoAdmittedReasonCommonCode: REJECT_REASON_CODE,
    answerNoAdmittedReasonDescription: REJECT_REASON_TEXT,
    reQuestionableYn: 'Y',
  };
  return patch(`/v1/qna/${serial}/status/answer-no-admit`, token, payload);
}

// ── 판정 기록 durable 저장 (엑셀 export용 영구 이력) ──
// 콜드부팅에도 살아남도록 Upstash HASH(field=일련번호)로 저장 → 같은 serial 재처리 시 자동 병합.
// 키는 KST 날짜별(monitor:judg:YYYY-MM-DD), 90일 후 자동 만료. export는 날짜범위로 HVALS.
const JUDG_TTL_SEC = 90 * 24 * 3600;
function judgKey(dt) { return `monitor:judg:${dt}`; }
async function appendJudgment(rec) {
  const key = judgKey(kstDateFromTs(rec.ts));
  const r = await upstashCmd('HSET', key, String(rec.serial), JSON.stringify(rec));
  if (r != null) await upstashCmd('EXPIRE', key, JUDG_TTL_SEC);
  return r != null;
}
async function readJudgments(startDt, endDt) {
  const out = [];
  for (let d = dtToDays(startDt); d <= dtToDays(endDt); d++) {
    const vals = await upstashCmd('HVALS', judgKey(daysToDt(d)));
    if (Array.isArray(vals)) for (const v of vals) { try { out.push(JSON.parse(v)); } catch {} }
  }
  out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out;
}

const MONITOR_ACTION_LABEL = { rejected: '실제 거절', would_reject: '거절예정(그림자)', shadow_ai: '그림자(AI)', reject_failed: '거절 실패', none: '통과' };
async function buildMonitorWorkbook(recs) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'qna-report';
  wb.created = new Date();
  const sheet = wb.addWorksheet('검열판정');
  sheet.columns = [
    { header: '일시(KST)', key: 'ts', width: 20 },
    { header: '일련번호', key: 'serial', width: 12 },
    { header: '관', key: 'branch', width: 10 },
    { header: '학생', key: 'student', width: 12 },
    { header: '방식', key: 'division', width: 8 },
    { header: 'TA ID', key: 'taId', width: 12 },
    { header: 'TA 이름', key: 'taName', width: 12 },
    { header: 'AI여부', key: 'ai', width: 8 },
    { header: '질문 본문', key: 'text', width: 70 },
    { header: '이미지수', key: 'imageCount', width: 9 },
    { header: '분류', key: 'label', width: 10 },
    { header: '신뢰도', key: 'confidence', width: 9 },
    { header: '조치', key: 'action', width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of recs) {
    sheet.addRow({
      ts: kstTsString(r.ts),
      serial: r.serial,
      branch: r.branch || '',
      student: r.student || '',
      division: '온라인',
      taId: r.taId || '',
      taName: r.taName || '',
      ai: r.isAI ? 'AI' : '사람',
      text: r.text || '',
      imageCount: r.imageCount || 0,
      label: r.label || '',
      confidence: (r.confidence != null && r.confidence > 0) ? Math.round(r.confidence * 100) + '%' : '',
      action: MONITOR_ACTION_LABEL[r.action] || r.action || '',
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// (extractQuestionText — classifier.mjs)

// 한 번의 폴링 틱: 답변대기(온라인) 신규 질문 분류 → 학습무관 거절/로그.
async function runMonitorTick(trigger) {
  if (monitorRunning) return { skipped: 'running' };
  monitorRunning = true;
  const status = { lastTickAt: Date.now(), trigger, processed: 0, flagged: 0, rejected: 0, ok: false };
  try {
    let token = await ensureMonitorToken();
    // 401 자가복구 래퍼: 공유계정 로그인으로 access 토큰이 무효화되면 get()이 'API 401'을
    // 던진다 → 강제 refresh(단일 in-flight)로 새 토큰 받아 1회 재시도. token은 클로저로 공유돼
    // 이후 호출(상세조회·거절 patch)도 갱신된 토큰을 쓴다.
    const mget = async (path) => {
      try { return await get(path, token); }
      catch (e) {
        if (!/API 401/.test(e.message || '')) throw e;
        token = await refreshMonitorTokenOnce();
        return await get(path, token); // 새 토큰으로 1회 재시도 (여전히 401이면 throw → 다음 틱 재시도)
      }
    };
    const mode = (await diskGet('monitor:mode')) || 'shadow';
    const end = kstTodayDt(); // KST 기준 오늘 (서버 UTC라 todayLocalDt면 자정 직후 누락)
    const start = daysToDt(dtToDays(end) - 1); // 어제~오늘 (밤사이 등록분 포함)
    const qs = `startDt=${start}&endDt=${end}&questionStatusCommonCode=${MONITOR_STATUS_WAIT}&questionDivisionCommonCode=${MONITOR_DIVISION}&searchType=taName`;
    const first = await mget(`/v1/qna/list?page=1&pageSize=${PAGE_SIZE}&${qs}`);
    const total = (first.data && first.data.totalCount) || 0;
    const pages = Math.ceil(total / PAGE_SIZE) || 1;
    const items = [...((first.data && first.data.contents) || [])];
    for (let p = 2; p <= pages; p++) {
      const b = await mget(`/v1/qna/list?page=${p}&pageSize=${PAGE_SIZE}&${qs}`);
      items.push(...((b.data && b.data.contents) || []));
    }
    const seen = new Set((await diskGet('monitor:seen')) || []);
    const fresh = items.filter(it => !seen.has(it.qnaQuestionMasterSerialNo));
    const log = (await diskGet('monitor:log')) || [];
    const stats = (await diskGet('monitor:stats')) || { since: Date.now(), processed: 0, flagged: 0, rejected: 0, byLabel: {} };
    if (!stats.byLabel) stats.byLabel = {};
    await parallelMap(fresh, async (it) => {
      const serial = it.qnaQuestionMasterSerialNo;
      const isAI = AI_TA_IDS.has(it.taId); // aiowl 질문은 글로벌 auto여도 항상 그림자
      status.processed++;
      let label = '정상질문', confidence = 0, reason = '', action = 'none', err = null, classified = false, text = '', imageCount = 0;
      try {
        // 상세 조회해서 전체 questionContent + 첨부 이미지 수 확보 (list 축약/누락 방지)
        let detail = null;
        try { const d = await mget(`/v1/qna/${serial}`); detail = d && d.data; } catch (e) { err = '상세 조회 실패: ' + e.message; }
        text = extractQuestionText(detail) || extractQuestionText(it);
        imageCount = (detail && Array.isArray(detail.questionFiles)) ? detail.questionFiles.length : 0;
        if (err && !text && !imageCount) throw new Error(err); // 본문·첨부 둘 다 못 얻으면 분류 실패로 → 재시도
        const c = await classify(text, imageCount);
        label = c.label; confidence = c.confidence; reason = c.reason; classified = true;
      } catch (e) { err = e.message; reason = '조회/분류 오류'; }
      if (classified && shouldReject({ label, confidence })) {
        status.flagged++;
        // 사람 TA 질문만 실제 거절. aiowl은 auto여도 그림자(shadow_ai)로만 기록.
        if (mode === 'auto' && !isAI) {
          try { await rejectQuestion(token, serial); action = 'rejected'; status.rejected++; }
          catch (e) { action = 'reject_failed'; err = e.message; }
        } else { action = isAI ? 'shadow_ai' : 'would_reject'; }
      }
      if (classified) {
        seen.add(serial); // 분류 실패건은 seen에 안 넣어 다음 틱에 재시도
        stats.processed = (stats.processed || 0) + 1;
        stats.byLabel[label] = (stats.byLabel[label] || 0) + 1;
        if (action !== 'none') stats.flagged = (stats.flagged || 0) + 1;
        if (action === 'rejected') stats.rejected = (stats.rejected || 0) + 1;
      }
      const entry = { serial, branch: it.studentErpBranchCodeName || '', student: it.memberName || '', taId: it.taId || '', taName: it.taName || '', isAI, text: text.slice(0, 300), imageCount, label, confidence, reason, mode, action, err, ts: Date.now() };
      log.unshift(entry);
      if (classified) { try { await appendJudgment(entry); } catch {} } // 엑셀 export용 영구 이력
    }, MONITOR_CLASSIFY_CONCURRENCY);
    await diskSetDurable('monitor:seen', Array.from(seen).slice(-MONITOR_SEEN_CAP));
    await diskSetDurable('monitor:log', log.slice(0, MONITOR_LOG_CAP));
    await diskSetDurable('monitor:stats', stats);
    status.ok = true;
  } catch (e) {
    status.ok = false; status.error = e.message;
  } finally {
    monitorRunning = false;
    diskSet('monitor:status', status);
  }
  return status;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : HTML);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(req.method === 'HEAD' ? undefined : `ok\nupstash=${UPSTASH_ENABLED ? 'on' : 'off'}`);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/cache-ping') {
    if (!UPSTASH_ENABLED) { json(res, 200, { upstash: 'off' }); return; }
    try {
      const testKey = 'cacheping-' + Date.now();
      upstashSet(testKey, { ts: Date.now() });
      // 짧은 딜레이 후 read-back
      await new Promise(r => setTimeout(r, 200));
      const back = await upstashGet(testKey);
      json(res, 200, { upstash: 'on', writeReadOk: back != null, value: back });
    } catch (e) { json(res, 500, { upstash: 'on', error: e.message }); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const { accountId, accountPassword } = JSON.parse(await readBody(req));
    json(res, 200, await post('/v1/manager/auth', { accountId, accountPassword, certNo: null }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/verify') {
    const { accountId, accountPassword, certNo, asMonitor } = JSON.parse(await readBody(req));
    const result = await post('/v1/manager/auth/token', { accountId, accountPassword, certNo });
    if (result.code === 'R20000' && result.data) {
      // 전용 감시기 계정이 없으므로(모니터도 forestta 공유) 사이트 로그인마다 감시기 토큰을 재시드한다.
      // forestta로 새로 로그인하면 서버가 계정의 refresh 패밀리를 리셋 → 감시기의 기존 refreshToken이
      // R40110으로 죽는데, 바로 이 로그인의 신선한 토큰으로 덮어써야 감시기가 계속 산다. (사람이 리포트를
      // 볼 때마다 감시기 재시드 → 전용계정 없이 상시가동 유지. asMonitor 분리(135f9b6)는 전용계정 전제라
      // 지금은 오히려 해가 됨: 로그인이 감시기 토큰을 죽이기만 하고 재시드 안 함 → NEED_LOGIN.)
      await saveMonitorAuth(result.data);
      json(res, 200, { ok: true, accessToken: result.data.accessToken, monitorSet: true });
    } else {
      json(res, 200, { ok: false, message: result.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/report') {
    const token = url.searchParams.get('token'), start = url.searchParams.get('start'), end = url.searchParams.get('end');
    if (!token || !start || !end) { json(res, 400, { error: 'token, start, end 필요' }); return; }
    try { json(res, 200, await cached(`report:${start}:${end}`, () => fetchReport(token, start, end))); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/schedule') {
    const token = url.searchParams.get('token');
    const year = parseInt(url.searchParams.get('year'));
    const month = parseInt(url.searchParams.get('month'));
    const branch = url.searchParams.get('branch');
    if (!token || !year || !month || !branch) { json(res, 400, { error: 'token, year, month, branch 필요' }); return; }
    try { json(res, 200, await cached(`schedule:${year}:${month}:${branch}`, () => fetchSchedule(token, year, month, branch))); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/salary') {
    const token = url.searchParams.get('token');
    const year = parseInt(url.searchParams.get('year'));
    const month = parseInt(url.searchParams.get('month'));
    if (!token || !year || !month) { json(res, 400, { error: 'token, year, month 필요' }); return; }
    try { json(res, 200, await cached(`salary:v2:${year}:${month}`, () => fetchSalaryAll(token, year, month))); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/performance') {
    const token = url.searchParams.get('token'), start = url.searchParams.get('start'), end = url.searchParams.get('end');
    if (!token || !start || !end) { json(res, 400, { error: 'token, start, end 필요' }); return; }
    try { json(res, 200, await cached(`performance:${start}:${end}`, () => fetchPerformance(token, start, end))); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/rating-comparison') {
    const token = url.searchParams.get('token');
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!token || !start || !end) { json(res, 400, { error: 'token, start, end 필요' }); return; }
    try { json(res, 200, await cached(`rating-cmp:${start}:${end}`, () => fetchRatingComparison(token, start, end))); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/video-reuse') {
    const token = url.searchParams.get('token'), start = url.searchParams.get('start'), end = url.searchParams.get('end');
    const fresh = url.searchParams.get('fresh') === '1';
    if (!token || !start || !end) { json(res, 400, { error: 'token, start, end 필요' }); return; }
    try {
      const today = todayLocalDt();
      const resultKey = `vidreuse-result-${start}-${end}`;
      const includesTodayOrFuture = end >= today;
      // 결과 캐시: 과거 완료 기간 영구, 오늘 포함 기간 1시간 stale 허용. fresh=1 이면 무시.
      if (!fresh) {
        const hit = await diskGet(resultKey);
        if (hit) {
          if (hit && typeof hit.savedAt === 'number' && hit.data && hit.data.taList) {
            const age = Date.now() - hit.savedAt;
            if (!includesTodayOrFuture || age < VIDREUSE_RESULT_TODAY_TTL_MS) {
              json(res, 200, { ...hit.data, _cached: 'server', _cacheSavedAt: hit.savedAt, _cacheAgeMs: age });
              return;
            }
          } else if (hit && hit.taList) {
            // 옛 포맷 (과거에만 저장됐었음): savedAt 없음. 과거 기간이면 영구 hit.
            if (!includesTodayOrFuture) {
              json(res, 200, { ...hit, _cached: 'server', _cacheSavedAt: null, _cacheAgeMs: null });
              return;
            }
          }
        }
      }
      const data = await cached(`vidreuse:${start}:${end}`, () => fetchVideoReuse(token, start, end));
      diskSet(resultKey, { savedAt: Date.now(), data });
      json(res, 200, data);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ai-status') {
    const token = url.searchParams.get('token');
    const startMonth = url.searchParams.get('start');
    const endMonth = url.searchParams.get('end');
    const days = parseInt(url.searchParams.get('days'));
    if (!token || !startMonth || !endMonth || !days || days < 1) { json(res, 400, { error: 'token, start, end, days 필요' }); return; }
    try { json(res, 200, await cached(`aistatus-v3:${startMonth}:${endMonth}:${days}`, () => fetchAiStatus(token, startMonth, endMonth, days))); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/voucher-export') {
    const token = url.searchParams.get('token');
    const monthStart = url.searchParams.get('monthStart');
    const monthEnd = url.searchParams.get('monthEnd');
    const idStart = parseInt(url.searchParams.get('idStart'));
    const idEnd = parseInt(url.searchParams.get('idEnd'));
    if (!token || !monthStart || !monthEnd || !Number.isFinite(idStart) || !Number.isFinite(idEnd) || idStart > idEnd) {
      json(res, 400, { error: 'token, monthStart, monthEnd, idStart, idEnd 필수 (idStart <= idEnd)' });
      return;
    }
    try {
      const buf = await cached(
        `voucher:v2:${monthStart}:${monthEnd}:${idStart}:${idEnd}`,
        () => exportVouchers(token, monthStart, monthEnd, idStart, idEnd),
      );
      const filename = `voucher-${monthStart}_${monthEnd}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': buf.length,
      });
      res.end(buf);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ── 학습무관 자동 검열 감시기 ──
  // 폴링 트리거: 외부 cron(secret) 또는 로그인된 UI(token)에서 호출
  if (req.method === 'POST' && url.pathname === '/api/monitor/tick') {
    const secret = url.searchParams.get('secret');
    const token = url.searchParams.get('token');
    const okSecret = MONITOR_SECRET && secret === MONITOR_SECRET;
    if (!okSecret && !token) { json(res, 403, { error: 'secret 또는 token 필요' }); return; }
    try { json(res, 200, await runMonitorTick(okSecret ? 'cron' : 'manual')); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // 임시 진단(인증 불필요, 자격증명 노출 없음): 토큰 만료시각·serial 설정 여부·refresh 실패 사유. 원인 파악 후 제거.
  if (req.method === 'GET' && url.pathname === '/api/monitor/diag') {
    const auth = await diskGet('monitor:auth');
    const expMs = (auth && auth.accessToken) ? jwtExpMs(auth.accessToken) : 0;
    json(res, 200, {
      hasAuth: !!(auth && auth.accessToken),
      managerSerialSet: !!(auth && auth.managerAccountSerialNo != null),
      hasRefreshToken: !!(auth && auth.refreshToken),
      authExpMs: expMs,
      authExpInMin: expMs ? Math.round((expMs - Date.now()) / 60000) : null,
      authSavedAt: (auth && auth.savedAt) || null,
      authAgeMin: (auth && auth.savedAt) ? Math.round((Date.now() - auth.savedAt) / 60000) : null,
      lastRefreshErr,
      status: (await diskGet('monitor:status')) || null,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/monitor/log') {
    const token = url.searchParams.get('token');
    const okSecret = MONITOR_SECRET && url.searchParams.get('secret') === MONITOR_SECRET;
    if (!token && !okSecret) { json(res, 401, { error: 'token 필요' }); return; }
    const auth = await diskGet('monitor:auth');
    json(res, 200, {
      log: (await diskGet('monitor:log')) || [],
      mode: (await diskGet('monitor:mode')) || 'shadow',
      status: (await diskGet('monitor:status')) || null,
      stats: (await diskGet('monitor:stats')) || null,
      hasAuth: !!(auth && auth.accessToken),
      apiKey: !!ANTHROPIC_API_KEY,
      threshold: MONITOR_CONFIDENCE_THRESHOLD,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/monitor/mode') {
    const body = JSON.parse(await readBody(req));
    if (!body.token) { json(res, 401, { error: 'token 필요' }); return; }
    const mode = body.mode === 'auto' ? 'auto' : 'shadow';
    diskSet('monitor:mode', mode);
    json(res, 200, { ok: true, mode });
    return;
  }

  // 검사 기록 초기화 → 현재 답변대기 백로그를 다음 틱에 다시 분류 (검증용)
  if (req.method === 'POST' && url.pathname === '/api/monitor/reset') {
    const body = JSON.parse(await readBody(req));
    if (!body.token) { json(res, 401, { error: 'token 필요' }); return; }
    diskSet('monitor:seen', []);
    diskSet('monitor:log', []);
    diskSet('monitor:stats', { since: Date.now(), processed: 0, flagged: 0, rejected: 0, byLabel: {} });
    json(res, 200, { ok: true });
    return;
  }

  // 골든셋 회귀 백테스트: [{serial, gold_label}] 받아 서버 토큰으로 detail 재조회(questionFiles 실측)
  // → 현행 분류 로직 적용 → 오거절률 산출. 프롬프트 수정 시 회귀 검증용. secret gate.
  if (req.method === 'POST' && url.pathname === '/api/monitor/backtest') {
    const okSecret = MONITOR_SECRET && url.searchParams.get('secret') === MONITOR_SECRET;
    if (!okSecret) { json(res, 403, { error: 'secret 필요' }); return; }
    let cases;
    try { cases = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'JSON 배열 필요' }); return; }
    if (!Array.isArray(cases) || !cases.length) { json(res, 400, { error: '[{serial, gold_label}] 배열 필요' }); return; }
    try {
      const token = await ensureMonitorToken();
      const results = await parallelMap(cases, async (cs) => {
        let detail = null, text = cs.text || '', imageCount = 0;
        try { const d = await get(`/v1/qna/${cs.serial}`, token); detail = d && d.data; } catch {}
        if (detail) { text = extractQuestionText(detail) || text; imageCount = Array.isArray(detail.questionFiles) ? detail.questionFiles.length : 0; }
        const c = await classify(text, imageCount);
        const wouldReject = shouldReject(c);
        return { serial: cs.serial, gold: cs.gold_label || null, predicted: c.label, conf: c.confidence, imageCount, textLen: text.length, viaLLM: c.viaLLM, wouldReject };
      }, MONITOR_CLASSIFY_CONCURRENCY);
      const withGold = results.filter(r => r.gold);
      const correctReject = withGold.filter(r => r.wouldReject && r.gold === '학습무관');
      const overReject = withGold.filter(r => r.wouldReject && r.gold !== '학습무관');
      const missed = withGold.filter(r => !r.wouldReject && r.gold === '학습무관');
      const denom = correctReject.length + overReject.length;
      json(res, 200, {
        n: results.length, graded: withGold.length,
        wouldRejectTotal: results.filter(r => r.wouldReject).length,
        correctReject: correctReject.length, overReject: overReject.length, missed: missed.length,
        precision: denom ? +(correctReject.length / denom).toFixed(3) : null,
        overRejectCases: overReject.map(r => ({ serial: r.serial, gold: r.gold, conf: r.conf, imageCount: r.imageCount, textLen: r.textLen })),
        missedCases: missed.map(r => ({ serial: r.serial, conf: r.conf, imageCount: r.imageCount })),
        results,
      });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // 검열 판정 엑셀 내보내기 (영구 이력 monitor:judg에서 날짜범위 조회). token gate (학생 데이터 포함).
  if (req.method === 'GET' && url.pathname === '/api/monitor/export') {
    const token = url.searchParams.get('token');
    if (!token) { json(res, 401, { error: 'token 필요' }); return; }
    const start = url.searchParams.get('start'), end = url.searchParams.get('end');
    if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
      json(res, 400, { error: 'start, end (YYYY-MM-DD, start<=end) 필요' }); return;
    }
    try {
      const recs = await readJudgments(start, end);
      const buf = await buildMonitorWorkbook(recs);
      const filename = `검열판정_${start}_${end}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Content-Length': buf.length,
      });
      res.end(buf);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // 거절 payload 통제 검증: 단건만 실제 거절 후 전후 상태 비교 (auto 전환 전 1회용). secret gate.
  if (req.method === 'POST' && url.pathname === '/api/monitor/verify-reject') {
    const okSecret = MONITOR_SECRET && url.searchParams.get('secret') === MONITOR_SECRET;
    if (!okSecret) { json(res, 403, { error: 'secret 필요' }); return; }
    const serial = parseInt(url.searchParams.get('serial'), 10);
    if (!Number.isFinite(serial)) { json(res, 400, { error: 'serial 필요' }); return; }
    try {
      const token = await ensureMonitorToken();
      const snap = async () => {
        try {
          const d = await get(`/v1/qna/${serial}`, token); const x = d && d.data;
          return x ? { status: x.questionStatusCommonCode, statusName: x.questionStatusCommonCodeName, reasonCode: x.answerNoAdmittedReasonCommonCode, reasonName: x.answerNoAdmittedReasonCommonCodeName, reQuestionableYn: x.reQuestionableYn, taId: x.taId } : null;
        } catch (e) { return { error: e.message }; }
      };
      const before = await snap();
      let patchResult = null, patchError = null;
      try { patchResult = await rejectQuestion(token, serial); } catch (e) { patchError = e.message; }
      const after = await snap();
      json(res, 200, { serial, before, after, patchError, payloadSent: { answerNoAdmittedReasonCommonCode: REJECT_REASON_CODE, answerNoAdmittedReasonDescription: REJECT_REASON_TEXT, reQuestionableYn: 'Y' }, patchResult });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ── HTML ──

const HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TA 관리 도구</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; min-height: 100vh; }

  /* 로그인 */
  .login-wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .login-box { width: 380px; background: #fff; border-radius: 16px; padding: 36px 32px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .login-box h1 { font-size: 20px; text-align: center; margin-bottom: 24px; }
  .login-box .field { margin-bottom: 16px; }
  .login-box label { display: block; font-size: 13px; color: #666; margin-bottom: 6px; }
  .login-box input { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; outline: none; }
  .login-box input:focus { border-color: #333; }
  .login-box button { width: 100%; padding: 12px; background: #333; color: #fff; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 8px; }
  .login-box button:hover { background: #555; }
  .login-box button:disabled { background: #ccc; }
  .login-box .error { color: #e53e3e; font-size: 13px; margin-top: 8px; text-align: center; }
  .login-box .info { color: #888; font-size: 12px; margin-top: 12px; text-align: center; }

  /* 탭 네비게이션 */
  .app { display: none; }
  .app.active { display: block; }
  .tabs { display: flex; background: #fff; border-bottom: 2px solid #eee; padding: 0 24px; }
  .tab { padding: 14px 24px; font-size: 14px; font-weight: 600; color: #888; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; }
  .tab:hover { color: #333; }
  .tab.active { color: #333; border-bottom-color: #333; }
  .page { display: none; padding: 24px; max-width: 1100px; margin: 0 auto; }
  .page.active { display: block; }

  /* 공통 */
  .ctrl { display: flex; gap: 8px; align-items: center; margin-bottom: 20px; flex-wrap: wrap; background: #fff; padding: 16px 20px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .ctrl select, .ctrl input[type=date] { padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
  .btn { padding: 8px 20px; background: #333; color: #fff; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
  .btn:hover { background: #555; }
  .btn:disabled { background: #ccc; }
  .btn.ex { background: #2b6cb0; }
  .btn.ex:hover { background: #2c5282; }
  .cards { display: flex; gap: 16px; margin-bottom: 20px; }
  .card { flex: 1; background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card .lb { font-size: 13px; color: #888; margin-bottom: 4px; }
  .card .vl { font-size: 28px; font-weight: 700; }
  .card .vl.hl { color: #e53e3e; }
  .card .sm { font-size: 12px; color: #aaa; margin-top: 4px; }
  .section { margin-bottom: 20px; background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .section h2 { font-size: 14px; font-weight: 600; color: #666; margin-bottom: 12px; }
  .rb { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 13px; }
  .rb .rn { min-width: 200px; }
  .rb .bar { height: 18px; border-radius: 4px; min-width: 4px; }
  .rb .rc { min-width: 40px; text-align: right; color: #888; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  th { background: #fafafa; text-align: left; padding: 12px 16px; font-size: 13px; color: #666; font-weight: 600; border-bottom: 1px solid #eee; }
  td { padding: 10px 16px; font-size: 14px; border-bottom: 1px solid #f0f0f0; }
  td.r { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: #fafafa; }
  .loading { text-align: center; padding: 60px; color: #aaa; }

  /* 달력 */
  .cal-nav { display: flex; align-items: center; gap: 16px; }
  .cal-nav button { background: none; border: 1px solid #ddd; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 16px; }
  .cal-nav button:hover { background: #f0f0f0; }
  .cal-nav .month-label { font-size: 18px; font-weight: 700; min-width: 140px; text-align: center; }
  .calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-top: 16px; }
  .cal-hdr { text-align: center; font-size: 12px; font-weight: 600; color: #888; padding: 8px 0; }
  .cal-hdr:nth-child(6) { color: #2b6cb0; }
  .cal-hdr:nth-child(7) { color: #e53e3e; }
  .cal-cell { background: #fff; border-radius: 8px; padding: 8px; min-height: 80px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
  .cal-cell.empty { background: transparent; box-shadow: none; }
  .cal-cell.today { outline: 2px solid #333; }
  .cal-cell.sat { background: #eff6ff; }
  .cal-cell.sun { background: #fef2f2; }
  .cal-day { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  .cal-cell.sat .cal-day { color: #2b6cb0; }
  .cal-cell.sun .cal-day { color: #e53e3e; }
  .cal-slot { display: flex; justify-content: space-between; align-items: center; font-size: 11px; padding: 2px 4px; border-radius: 4px; margin-top: 2px; }
  .cal-slot .sl { color: #888; font-weight: 500; }
  .cal-slot .sc { font-weight: 700; font-variant-numeric: tabular-nums; }
  .cal-slot.c0 { background: #f5f5f5; color: #bbb; }
  .cal-slot.c0 .sc { color: #ccc; }
  .cal-slot.c1 { background: #fefce8; }
  .cal-slot.c1 .sc { color: #a16207; }
  .cal-slot.c2 { background: #ecfdf5; }
  .cal-slot.c2 .sc { color: #047857; }
  .cal-slot.c3 { background: #d1fae5; }
  .cal-slot.c3 .sc { color: #065f46; }

  @media (max-width: 700px) {
    .cards { flex-direction: column; }
    .cal-cell { min-height: 60px; padding: 4px; }
    .cal-slot { font-size: 10px; }
  }
</style>
</head>
<body>

<!-- 로그인 -->
<div class="login-wrap" id="loginView">
  <div class="login-box">
    <h1>TA 관리 도구</h1>
    <div id="step1">
      <div class="field"><label>아이디</label><input id="uid" placeholder="관리자 아이디"></div>
      <div class="field"><label>비밀번호</label><input id="upw" type="password" placeholder="비밀번호"></div>
      <button id="loginBtn" onclick="doLogin()">로그인</button>
      <div class="error" id="loginErr"></div>
    </div>
    <div id="step2" style="display:none">
      <div class="info" style="margin-bottom:12px">인증번호가 발송되었습니다.</div>
      <div class="field"><label>2차 인증번호</label><input id="code" placeholder="인증번호 입력" maxlength="6"></div>
      <button id="verifyBtn" onclick="doVerify()">확인</button>
      <div class="error" id="verifyErr"></div>
    </div>
  </div>
</div>

<!-- 앱 -->
<div class="app" id="appView">
  <div class="tabs">
    <div class="tab active" onclick="switchTab('report')">답변 시간 초과</div>
    <div class="tab" onclick="switchTab('schedule')">TA Meet 스케줄표</div>
    <div class="tab" onclick="switchTab('perf')">TA 성과</div>
    <div class="tab" onclick="switchTab('ai')">AI 현황 보고</div>
    <div class="tab" onclick="switchTab('rating')">별점 비교</div>
    <div class="tab" onclick="switchTab('voucher')">바우처 내역 확인</div>
    <div class="tab" onclick="switchTab('vidreuse')">동영상 재활용</div>
    <div class="tab" onclick="switchTab('monitor')">질문 검열 감시</div>
  </div>

  <!-- 답변불가 리포트 -->
  <div class="page active" id="page-report">
    <div class="ctrl">
      <input type="date" id="startDt"> <span>~</span> <input type="date" id="endDt">
      <button class="btn" id="goBtn" onclick="doReport()">조회</button>
      <button class="btn ex" id="exBtn" style="display:none" onclick="doExport()">HTML 내보내기</button>
      <button class="btn ex" id="exCsvBtn" style="display:none" onclick="exportReportCsv()">엑셀 내보내기</button>
    </div>
    <div id="reportResult"></div>
  </div>

  <!-- TA Meet 스케줄 -->
  <div class="page" id="page-schedule">
    <div class="ctrl">
      <select id="branchSel">${BRANCHES.map(b => '<option value="' + b.code + '">' + b.name + '</option>').join('')}</select>
      <div class="cal-nav">
        <button onclick="moveMonth(-1)">&lt;</button>
        <span class="month-label" id="monthLabel"></span>
        <button onclick="moveMonth(1)">&gt;</button>
      </div>
      <button class="btn" id="schBtn" onclick="doSchedule()">조회</button>
    </div>
    <div id="salaryResult"></div>
    <div id="scheduleResult"></div>
  </div>

  <!-- TA 성과 -->
  <div class="page" id="page-perf">
    <div class="ctrl">
      <input type="date" id="perfStart"> <span>~</span> <input type="date" id="perfEnd">
      <button class="btn" id="perfBtn" onclick="doPerf()">조회</button>
      <button class="btn ex" id="perfCsvBtn" style="display:none" onclick="exportPerfCsv()">엑셀 내보내기</button>
    </div>
    <div id="perfResult"></div>
  </div>

  <!-- AI 현황 보고 -->
  <div class="page" id="page-ai">
    <div class="ctrl">
      <select id="aiMonthA"></select> <span>월부터</span>
      <select id="aiMonthB"></select> <span>월까지</span>
      <input type="number" id="aiDays" min="1" max="365" value="7" style="width:60px"> <span>일 간격</span>
      <button class="btn" id="aiBtn" onclick="doAiStatus()">조회</button>
      <span style="margin-left:12px;color:#888;font-size:12px">표시:</span>
      <label style="font-size:13px;color:#444;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="aiShowMoney" checked onchange="redrawAiChart()"> 금액</label>
      <label style="font-size:13px;color:#444;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="aiShowDelta" checked onchange="redrawAiChart()"> 증감률</label>
    </div>
    <div class="section" style="padding:24px">
      <h2 id="aiChartTitle" style="font-size:18px;font-weight:700;color:#333;text-align:center;margin-bottom:8px"></h2>
      <canvas id="aiChart" height="120"></canvas>
      <h2 id="aiDailyChartTitle" style="font-size:16px;font-weight:600;color:#333;text-align:center;margin-top:24px;margin-bottom:12px"></h2>
      <canvas id="aiDailyRatioChart" height="80"></canvas>
    </div>
  </div>

  <!-- 별점 비교 -->
  <div class="page" id="page-rating">
    <div class="ctrl">
      <input type="date" id="ratingStart"> <span>~</span> <input type="date" id="ratingEnd">
      <button class="btn" id="ratingBtn" onclick="doRating()">조회</button>
      <span style="color:#888;font-size:12px;margin-left:8px">25년 동일 MM-DD 자동 비교 · 26년 미래 일자는 today로 클램프</span>
    </div>
    <div id="ratingResult"></div>
  </div>

  <!-- 바우처 내역 확인 -->
  <div class="page" id="page-voucher">
    <div class="ctrl">
      <select id="vMonthStart"></select><span>월부터</span>
      <select id="vMonthEnd"></select><span>월까지</span>
      <span style="margin-left:12px">학생번호</span>
      <input type="number" id="vIdStart" value="6500" style="width:90px">
      <span>~</span>
      <input type="number" id="vIdEnd" value="11364" style="width:90px">
      <button class="btn" id="vBtn" onclick="doVoucherDownload()">엑셀 다운로드</button>
    </div>
    <div id="voucherStatus"></div>
  </div>

  <!-- 동영상 재활용 -->
  <div class="page" id="page-vidreuse">
    <div class="ctrl">
      <input type="date" id="vrStartDt"> <span>~</span> <input type="date" id="vrEndDt">
      <button class="btn" id="vrBtn" onclick="doVideoReuse()">조회</button>
      <button class="btn ex" id="vrCsvBtn" style="display:none" onclick="exportVideoReuseCsv()">엑셀 내보내기</button>
      <span style="color:#888;font-size:12px;margin-left:8px">첫 조회는 기간에 비례해서 오래 걸려요 · 같은 조건 재조회는 캐시로 즉시 표시</span>
    </div>
    <div id="vrResult"></div>
  </div>

  <!-- 질문 검열 감시 -->
  <div class="page" id="page-monitor">
    <div class="ctrl">
      <span style="font-size:13px;color:#666">현재 모드:</span>
      <span id="monMode" style="font-weight:700">-</span>
      <button class="btn" onclick="setMonMode('shadow')">그림자 모드</button>
      <button class="btn" style="background:#c53030" onclick="setMonMode('auto')">자동 거절 켜기</button>
      <button class="btn ex" onclick="loadMonitor()">새로고침</button>
      <button class="btn" onclick="runMonTick()">지금 1회 검사</button>
      <button class="btn" onclick="resetMonitor()">기록 초기화(재검사)</button>
      <label style="font-size:13px;color:#444;display:flex;align-items:center;gap:4px;cursor:pointer;margin-left:8px"><input type="checkbox" id="monAuto" checked> 30초 자동갱신</label>
    </div>
    <div class="ctrl">
      <span style="font-size:13px;color:#666">엑셀 내보내기:</span>
      <input type="date" id="monExStart" style="padding:6px;border:1px solid #ddd;border-radius:6px">
      <span style="color:#888">~</span>
      <input type="date" id="monExEnd" style="padding:6px;border:1px solid #ddd;border-radius:6px">
      <button class="btn" onclick="exportMonitor()">⬇ 엑셀 내보내기</button>
      <span style="font-size:12px;color:#aaa">검열 판정 전체 이력 (최대 90일 보관)</span>
    </div>
    <div id="monStatus" style="margin-bottom:12px;color:#666;font-size:13px"></div>
    <div id="monResult"></div>
  </div>
</div>

<script>
let TOKEN = null, savedId = '', savedPw = '';
let schYear, schMonth;
let lastReportData = null;

// ── 로그인 ──

async function doLogin() {
  const id = document.getElementById('uid').value.trim(), pw = document.getElementById('upw').value;
  if (!id || !pw) return;
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = '로그인 중...';
  document.getElementById('loginErr').textContent = '';
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: id, accountPassword: pw }) });
    const data = await res.json();
    if (data.code === 'R20000') {
      savedId = id; savedPw = pw;
      document.getElementById('step1').style.display = 'none';
      document.getElementById('step2').style.display = 'block';
      document.getElementById('code').focus();
    } else {
      document.getElementById('loginErr').textContent = data.message || '로그인 실패';
    }
  } catch (e) { document.getElementById('loginErr').textContent = '서버 오류: ' + e.message; }
  btn.disabled = false; btn.textContent = '로그인';
}

async function doVerify() {
  const code = document.getElementById('code').value.trim();
  if (!code) return;
  const btn = document.getElementById('verifyBtn');
  btn.disabled = true; btn.textContent = '확인 중...';
  document.getElementById('verifyErr').textContent = '';
  try {
    const res = await fetch('/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: savedId, accountPassword: savedPw, certNo: code }) });
    const data = await res.json();
    if (data.ok && data.accessToken) {
      TOKEN = data.accessToken;
      initApp();
    } else {
      document.getElementById('verifyErr').textContent = data.message || '인증 실패';
    }
  } catch (e) { document.getElementById('verifyErr').textContent = '서버 오류: ' + e.message; }
  btn.disabled = false; btn.textContent = '확인';
}

function initApp() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('appView').classList.add('active');
  const now = new Date();
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('startDt').value = ym + '-01';
  document.getElementById('endDt').value = now.toISOString().slice(0, 10);
  document.getElementById('perfStart').value = ym + '-01';
  document.getElementById('perfEnd').value = now.toISOString().slice(0, 10);
  document.getElementById('vrStartDt').value = ym + '-01';
  document.getElementById('vrEndDt').value = now.toISOString().slice(0, 10);
  document.getElementById('ratingStart').value = ym + '-01';
  document.getElementById('ratingEnd').value = now.toISOString().slice(0, 10);
  schYear = now.getFullYear();
  schMonth = now.getMonth() + 1;
  updateMonthLabel();
  initAiSelects();
  initVoucherSelects();
}

// ── 탭 ──

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelector('.tab[onclick*="' + name + '"]').classList.add('active');
  document.getElementById('page-' + name).classList.add('active');
  if (name === 'monitor') loadMonitor();
}

// ── 질문 검열 감시 ──

async function loadMonitor() {
  initMonExportDates();
  if (!TOKEN) return;
  try {
    const res = await fetch('/api/monitor/log?token=' + encodeURIComponent(TOKEN));
    if (!res.ok) throw new Error(await res.text());
    renderMonitor(await res.json());
  } catch (e) {
    document.getElementById('monResult').innerHTML = '<div style="color:#e53e3e;padding:20px">오류: ' + esc(e.message) + '</div>';
  }
}

function renderMonitor(d) {
  const ml = document.getElementById('monMode');
  ml.textContent = d.mode === 'auto' ? '자동 거절 ON (사람 TA만 실거절 · aiowl은 그림자)' : '그림자 (거절 안 함, 기록만)';
  ml.style.color = d.mode === 'auto' ? '#c53030' : '#2b6cb0';
  let warn = '';
  if (!d.hasAuth) warn += '<div style="color:#c53030">⚠ 감시용 인증 없음 — 이 사이트에서 로그인하면 자동 저장됩니다.</div>';
  if (!d.apiKey) warn += '<div style="color:#c53030">⚠ ANTHROPIC_API_KEY 미설정 — 분류 불가. Render 환경변수에 추가하세요.</div>';
  const st = d.status;
  let stx = '';
  if (st) {
    stx = '마지막 검사: ' + new Date(st.lastTickAt).toLocaleString('ko-KR') +
      ' · 처리 ' + (st.processed || 0) + ' · 학습무관 검출 ' + (st.flagged || 0) + ' · 거절 ' + (st.rejected || 0) +
      (st.ok === false ? (' · <span style="color:#c53030">오류: ' + esc(st.error || '') + (st.error === 'NEED_LOGIN' ? ' (재로그인 필요)' : '') + '</span>') : '');
  }
  document.getElementById('monStatus').innerHTML = warn + stx;
  const cs = d.stats;
  let sum = '';
  if (cs) {
    const bl = cs.byLabel || {};
    const hrs = cs.since ? ((Date.now() - cs.since) / 3600000).toFixed(1) : '0';
    sum = '<div class="cards" style="margin-bottom:16px">' +
      '<div class="card"><div class="lb">누적 처리</div><div class="vl">' + (cs.processed || 0) + '건</div><div class="sm">시작 ' + (cs.since ? new Date(cs.since).toLocaleString('ko-KR') : '-') + ' (' + hrs + '시간)</div></div>' +
      '<div class="card"><div class="lb">학습무관 검출</div><div class="vl hl">' + (cs.flagged || 0) + '건</div><div class="sm">' + (d.mode === 'auto' ? ('실제 거절 ' + (cs.rejected || 0)) : '그림자(거절 예정)') + '</div></div>' +
      '<div class="card"><div class="lb">분류 분포</div><div class="vl" style="font-size:15px;line-height:1.6">정상 ' + (bl['정상질문'] || 0) + ' · 상담 ' + (bl['학습상담'] || 0) + ' · <span style="color:#c53030">무관 ' + (bl['학습무관'] || 0) + '</span></div></div>' +
      '</div>';
  }
  const rows = (d.log || []).map(function (l) {
    const color = l.label === '학습무관' ? '#c53030' : (l.label === '학습상담' ? '#2b6cb0' : '#718096');
    let act = '-';
    if (l.action === 'rejected') act = '<span style="color:#c53030;font-weight:700">거절됨</span>';
    else if (l.action === 'shadow_ai') act = '<span style="color:#3182ce;font-weight:600">그림자(AI)</span>';
    else if (l.action === 'would_reject') act = '<span style="color:#dd6b20;font-weight:600">거절 예정(그림자)</span>';
    else if (l.action === 'reject_failed') act = '<span style="color:#c53030">거절 실패</span>';
    const conf = (l.confidence != null && l.confidence > 0) ? (l.confidence * 100).toFixed(0) + '%' : '';
    return '<tr><td style="white-space:nowrap">' + new Date(l.ts).toLocaleTimeString('ko-KR') +
      '</td><td>' + l.serial + '</td><td>' + esc(l.taId || '') + (l.isAI ? ' <span style="font-size:10px;background:#3182ce;color:#fff;padding:1px 4px;border-radius:3px">AI</span>' : '') +
      '</td><td style="max-width:460px">' + esc(l.text || '') +
      '</td><td style="color:' + color + ';font-weight:600;white-space:nowrap">' + esc(l.label || '') +
      '</td><td>' + conf + '</td><td style="white-space:nowrap">' + act +
      (l.err ? '<div style="color:#c53030;font-size:11px">' + esc(l.err) + '</div>' : '') + '</td></tr>';
  }).join('');
  document.getElementById('monResult').innerHTML = sum +
    '<table><thead><tr><th>시각</th><th>일련번호</th><th>TA ID</th><th>질문</th><th>판정</th><th>신뢰</th><th>처리</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="7" style="color:#888;padding:20px">아직 검열 기록이 없습니다.</td></tr>') + '</tbody></table>';
}

async function setMonMode(m) {
  if (m === 'auto' && !confirm('자동 거절을 켭니다. 사람 TA에게 간 학습무관 질문이 실제로 답변불가 처리됩니다(aiowl 질문은 그림자 유지). 계속할까요?')) return;
  try {
    await fetch('/api/monitor/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN, mode: m }) });
  } catch (e) {}
  loadMonitor();
}

async function runMonTick() {
  document.getElementById('monStatus').textContent = '검사 중...';
  try { await fetch('/api/monitor/tick?token=' + encodeURIComponent(TOKEN), { method: 'POST' }); } catch (e) {}
  loadMonitor();
}

async function resetMonitor() {
  if (!confirm('검사 기록(seen/로그)을 초기화합니다. 현재 답변대기 질문들이 다음 검사 때 다시 분류됩니다. 계속할까요?')) return;
  try { await fetch('/api/monitor/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) }); } catch (e) {}
  document.getElementById('monStatus').textContent = '초기화됨 — "지금 1회 검사"로 다시 분류하세요.';
  loadMonitor();
}

// ── 엑셀 내보내기 (검열 판정 영구 이력) ──
function monYmd(d) { const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
function initMonExportDates() {
  const s = document.getElementById('monExStart'), e = document.getElementById('monExEnd');
  if (s && !s.value) { const d = new Date(); d.setDate(d.getDate() - 6); s.value = monYmd(d); }
  if (e && !e.value) e.value = monYmd(new Date());
}
async function exportMonitor() {
  if (!TOKEN) return;
  const s = document.getElementById('monExStart').value, e = document.getElementById('monExEnd').value;
  if (!s || !e) { alert('시작/종료 날짜를 선택하세요'); return; }
  try {
    const res = await fetch('/api/monitor/export?token=' + encodeURIComponent(TOKEN) + '&start=' + s + '&end=' + e);
    if (!res.ok) { alert('내보내기 실패: ' + (await res.text())); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '검열판정_' + s + '_' + e + '.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  } catch (err) { alert('내보내기 오류: ' + err.message); }
}

setInterval(function () {
  const p = document.getElementById('page-monitor');
  const c = document.getElementById('monAuto');
  if (p && p.classList.contains('active') && c && c.checked && TOKEN) loadMonitor();
}, 30000);

// ── 답변불가 리포트 ──

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function doReport() {
  const s = document.getElementById('startDt').value, e = document.getElementById('endDt').value;
  if (!s || !e || !TOKEN) return;
  const btn = document.getElementById('goBtn');
  btn.disabled = true; btn.textContent = '조회 중...';
  document.getElementById('exBtn').style.display = 'none';
  document.getElementById('exCsvBtn').style.display = 'none';
  document.getElementById('reportResult').innerHTML = '<div class="loading">데이터 조회 중... (상세 사유 확인으로 시간이 걸릴 수 있습니다)</div>';
  try {
    const res = await fetch('/api/report?token=' + encodeURIComponent(TOKEN) + '&start=' + s + '&end=' + e);
    if (!res.ok) throw new Error(await res.text());
    lastReportData = await res.json();
    renderReport(lastReportData);
    document.getElementById('exBtn').style.display = '';
    document.getElementById('exCsvBtn').style.display = '';
  } catch (err) {
    document.getElementById('reportResult').innerHTML = '<div style="color:#e53e3e;padding:20px">오류: ' + esc(err.message) + '</div>';
  }
  btn.disabled = false; btn.textContent = '조회';
}

function renderReport(d) {
  const pct = d.totalUnanswerable > 0 ? (d.timeoutCount / d.totalUnanswerable * 100).toFixed(1) : '0';
  const reasons = Object.entries(d.reasonDist).sort((a, b) => b[1] - a[1]);
  const mx = reasons.length > 0 ? reasons[0][1] : 1;
  let h = '<div class="cards"><div class="card"><div class="lb">전체 답변불가</div><div class="vl">' + d.totalUnanswerable + '건</div></div><div class="card"><div class="lb">제한 시간 내 TA 미답변</div><div class="vl hl">' + d.timeoutCount + '건</div><div class="sm">' + pct + '%</div></div><div class="card"><div class="lb">해당 TA 수</div><div class="vl">' + d.taCount + '명</div></div></div>';
  h += '<div class="section"><h2>사유별 분포</h2>';
  for (const [name, cnt] of reasons) {
    const w = (cnt / mx * 100).toFixed(0);
    const bg = name === '제한 시간 내 TA 미답변' ? '#feb2b2' : '#e2e8f0';
    h += '<div class="rb"><span class="rn">' + esc(name) + '</span><span class="bar" style="width:' + w + '%;background:' + bg + '"></span><span class="rc">' + cnt + '</span></div>';
  }
  h += '</div><table><thead><tr><th>#</th><th>TA ID</th><th>TA 이름</th><th style="text-align:right">건수</th></tr></thead><tbody>';
  d.taList.forEach((ta, i) => { h += '<tr><td>' + (i+1) + '</td><td>' + esc(ta.taId) + '</td><td>' + esc(ta.name) + '</td><td class="r">' + ta.count + '</td></tr>'; });
  h += '</tbody></table>';
  document.getElementById('reportResult').innerHTML = h;
}

function doExport() {
  if (!lastReportData) return;
  const d = lastReportData;
  const pct = d.totalUnanswerable > 0 ? (d.timeoutCount / d.totalUnanswerable * 100).toFixed(1) : '0';
  const reasons = Object.entries(d.reasonDist).sort((a, b) => b[1] - a[1]);
  const mx = reasons.length > 0 ? reasons[0][1] : 1;
  let rbars = '', rows = '';
  for (const [name, cnt] of reasons) { const w=(cnt/mx*100).toFixed(0); const bg=name==='제한 시간 내 TA 미답변'?'#feb2b2':'#e2e8f0'; rbars+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px"><span style="min-width:200px">'+esc(name)+'</span><span style="height:18px;background:'+bg+';border-radius:4px;width:'+w+'%;min-width:4px"></span><span style="min-width:40px;text-align:right;color:#888">'+cnt+'</span></div>'; }
  d.taList.forEach((ta,i) => { rows+='<tr><td>'+(i+1)+'</td><td>'+esc(ta.taId)+'</td><td>'+esc(ta.name)+'</td><td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">'+ta.count+'</td></tr>'; });
  const out='<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>답변불가 ('+d.period.start+' ~ '+d.period.end+')</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;color:#333;padding:24px}.c{max-width:800px;margin:0 auto}h1{font-size:20px;font-weight:700;margin-bottom:8px}.p{color:#888;font-size:14px;margin-bottom:24px}.ds{display:flex;gap:16px;margin-bottom:24px}.d{flex:1;background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}.d .l{font-size:13px;color:#888;margin-bottom:4px}.d .v{font-size:28px;font-weight:700}.d .v.h{color:#e53e3e}.d .s{font-size:12px;color:#aaa}.rd{margin-bottom:24px;background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}.rd h2{font-size:14px;font-weight:600;color:#666;margin-bottom:12px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}th{background:#fafafa;text-align:left;padding:12px 16px;font-size:13px;color:#666;font-weight:600;border-bottom:1px solid #eee}td{padding:10px 16px;font-size:14px;border-bottom:1px solid #f0f0f0}tr:last-child td{border-bottom:none}tr:hover{background:#fafafa}.f{margin-top:16px;font-size:12px;color:#bbb;text-align:center}</style></head><body><div class="c"><h1>답변불가 - 제한 시간 내 TA 미답변</h1><div class="p">'+d.period.start+' ~ '+d.period.end+'</div><div class="ds"><div class="d"><div class="l">전체 답변불가</div><div class="v">'+d.totalUnanswerable+'건</div></div><div class="d"><div class="l">제한 시간 내 TA 미답변</div><div class="v h">'+d.timeoutCount+'건</div><div class="s">'+pct+'%</div></div><div class="d"><div class="l">해당 TA 수</div><div class="v">'+d.taCount+'명</div></div></div><div class="rd"><h2>사유별 분포</h2>'+rbars+'</div><table><thead><tr><th>#</th><th>TA ID</th><th>TA 이름</th><th style="text-align:right">건수</th></tr></thead><tbody>'+rows+'</tbody></table><div class="f">생성: '+new Date().toLocaleString('ko-KR')+'</div></div></body></html>';
  const blob = new Blob([out], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = '답변불가_'+d.period.start+'_'+d.period.end+'.html'; a.click();
}

// ── TA Meet 스케줄 ──

// ── 별점 비교 ──

async function doRating() {
  const s = document.getElementById('ratingStart').value;
  const e = document.getElementById('ratingEnd').value;
  if (!s || !e || !TOKEN) return;
  if (s > e) { alert('시작일 ≤ 종료일'); return; }
  const btn = document.getElementById('ratingBtn');
  btn.disabled = true; btn.textContent = '조회 중... (최초 조회는 시간이 걸려요)';
  document.getElementById('ratingResult').innerHTML = '<div class="loading">별점 데이터 조회 중...</div>';
  try {
    const res = await fetch('/api/rating-comparison?token=' + encodeURIComponent(TOKEN) + '&start=' + s + '&end=' + e);
    if (!res.ok) throw new Error(await res.text());
    renderRating(await res.json());
  } catch (err) {
    document.getElementById('ratingResult').innerHTML = '<div style="color:#e53e3e;padding:20px">오류: ' + esc(err.message) + '</div>';
  }
  btn.disabled = false; btn.textContent = '조회';
}

function renderRating(d) {
  const fmt = (v, suf) => v == null ? '-' : v + (suf || '');
  const dateLabel = (year, p) => year + '년 ' + p.start.slice(5).replace('-', '/') + '~' + p.end.slice(5).replace('-', '/');
  const row = (label, m) =>
    '<tr><td>' + esc(label) + '</td>' +
    '<td>' + fmt(m.avgStar) + '</td>' +
    '<td>' + m.resolvedCount.toLocaleString() + '</td>' +
    '<td>' + m.reviewCount.toLocaleString() + '</td>' +
    '<td>' + fmt(m.positiveRate, '%') + '</td>' +
    '<td>' + fmt(m.negativeRate, '%') + '</td></tr>';
  let h = '';
  h += '<div class="section"><h2>1. 대면 TA 상담</h2>';
  h += '<table><thead><tr><th></th><th>평균 별점</th><th>상담 진행 횟수</th><th>리뷰완료 상담 수</th><th>긍정적 별점 비율</th><th>부정적 별점 비율</th></tr></thead><tbody>';
  h += row(dateLabel(d.prevYear, d.prevPeriod), d.inPerson.prev);
  h += row(dateLabel(d.refYear, d.refPeriod), d.inPerson.ref);
  h += '</tbody></table></div>';
  h += '<div class="section"><h2>2. 온라인 답변</h2>';
  h += '<table><thead><tr><th></th><th>평균 별점</th><th>해결 완료 질문 수</th><th>리뷰완료 질문 수</th><th>긍정적 별점 비율</th><th>부정적 별점 비율</th></tr></thead><tbody>';
  h += row(dateLabel(d.prevYear, d.prevPeriod), d.online.prev);
  h += row(dateLabel(d.refYear, d.refPeriod), d.online.ref);
  h += '</tbody></table></div>';
  document.getElementById('ratingResult').innerHTML = h;
}

function updateMonthLabel() {
  document.getElementById('monthLabel').textContent = schYear + '년 ' + schMonth + '월';
}
function moveMonth(delta) {
  schMonth += delta;
  if (schMonth < 1) { schMonth = 12; schYear--; }
  if (schMonth > 12) { schMonth = 1; schYear++; }
  updateMonthLabel();
}

async function doSchedule() {
  const branch = document.getElementById('branchSel').value;
  if (!TOKEN) return;
  const btn = document.getElementById('schBtn');
  btn.disabled = true; btn.textContent = '조회 중...';
  document.getElementById('scheduleResult').innerHTML = '<div class="loading">스케줄 조회 중...</div>';
  document.getElementById('salaryResult').innerHTML = '';
  try {
    const [schRes, salRes] = await Promise.all([
      fetch('/api/schedule?token=' + encodeURIComponent(TOKEN) + '&year=' + schYear + '&month=' + schMonth + '&branch=' + branch),
      fetch('/api/salary?token=' + encodeURIComponent(TOKEN) + '&year=' + schYear + '&month=' + schMonth),
    ]);
    if (!schRes.ok) throw new Error(await schRes.text());
    const data = await schRes.json();
    renderCalendar(data);
    if (salRes.ok) { const sal = await salRes.json(); renderSalary(sal); }
  } catch (err) {
    document.getElementById('scheduleResult').innerHTML = '<div style="color:#e53e3e;padding:20px">오류: ' + esc(err.message) + '</div>';
  }
  btn.disabled = false; btn.textContent = '조회';
}

function renderSalary(sal) {
  const fmt = (n) => n.toLocaleString('ko-KR');
  let h = '<div class="cards" style="flex-wrap:wrap">';
  h += '<div class="card" style="border:2px solid #333"><div class="lb">TA Meet 급여 합계</div><div class="vl" style="font-size:24px">' + fmt(sal.total) + '원</div>';
  h += '<div class="sm" style="margin-top:4px;color:#666">총 ' + fmt(sal.totalSlots) + '타임</div>';
  h += '<div class="sm" style="margin-top:8px">';
  sal.branches.forEach(b => {
    const rate = b.code === 'G1' ? '42,000' : '52,500';
    h += esc(b.name) + ' ' + fmt(b.salary) + '원 · ' + fmt(b.slots) + '타임 <span style="color:#aaa">(' + rate + '원/타임)</span><br>';
  });
  h += '</div></div></div>';
  document.getElementById('salaryResult').innerHTML = h;
}

function renderCalendar(data) {
  const year = data.year, month = data.month, counts = data.counts;
  const firstDay = new Date(year, month - 1, 1).getDay(); // 0=일 1=월 ...
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = new Date().toISOString().slice(0, 10);

  const hdrs = ['월', '화', '수', '목', '금', '토', '일'];
  let h = '<div class="calendar">';
  hdrs.forEach(d => { h += '<div class="cal-hdr">' + d + '</div>'; });

  // 시작 요일 조정 (월=0)
  const startOffset = (firstDay + 6) % 7;
  for (let i = 0; i < startOffset; i++) h += '<div class="cal-cell empty"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const dt = year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    const dow = new Date(year, month - 1, day).getDay(); // 0=일
    const isWeekend = dow === 0 || dow === 6;
    const isSat = dow === 6, isSun = dow === 0;
    const isToday = dt === today;

    let cls = 'cal-cell';
    if (isSat) cls += ' sat';
    if (isSun) cls += ' sun';
    if (isToday) cls += ' today';

    const dc = counts[dt] || {};
    const slots = isWeekend ? ['T1', 'T2'] : ['T1', 'T2', 'T3'];

    h += '<div class="' + cls + '">';
    h += '<div class="cal-day">' + day + '</div>';
    slots.forEach(s => {
      const n = dc[s] || 0;
      const colorCls = n === 0 ? 'c0' : n <= 1 ? 'c1' : n <= 2 ? 'c2' : 'c3';
      h += '<div class="cal-slot ' + colorCls + '"><span class="sl">' + s + '</span><span class="sc">' + n + '명</span></div>';
    });
    h += '</div>';
  }

  h += '</div>';
  document.getElementById('scheduleResult').innerHTML = h;
}

// ── TA 성과 ──

let perfSortCol = 'count', perfSortAsc = false, lastPerfData = null;

async function doPerf() {
  const s = document.getElementById('perfStart').value, e = document.getElementById('perfEnd').value;
  if (!s || !e || !TOKEN) return;
  const btn = document.getElementById('perfBtn');
  btn.disabled = true; btn.textContent = '조회 중...';
  document.getElementById('perfResult').innerHTML = '<div class="loading">TA 성과 조회 중...</div>';
  try {
    const res = await fetch('/api/performance?token=' + encodeURIComponent(TOKEN) + '&start=' + s + '&end=' + e);
    if (!res.ok) throw new Error(await res.text());
    lastPerfData = await res.json();
    renderPerf(lastPerfData);
    document.getElementById('perfCsvBtn').style.display = '';
  } catch (err) {
    document.getElementById('perfResult').innerHTML = '<div style="color:#e53e3e;padding:20px">오류: ' + esc(err.message) + '</div>';
  }
  btn.disabled = false; btn.textContent = '조회';
}

function sortPerf(col) {
  if (perfSortCol === col) perfSortAsc = !perfSortAsc;
  else { perfSortCol = col; perfSortAsc = col === 'name' || col === 'taId'; }
  if (lastPerfData) renderPerf(lastPerfData);
}

function renderPerf(d) {
  if (!d.taList || d.taList.length === 0) {
    document.getElementById('perfResult').innerHTML = '<div class="loading">해당 기간에 답변 데이터가 없습니다</div>';
    return;
  }
  const list = [...d.taList];
  list.sort((a, b) => {
    let va = a[perfSortCol], vb = b[perfSortCol];
    if (perfSortCol === 'avgStar') { va = va === '-' ? -1 : parseFloat(va); vb = vb === '-' ? -1 : parseFloat(vb); }
    if (typeof va === 'string') return perfSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return perfSortAsc ? va - vb : vb - va;
  });
  const arrow = (col) => perfSortCol === col ? (perfSortAsc ? ' ↑' : ' ↓') : '';
  let h = '<div class="cards"><div class="card"><div class="lb">전체 답변 건수</div><div class="vl">' + d.totalAnswered + '건</div></div>';
  h += '<div class="card"><div class="lb">평균 소요시간</div><div class="vl">' + d.avgMin + '분</div></div>';
  h += '<div class="card"><div class="lb">평균 별점</div><div class="vl">' + d.avgStar + '</div></div>';
  h += '<div class="card"><div class="lb">TA 수</div><div class="vl">' + d.taCount + '명</div></div></div>';
  h += '<table><thead><tr><th>#</th>';
  h += '<th style="cursor:pointer" onclick="sortPerf(&quot;taId&quot;)">TA ID' + arrow('taId') + '</th>';
  h += '<th style="cursor:pointer" onclick="sortPerf(&quot;name&quot;)">TA 이름' + arrow('name') + '</th>';
  h += '<th style="cursor:pointer;text-align:right" onclick="sortPerf(&quot;count&quot;)">답변 건수' + arrow('count') + '</th>';
  h += '<th style="cursor:pointer;text-align:right" onclick="sortPerf(&quot;avgMin&quot;)">평균 소요시간 (분)' + arrow('avgMin') + '</th>';
  h += '<th style="cursor:pointer;text-align:right" onclick="sortPerf(&quot;avgStar&quot;)">평균 별점' + arrow('avgStar') + '</th>';
  h += '</tr></thead><tbody>';
  list.forEach((ta, i) => {
    h += '<tr><td>' + (i+1) + '</td><td>' + esc(ta.taId) + '</td><td>' + esc(ta.name) + '</td>';
    h += '<td class="r">' + ta.count + '</td><td class="r">' + ta.avgMin + '</td><td class="r">' + ta.avgStar + '</td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('perfResult').innerHTML = h;
}

// ── CSV 내보내기 ──

function downloadCsv(filename, rows) {
  const bom = '\\uFEFF';
  const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\\n');
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}

function exportReportCsv() {
  if (!lastReportData) return;
  const d = lastReportData;
  const rows = [['#', 'TA ID', 'TA 이름', '건수']];
  d.taList.forEach((ta, i) => rows.push([i + 1, ta.taId, ta.name, ta.count]));
  downloadCsv('답변시간초과_' + d.period.start + '_' + d.period.end + '.csv', rows);
}

function exportPerfCsv() {
  if (!lastPerfData) return;
  const d = lastPerfData;
  const rows = [['#', 'TA ID', 'TA 이름', '답변 건수', '평균 소요시간 (분)', '평균 별점']];
  d.taList.forEach((ta, i) => rows.push([i + 1, ta.taId, ta.name, ta.count, ta.avgMin, ta.avgStar]));
  downloadCsv('TA성과_' + d.period.start + '_' + d.period.end + '.csv', rows);
}

// ── 바우처 내역 ──

function initVoucherSelects() {
  const now = new Date();
  const months = [];
  // 2026년 1월부터 현재 월까지
  for (let m = 1; m <= now.getMonth() + 1; m++) {
    months.push(now.getFullYear() + '-' + String(m).padStart(2, '0'));
  }
  ['vMonthStart', 'vMonthEnd'].forEach(id => {
    const sel = document.getElementById(id);
    sel.innerHTML = '';
    months.forEach(m => sel.add(new Option(m, m)));
  });
  document.getElementById('vMonthStart').value = months[0];
  document.getElementById('vMonthEnd').value = months[months.length - 1];
}

async function doVoucherDownload() {
  const ms = document.getElementById('vMonthStart').value;
  const me = document.getElementById('vMonthEnd').value;
  const is = document.getElementById('vIdStart').value;
  const ie = document.getElementById('vIdEnd').value;
  if (!TOKEN || !ms || !me || !is || !ie) return;
  if (parseInt(is) > parseInt(ie)) {
    document.getElementById('voucherStatus').innerHTML =
      '<div style="color:#e53e3e;padding:20px">시작 번호가 종료 번호보다 큽니다</div>';
    return;
  }
  const btn = document.getElementById('vBtn');
  btn.disabled = true; btn.textContent = '다운로드 중...';
  const t0 = Date.now();
  document.getElementById('voucherStatus').innerHTML =
    '<div class="loading">크롤링 + 엑셀 생성 중. 학생 수에 따라 1-3분 소요됩니다... (' +
    (parseInt(ie) - parseInt(is) + 1) + '명, 같은 입력 재요청 시 캐시 즉시 응답)</div>';
  try {
    const url = '/api/voucher-export?token=' + encodeURIComponent(TOKEN) +
      '&monthStart=' + ms + '&monthEnd=' + me + '&idStart=' + is + '&idEnd=' + ie;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
      throw new Error(err.error || ('HTTP ' + res.status));
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '바우처_' + ms + '_' + me + '_' + is + '-' + ie + '.xlsx';
    a.click();
    URL.revokeObjectURL(a.href);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    document.getElementById('voucherStatus').innerHTML =
      '<div style="color:#047857;padding:20px">✓ 다운로드 완료 (' + sec + '초, ' + (blob.size / 1024).toFixed(0) + ' KB)</div>';
  } catch (err) {
    document.getElementById('voucherStatus').innerHTML =
      '<div style="color:#e53e3e;padding:20px">오류: ' + esc(err.message) + '</div>';
  }
  btn.disabled = false; btn.textContent = '엑셀 다운로드';
}

// ── AI 현황 보고 ──

let aiChartInstance = null;
let aiDailyChartInstance = null;

const stackTotalsPlugin = {
  id: 'stackTotals',
  afterDatasetsDraw(chart) {
    const { ctx, data } = chart;
    const periods = chart.config._aiPeriods || [];
    const showMoney = chart.config._showMoney !== false;
    const showDelta = chart.config._showDelta !== false;
    ctx.save();
    ctx.textAlign = 'center';
    data.labels.forEach((_, i) => {
      const stacks = {};
      ['gPrev', 'gRef'].forEach(stack => {
        const datasets = data.datasets.filter(d => d.stack === stack);
        const total = datasets.reduce((s, d) => s + (d.data[i] || 0), 0);
        if (total === 0) { stacks[stack] = null; return; }
        const lastDs = datasets[datasets.length - 1];
        const dsIdx = data.datasets.indexOf(lastDs);
        const meta = chart.getDatasetMeta(dsIdx);
        const bar = meta.data[i];
        stacks[stack] = { x: bar.x, y: bar.y, total };
      });
      ctx.fillStyle = '#D9534F';
      ctx.font = 'bold 11px sans-serif';
      if (stacks.gPrev) ctx.fillText('총 ' + stacks.gPrev.total.toLocaleString() + '건', stacks.gPrev.x, stacks.gPrev.y - 8);
      if (stacks.gRef)  ctx.fillText('총 ' + stacks.gRef.total.toLocaleString()  + '건', stacks.gRef.x,  stacks.gRef.y  - 8);
      const period = periods[i];
      if (!period) return;
      if (showMoney) {
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = '#333';
        if (stacks.gPrev && period.costPrev > 0) {
          ctx.fillText('₩' + period.costPrev.toLocaleString(), stacks.gPrev.x, stacks.gPrev.y - 26);
        }
        if (stacks.gRef && period.costRef > 0) {
          ctx.fillText('₩' + period.costRef.toLocaleString(), stacks.gRef.x, stacks.gRef.y - 26);
        }
      }
      if (showDelta && period.savingsPct !== null && stacks.gPrev && stacks.gRef) {
        const cx = (stacks.gPrev.x + stacks.gRef.x) / 2;
        const cy = Math.min(stacks.gPrev.y, stacks.gRef.y) - (showMoney ? 54 : 26);
        const pct = period.savingsPct;
        const label = pct >= 0 ? pct.toFixed(1) + '% 감축' : Math.abs(pct).toFixed(1) + '% 증가';
        ctx.fillStyle = pct >= 0 ? '#D9534F' : '#888';
        ctx.font = 'bold 15px sans-serif';
        ctx.fillText(label, cx, cy);
      }
    });
    ctx.restore();
  }
};

function initAiSelects() {
  const a = document.getElementById('aiMonthA'), b = document.getElementById('aiMonthB');
  if (!a || !b || a.options.length > 0) return;
  for (let m = 1; m <= 12; m++) {
    a.insertAdjacentHTML('beforeend', '<option value="' + m + '">' + m + '월</option>');
    b.insertAdjacentHTML('beforeend', '<option value="' + m + '">' + m + '월</option>');
  }
  const cur = new Date().getMonth() + 1;
  a.value = cur;
  b.value = cur;
}

async function doAiStatus() {
  if (!TOKEN) return;
  const refYear = new Date().getFullYear();
  const A = parseInt(document.getElementById('aiMonthA').value);
  const B = parseInt(document.getElementById('aiMonthB').value);
  const days = parseInt(document.getElementById('aiDays').value);
  if (!A || !B || !days || A > B || days < 1) { alert('A월 ≤ B월, X(일 간격) ≥ 1'); return; }
  const start = refYear + '-' + String(A).padStart(2, '0');
  const end = refYear + '-' + String(B).padStart(2, '0');
  const btn = document.getElementById('aiBtn');
  btn.disabled = true;
  btn.textContent = '조회 중... (최초 조회는 시간이 걸릴 수 있어요)';
  try {
    const res = await fetch('/api/ai-status?token=' + encodeURIComponent(TOKEN) + '&start=' + start + '&end=' + end + '&days=' + days);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (!data.periods || data.periods.length === 0) {
      alert('표시할 완전한 구간이 없습니다 (X일 간격이 총 일수보다 크거나 미래 기간)');
    } else {
      renderAiChart(data);
      if (data.daily && data.daily.length > 0) renderAiDailyChart(data.daily);
    }
  } catch (err) { alert('오류: ' + err.message); }
  btn.disabled = false;
  btn.textContent = '조회';
}

function renderAiChart(data) {
  const refYear = data.refYear;
  const prevYear = data.prevYear;
  const periods = data.periods;
  const labels = periods.map(p => {
    const parts = p.labelRef.split(' ~ ');
    return parts.map(s => s.slice(5).replace('-', '/')).join(' ~ ');
  });
  const refSuffix = String(refYear).slice(2);
  const prevSuffix = String(prevYear).slice(2);
  const titleEl = document.getElementById('aiChartTitle');
  if (titleEl) titleEl.textContent = prevSuffix + '년 vs ' + refSuffix + '년 해결완료 답변 수 + 온라인 TA 급여 비교';
  const maxStack = Math.max(0, ...periods.map(p => Math.max(p.yPrev_human, p.yRef_human + p.yRef_ai)));
  const yMaxRaw = maxStack * 1.3;
  const step = maxStack > 5000 ? 1000 : (maxStack > 500 ? 500 : 100);
  const yMax = Math.ceil(yMaxRaw / step) * step;
  const datasets = [
    { label: prevSuffix + '년 인간 TA', backgroundColor: '#F1BF42', stack: 'gPrev',
      data: periods.map(p => p.yPrev_human) },
    { label: refSuffix + '년 인간 TA', backgroundColor: '#D9534F', stack: 'gRef',
      data: periods.map(p => p.yRef_human) },
    { label: refSuffix + '년 AI TA (아이올)', backgroundColor: '#4A90E2', stack: 'gRef',
      data: periods.map(p => p.yRef_ai) },
  ];
  if (aiChartInstance) aiChartInstance.destroy();
  const ctx = document.getElementById('aiChart').getContext('2d');
  aiChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true,
      layout: { padding: { top: 8, bottom: 8 } },
      plugins: {
        legend: { position: 'bottom', labels: { padding: 16 } },
        title: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0].dataIndex;
              return periods[i].labelPrev + '  vs  ' + periods[i].labelRef;
            },
          },
        },
        datalabels: {
          color: '#fff', font: { weight: 'bold', size: 11 }, textAlign: 'center',
          display: (c) => c.dataset.data[c.dataIndex] > 0,
          formatter: (val, c) => {
            const ds = c.chart.data.datasets;
            const stack = ds[c.datasetIndex].stack;
            const total = ds.filter(d => d.stack === stack).reduce((s, d) => s + (d.data[c.dataIndex] || 0), 0);
            const pct = total > 0 ? (val / total * 100).toFixed(1) : 0;
            return stack === 'gPrev' ? val.toLocaleString() + '건' : val.toLocaleString() + '건\\n(' + pct + '%)';
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, categoryPercentage: 0.7, barPercentage: 0.8 },
        y: { stacked: true, beginAtZero: true, max: yMax, title: { display: true, text: '해결완료 답변 수 (건)' } },
      },
    },
    plugins: [ChartDataLabels, stackTotalsPlugin],
  });
  aiChartInstance.config._aiPeriods = periods;
  aiChartInstance.config._showMoney = document.getElementById('aiShowMoney') ? document.getElementById('aiShowMoney').checked : true;
  aiChartInstance.config._showDelta = document.getElementById('aiShowDelta') ? document.getElementById('aiShowDelta').checked : true;
  aiChartInstance.update();
}

function redrawAiChart() {
  if (!aiChartInstance) return;
  aiChartInstance.config._showMoney = document.getElementById('aiShowMoney').checked;
  aiChartInstance.config._showDelta = document.getElementById('aiShowDelta').checked;
  aiChartInstance.update();
}

function renderAiDailyChart(daily) {
  if (aiDailyChartInstance) aiDailyChartInstance.destroy();
  const labels = daily.map(d => d.date.slice(5).replace('-', '/'));
  const ratios = daily.map(d => d.ratio === null ? null : +(d.ratio * 100).toFixed(2));
  const dailyTitleEl = document.getElementById('aiDailyChartTitle');
  if (dailyTitleEl) dailyTitleEl.textContent = '일자별 AI TA (아이올) 해결 비율 (%)';
  const ctx = document.getElementById('aiDailyRatioChart').getContext('2d');
  aiDailyChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'AI TA (아이올) 해결 비율',
        data: ratios,
        borderColor: '#4A90E2',
        backgroundColor: '#4A90E2',
        tension: 0,
        pointRadius: 3,
        spanGaps: false,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'top' },
        title: { display: false },
        datalabels: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => daily[items[0].dataIndex].date,
            label: (item) => {
              const d = daily[item.dataIndex];
              if (d.ratio === null) return '데이터 없음';
              return 'AI ' + d.aiCount + '건 / 전체 ' + d.totalCount + '건 (' + (d.ratio * 100).toFixed(1) + '%)';
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: true, maxTicksLimit: 30 } },
        y: { beginAtZero: true, max: 60, ticks: { stepSize: 5, callback: v => v + '%' }, title: { display: true, text: '비율 (%)' } },
      },
    },
  });
}

// ── 동영상 재활용 ──

let lastVideoReuseData = null;

// 클라이언트 측 영속 캐시 — 브라우저 새로고침/탭 전환에도 즉시 표시
const VR_LOCAL_PREFIX = 'vrCache:';
const VR_LOCAL_TODAY_TTL_MS = 60 * 60 * 1000;
const VR_LOCAL_MAX_ENTRIES = 30;

function vrTodayStr() {
  const n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
}
function loadVrLocalCache(s, e) {
  try {
    const raw = localStorage.getItem(VR_LOCAL_PREFIX + s + ':' + e);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.data || typeof obj.savedAt !== 'number') return null;
    const today = vrTodayStr();
    if (e < today) return obj; // 과거 기간: 영구 hit
    if (Date.now() - obj.savedAt < VR_LOCAL_TODAY_TTL_MS) return obj;
    return null;
  } catch { return null; }
}
function saveVrLocalCache(s, e, data) {
  try {
    localStorage.setItem(VR_LOCAL_PREFIX + s + ':' + e, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    pruneVrLocalCache(true);
    try { localStorage.setItem(VR_LOCAL_PREFIX + s + ':' + e, JSON.stringify({ savedAt: Date.now(), data })); } catch {}
  }
}
function pruneVrLocalCache(aggressive) {
  try {
    const all = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(VR_LOCAL_PREFIX)) continue;
      try {
        const obj = JSON.parse(localStorage.getItem(k));
        all.push({ k, savedAt: (obj && obj.savedAt) || 0 });
      } catch { localStorage.removeItem(k); }
    }
    all.sort((a, b) => b.savedAt - a.savedAt);
    const limit = aggressive ? Math.floor(VR_LOCAL_MAX_ENTRIES / 2) : VR_LOCAL_MAX_ENTRIES;
    const cutoff = Date.now() - 30 * 86400000;
    all.forEach((entry, i) => {
      if (entry.savedAt < cutoff || i >= limit) localStorage.removeItem(entry.k);
    });
  } catch {}
}
function clearVrLocalCache(s, e) {
  try { localStorage.removeItem(VR_LOCAL_PREFIX + s + ':' + e); } catch {}
}
function vrAgeLabel(savedAt) {
  if (!savedAt) return '저장된 결과';
  const secs = Math.max(0, Math.round((Date.now() - savedAt) / 1000));
  if (secs < 60) return secs + '초 전';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + '분 전';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + '시간 전';
  return Math.round(hours / 24) + '일 전';
}

async function doVideoReuse(opts) {
  const force = !!(opts && opts.force);
  const s = document.getElementById('vrStartDt').value, e = document.getElementById('vrEndDt').value;
  if (!s || !e || !TOKEN) return;
  const diff = Math.round((new Date(e) - new Date(s)) / 86400000);
  if (diff < 0) { document.getElementById('vrResult').innerHTML = '<div style="color:#e53e3e;padding:20px">시작일이 종료일보다 이후입니다.</div>'; return; }

  // 1) 브라우저 캐시 hit → 즉시 표시 (서버 왕복 0)
  if (!force) {
    const lc = loadVrLocalCache(s, e);
    if (lc) {
      lastVideoReuseData = lc.data;
      renderVideoReuse(lc.data, { source: 'local', savedAt: lc.savedAt });
      document.getElementById('vrCsvBtn').style.display = '';
      return;
    }
  }

  const btn = document.getElementById('vrBtn');
  btn.disabled = true; btn.textContent = '조회 중...';
  document.getElementById('vrCsvBtn').style.display = 'none';
  document.getElementById('vrResult').innerHTML = '<div class="loading">동영상 답변 추출 + ETag 확인 중... (첫 조회 시 수 분 소요, 이후 캐시로 즉시 표시)</div>';
  try {
    const qs = '/api/video-reuse?token=' + encodeURIComponent(TOKEN) + '&start=' + s + '&end=' + e + (force ? '&fresh=1' : '');
    const res = await fetch(qs);
    if (!res.ok) { const t = await res.text(); throw new Error(t); }
    const data = await res.json();
    lastVideoReuseData = data;
    saveVrLocalCache(s, e, data);
    const banner = data._cached === 'server'
      ? { source: 'server', savedAt: data._cacheSavedAt }
      : null;
    renderVideoReuse(data, banner);
    document.getElementById('vrCsvBtn').style.display = '';
  } catch (err) {
    document.getElementById('vrResult').innerHTML = '<div style="color:#e53e3e;padding:20px">오류: ' + esc(err.message) + '</div>';
  }
  btn.disabled = false; btn.textContent = '조회';
}

function refreshVrCache() {
  const s = document.getElementById('vrStartDt').value, e = document.getElementById('vrEndDt').value;
  if (s && e) clearVrLocalCache(s, e);
  doVideoReuse({ force: true });
}

function renderVideoReuse(d, banner) {
  let h = '';
  if (banner && banner.source === 'local') {
    h += '<div style="background:#ecfdf5;border:1px solid #6ee7b7;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:12px">'
      + '<span style="color:#065f46">브라우저 캐시에서 즉시 표시 (' + esc(vrAgeLabel(banner.savedAt)) + ' 조회). 같은 조건은 다시 받지 않아 빠릅니다.</span>'
      + '<button onclick="refreshVrCache()" style="background:#fff;border:1px solid #059669;color:#065f46;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap">새로 조회</button>'
      + '</div>';
  } else if (banner && banner.source === 'server') {
    h += '<div style="background:#eff6ff;border:1px solid #93c5fd;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:12px">'
      + '<span style="color:#1e3a8a">서버 캐시에서 즉시 표시 (' + esc(vrAgeLabel(banner.savedAt)) + ' 저장). 데이터 갱신은 우측 버튼.</span>'
      + '<button onclick="refreshVrCache()" style="background:#fff;border:1px solid #2563eb;color:#1e3a8a;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap">새로 조회</button>'
      + '</div>';
  }
  h += '<div class="cards">' +
    '<div class="card"><div class="lb">동영상 답변 (조회 기간)</div><div class="vl">' + d.totalAttachments + '건</div></div>' +
    '<div class="card"><div class="lb">재활용 원본 영상</div><div class="vl">' + d.totalOriginals + '개</div></div>' +
    '<div class="card"><div class="lb">꽁 답변 (D-C)</div><div class="vl hl">' + d.totalExtra + '건</div></div>' +
    '<div class="card"><div class="lb">해당 TA 수</div><div class="vl">' + d.taCount + '명</div></div>' +
    '</div>';
  if (d.taList.length === 0) {
    h += '<div class="section" style="text-align:center;color:#888">재활용 패턴 없음</div>';
    document.getElementById('vrResult').innerHTML = h;
    return;
  }
  h += '<table id="vrTable"><thead><tr>' +
    '<th>#</th><th>TA ID</th><th>TA 이름</th>' +
    '<th style="text-align:right">원본 수 (C)</th>' +
    '<th style="text-align:right">활용 답변 (D)</th>' +
    '<th style="text-align:right">꽁 (D-C)</th>' +
    '</tr></thead><tbody>';
  d.taList.forEach((t, i) => {
    h += '<tr class="vr-row" onclick="toggleVrDetail(' + i + ')" style="cursor:pointer">' +
      '<td>' + (i+1) + '</td>' +
      '<td style="color:#1d4ed8;text-decoration:underline">' + esc(t.taId) + '</td>' +
      '<td>' + esc(t.taName) + '</td>' +
      '<td class="r">' + t.originalCount + '</td>' +
      '<td class="r">' + t.totalUses + '</td>' +
      '<td class="r" style="color:#e53e3e">' + t.extraUses + '</td>' +
      '</tr>';
    h += '<tr id="vrDetail-' + i + '" style="display:none"><td colspan="6" style="background:#fafafa;padding:16px 24px">' +
      renderVrDetail(t) + '</td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('vrResult').innerHTML = h;
}

function renderVrDetail(t) {
  if (!t.files || t.files.length === 0) return '<div style="color:#888">상세 없음</div>';
  let h = '<div style="font-size:13px;color:#666;margin-bottom:8px">' + esc(t.taId) + ' (' + esc(t.taName) + ') · 재활용 영상 ' + t.files.length + '개</div>';
  h += '<table style="background:#fff;width:100%"><thead><tr>' +
    '<th>#</th><th>원본 영상</th><th style="text-align:right">크기</th><th style="text-align:right">사용 횟수</th>' +
    '<th>원본 질문</th><th>재활용 질문 ID</th></tr></thead><tbody>';
  t.files.forEach((f, i) => {
    const sizeMb = f.contentLength ? (f.contentLength / 1024 / 1024).toFixed(1) + 'MB' : '-';
    const origLink = adminLink(f.original.masterSerialNo);
    const origMeta = vrMetaLabel(f.original);
    const reuseLinks = f.reuses.map(r => adminLink(r.masterSerialNo)).join(', ');
    h += '<tr>' +
      '<td>' + (i+1) + '</td>' +
      '<td><a href="' + esc(f.url) + '" target="_blank" style="color:#1d4ed8;text-decoration:underline;font-size:12px">' + esc(f.fileName) + '</a></td>' +
      '<td class="r">' + sizeMb + '</td>' +
      '<td class="r">' + f.totalUses + '회</td>' +
      '<td style="font-size:12px">' + origLink + ' <span style="color:#888">· ' + esc(origMeta) + '</span></td>' +
      '<td style="font-size:12px;line-height:1.6">' + reuseLinks + '</td>' +
      '</tr>';
  });
  h += '</tbody></table>';
  return h;
}

function adminLink(id) {
  return '<a href="https://qna-admin.hiconsysvc.com/qna/' + id + '" target="_blank" style="color:#1d4ed8;text-decoration:underline">#' + id + '</a>';
}
function vrMetaLabel(m) {
  if (!m) return '';
  const parts = [];
  if (m.registerAt) parts.push(m.registerAt.slice(0, 16));
  if (m.subjectClass) parts.push(m.subjectClass);
  if (m.contents) parts.push(m.contents);
  return parts.join(' · ');
}

function toggleVrDetail(i) {
  const row = document.getElementById('vrDetail-' + i);
  if (!row) return;
  row.style.display = row.style.display === 'none' ? '' : 'none';
}

function exportVideoReuseCsv() {
  if (!lastVideoReuseData) return;
  const d = lastVideoReuseData;
  // 두 시트 합본 형식: 헤더 → 요약 표 → (빈 줄) → 파일별 상세
  const rows = [];
  rows.push(['TA ID', 'TA 이름', '원본 수 (C)', '활용 답변 (D)', '꽁 (D-C)']);
  d.taList.forEach(t => rows.push([t.taId, t.taName, t.originalCount, t.totalUses, t.extraUses]));
  rows.push([]);
  rows.push(['', '== 영상별 상세 ==']);
  rows.push(['TA ID', 'TA 이름', '원본 파일명', '크기(MB)', '사용 횟수', '원본 질문ID', '원본 등록일시', '원본 컨텐츠', '재활용 질문 IDs']);
  d.taList.forEach(t => {
    (t.files || []).forEach(f => {
      const sizeMb = f.contentLength ? (f.contentLength / 1024 / 1024).toFixed(2) : '';
      const reuseIds = (f.reuses || []).map(r => r.masterSerialNo).join(' ');
      rows.push([
        t.taId, t.taName, f.fileName, sizeMb, f.totalUses,
        f.original.masterSerialNo, f.original.registerAt || '',
        [f.original.subjectClass, f.original.contents].filter(Boolean).join(' / '),
        reuseIds,
      ]);
    });
  });
  const csv = rows.map(r => r.map(c => {
    const s = c == null ? '' : String(c);
    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\\n');
  const blob = new Blob(['\\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '동영상재활용_' + d.period.start + '_' + d.period.end + '.csv';
  a.click();
}

// Enter 키
document.getElementById('upw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('code').addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); });
</script>
</body>
</html>`;

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));

// 감시기 인프로세스 폴링 (dyno 깨어있을 때 보조 구동). 외부 cron이 keep-alive + 주 트리거.
// 인증 없으면(NEED_LOGIN) 조용히 패스.
setInterval(() => { runMonitorTick('interval').catch(() => {}); }, MONITOR_INTERVAL_MS);
