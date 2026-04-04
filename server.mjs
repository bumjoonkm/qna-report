import { createServer } from 'http';

const API = 'https://qna-admin-api.hiconsysvc.com';
const PORT = process.env.PORT || 3000;
const PAGE_SIZE = 100;
const CONCURRENCY = 20;
const CACHE_TTL = 10 * 60 * 1000; // 10분

const cache = new Map();
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, ts: Date.now() }); return data; });
}

const BRANCHES = [
  { code: 'Z1', name: 'N관' },
  { code: 'Z2', name: 'M3관' },
  { code: 'Z3', name: '신관' },
  { code: 'Z6', name: 'W관' },
  { code: 'Y1', name: '목동관' },
  { code: 'G1', name: '기숙관' },
];

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

async function get(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
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
  return { year, month, branchCode, counts };
}

// ── TA 성과 ──

async function fetchPerformance(token, startDt, endDt) {
  const first = await get(`/v1/qna/list?page=1&pageSize=1&startDt=${startDt}&endDt=${endDt}&questionStatusCommonCode=QA120004&searchType=taName`, token);
  const total = first.data.totalCount;
  const pages = Math.ceil(total / PAGE_SIZE) || 1;
  const items = [];
  for (let p = 1; p <= pages; p++) {
    const body = await get(`/v1/qna/list?page=${p}&pageSize=${PAGE_SIZE}&startDt=${startDt}&endDt=${endDt}&questionStatusCommonCode=QA120004&searchType=taName`, token);
    items.push(...(body.data.contents || []));
  }
  const taMap = {};
  for (const item of items) {
    if (item.taAiYn === 'Y') continue; // AI 답변 제외
    const k = item.taId || item.taName;
    if (!k) continue;
    if (!taMap[k]) taMap[k] = { taId: item.taId, name: item.taName, count: 0, totalMin: 0, totalStar: 0, starCount: 0 };
    taMap[k].count++;
    if (item.registerAt && item.answerEndAt) {
      const diff = (new Date(item.answerEndAt) - new Date(item.registerAt)) / 60000;
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
    period: { start: startDt, end: endDt }, totalAnswered: total, taCount: taList.length,
    avgMin: totalCount > 0 ? Math.round(totalMin / totalCount) : 0,
    avgStar: starItems > 0 ? (totalStar / starItems).toFixed(1) : '-',
    taList,
  };
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

  if (req.method === 'GET' && url.pathname === '/api/performance') {
    const token = url.searchParams.get('token'), start = url.searchParams.get('start'), end = url.searchParams.get('end');
    if (!token || !start || !end) { json(res, 400, { error: 'token, start, end 필요' }); return; }
    try { json(res, 200, await cached(`performance:${start}:${end}`, () => fetchPerformance(token, start, end))); }
    catch (e) { json(res, 500, { error: e.message }); }
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
  </div>

  <!-- 답변불가 리포트 -->
  <div class="page active" id="page-report">
    <div class="ctrl">
      <input type="date" id="startDt"> <span>~</span> <input type="date" id="endDt">
      <button class="btn" id="goBtn" onclick="doReport()">조회</button>
      <button class="btn ex" id="exBtn" style="display:none" onclick="doExport()">HTML 내보내기</button>
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
    <div id="scheduleResult"></div>
  </div>

  <!-- TA 성과 -->
  <div class="page" id="page-perf">
    <div class="ctrl">
      <input type="date" id="perfStart"> <span>~</span> <input type="date" id="perfEnd">
      <button class="btn" id="perfBtn" onclick="doPerf()">조회</button>
    </div>
    <div id="perfResult"></div>
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
  document.getElementById('reportResult').innerHTML = '<div class="loading">데이터 조회 중... (상세 사유 확인으로 시간이 걸릴 수 있습니다)</div>';
  try {
    const res = await fetch('/api/report?token=' + encodeURIComponent(TOKEN) + '&start=' + s + '&end=' + e);
    if (!res.ok) throw new Error(await res.text());
    lastReportData = await res.json();
    renderReport(lastReportData);
    document.getElementById('exBtn').style.display = '';
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
  try {
    const res = await fetch('/api/schedule?token=' + encodeURIComponent(TOKEN) + '&year=' + schYear + '&month=' + schMonth + '&branch=' + branch);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    renderCalendar(data);
  } catch (err) {
    document.getElementById('scheduleResult').innerHTML = '<div style="color:#e53e3e;padding:20px">오류: ' + esc(err.message) + '</div>';
  }
  btn.disabled = false; btn.textContent = '조회';
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
  h += '<th style="cursor:pointer" onclick="sortPerf(\'taId\')">TA ID' + arrow('taId') + '</th>';
  h += '<th style="cursor:pointer" onclick="sortPerf(\'name\')">TA 이름' + arrow('name') + '</th>';
  h += '<th style="cursor:pointer;text-align:right" onclick="sortPerf(\'count\')">답변 건수' + arrow('count') + '</th>';
  h += '<th style="cursor:pointer;text-align:right" onclick="sortPerf(\'avgMin\')">평균 소요시간 (분)' + arrow('avgMin') + '</th>';
  h += '<th style="cursor:pointer;text-align:right" onclick="sortPerf(\'avgStar\')">평균 별점' + arrow('avgStar') + '</th>';
  h += '</tr></thead><tbody>';
  list.forEach((ta, i) => {
    h += '<tr><td>' + (i+1) + '</td><td>' + esc(ta.taId) + '</td><td>' + esc(ta.name) + '</td>';
    h += '<td class="r">' + ta.count + '</td><td class="r">' + ta.avgMin + '</td><td class="r">' + ta.avgStar + '</td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('perfResult').innerHTML = h;
}

// Enter 키
document.getElementById('upw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('code').addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); });
</script>
</body>
</html>`;

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
