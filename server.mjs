import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import ExcelJS from 'exceljs';

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

// ── 디스크 캐시 (영구, 과거 데이터용) ──
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
function diskGet(key) {
  const p = `${CACHE_DIR}/${key}.json`;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function diskSet(key, data) {
  try { writeFileSync(`${CACHE_DIR}/${key}.json`, JSON.stringify(data)); } catch {}
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
  return { year, month, branchCode, counts, salary: totalSlots * rate };
}

async function fetchSalaryAll(token, year, month) {
  const results = await Promise.all(
    BRANCHES.map(b => fetchSchedule(token, year, month, b.code).then(r => ({ code: b.code, name: b.name, salary: r.salary })))
  );
  const total = results.reduce((s, r) => s + r.salary, 0);
  return { year, month, branches: results, total };
}

// ── TA 성과 ──

// 하루치 데이터 가져오기 (디스크 캐시 활용)
async function fetchDayItems(token, dt) {
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `perf-${dt}`;
  if (dt < today) {
    const cached = diskGet(cacheKey);
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

  const isAI = (item) => AI_TA_IDS.has(item.taId);
  const sumRange = (period, predicate) => {
    let total = 0;
    const sd = dtToDays(period.start), ed = dtToDays(period.end);
    for (let day = sd; day <= ed; day++) {
      total += (dayMap[daysToDt(day)] || []).filter(predicate).length;
    }
    return total;
  };

  const periods = periodsRef.map((pRef, i) => {
    const pPrev = periodsPrev[i];
    return {
      labelRef: `${pRef.start} ~ ${pRef.end}`,
      labelPrev: `${pPrev.start} ~ ${pPrev.end}`,
      yPrev_human: sumRange(pPrev, x => !isAI(x)),
      yRef_human: sumRange(pRef, x => !isAI(x)),
      yRef_ai: sumRange(pRef, x => isAI(x)),
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(req.method === 'HEAD' ? undefined : 'ok');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const { accountId, accountPassword } = JSON.parse(await readBody(req));
    json(res, 200, await post('/v1/manager/auth', { accountId, accountPassword, certNo: null }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/verify') {
    const { accountId, accountPassword, certNo } = JSON.parse(await readBody(req));
    const result = await post('/v1/manager/auth/token', { accountId, accountPassword, certNo });
    if (result.code === 'R20000' && result.data) {
      json(res, 200, { ok: true, accessToken: result.data.accessToken });
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
    try { json(res, 200, await cached(`salary:${year}:${month}`, () => fetchSalaryAll(token, year, month))); }
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

  if (req.method === 'GET' && url.pathname === '/api/ai-status') {
    const token = url.searchParams.get('token');
    const startMonth = url.searchParams.get('start');
    const endMonth = url.searchParams.get('end');
    const days = parseInt(url.searchParams.get('days'));
    if (!token || !startMonth || !endMonth || !days || days < 1) { json(res, 400, { error: 'token, start, end, days 필요' }); return; }
    try { json(res, 200, await cached(`aistatus:${startMonth}:${endMonth}:${days}`, () => fetchAiStatus(token, startMonth, endMonth, days))); }
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
    <div class="tab" onclick="switchTab('voucher')">바우처 내역 확인</div>
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
    </div>
    <div class="section" style="padding:24px">
      <canvas id="aiChart" height="120"></canvas>
      <canvas id="aiDailyRatioChart" height="80" style="margin-top:24px"></canvas>
    </div>
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
}

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
  h += '<div class="sm" style="margin-top:8px">';
  sal.branches.forEach(b => {
    const rate = b.code === 'G1' ? '42,000' : '52,500';
    h += esc(b.name) + ' ' + fmt(b.salary) + '원 <span style="color:#aaa">(' + rate + '원/타임)</span><br>';
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
    ctx.save();
    ctx.fillStyle = '#D9534F';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    data.labels.forEach((_, i) => {
      ['gPrev', 'gRef'].forEach(stack => {
        const datasets = data.datasets.filter(d => d.stack === stack);
        const total = datasets.reduce((s, d) => s + (d.data[i] || 0), 0);
        if (total === 0) return;
        const lastDs = datasets[datasets.length - 1];
        const dsIdx = data.datasets.indexOf(lastDs);
        const meta = chart.getDatasetMeta(dsIdx);
        const bar = meta.data[i];
        ctx.fillText('총 ' + total.toLocaleString() + '건', bar.x, bar.y - 6);
      });
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
      layout: { padding: { top: 28 } },
      plugins: {
        legend: { position: 'top' },
        title: { display: true, text: prevSuffix + '년 vs ' + refSuffix + '년 해결완료 답변 수 비교 (질문 상태=문제해결)' },
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
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: '해결완료 답변 수 (건)' } },
      },
    },
    plugins: [ChartDataLabels, stackTotalsPlugin],
  });
}

function renderAiDailyChart(daily) {
  if (aiDailyChartInstance) aiDailyChartInstance.destroy();
  const labels = daily.map(d => d.date.slice(5).replace('-', '/'));
  const ratios = daily.map(d => d.ratio === null ? null : +(d.ratio * 100).toFixed(2));
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
        title: { display: true, text: '일자별 AI TA (아이올) 해결 비율 (%)' },
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

// Enter 키
document.getElementById('upw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('code').addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); });
</script>
</body>
</html>`;

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
