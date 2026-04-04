import { createServer } from 'http';

const API = 'https://qna-admin-api.hiconsysvc.com';
const PORT = process.env.PORT || 3000;
const PAGE_SIZE = 100;
const CONCURRENCY = 20;

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

// ── 데이터 수집 ──

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

  const reasonDist = {};
  const taMap = {};
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

// ── 라우팅 ──

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => resolve(d));
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 정적 페이지
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // 1단계: 로그인 (2FA 코드 발송)
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const { accountId, accountPassword } = JSON.parse(await readBody(req));
    const result = await post('/v1/manager/auth', { accountId, accountPassword, certNo: null });
    json(res, 200, result);
    return;
  }

  // 2단계: 2FA 인증 + 토큰 발급
  if (req.method === 'POST' && url.pathname === '/api/verify') {
    const { accountId, accountPassword, certNo } = JSON.parse(await readBody(req));
    const result = await post('/v1/manager/auth/token', { accountId, accountPassword, certNo });

    // 응답에서 토큰 추출 (쿠키 형태로 올 수 있음)
    if (result.code === 'R20000' && result.data) {
      json(res, 200, { ok: true, accessToken: result.data.accessToken, data: result.data });
    } else {
      json(res, 200, { ok: false, message: result.message, data: result.data });
    }
    return;
  }

  // 3단계: 리포트 데이터 조회
  if (req.method === 'GET' && url.pathname === '/api/report') {
    const token = url.searchParams.get('token');
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!token || !start || !end) { json(res, 400, { error: 'token, start, end 필요' }); return; }
    try {
      const data = await fetchReport(token, start, end);
      json(res, 200, data);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ip') {
    const r = await fetch('https://api.ipify.org?format=json');
    const d = await r.json();
    json(res, 200, d);
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
<title>답변불가 리포트</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .container { width: 100%; max-width: 800px; padding: 24px; }

  /* 로그인 */
  .login-box { max-width: 380px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 36px 32px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
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

  /* 리포트 */
  .report { display: none; }
  .report.active { display: block; }
  .report h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
  .ctrl { display: flex; gap: 8px; align-items: center; margin-bottom: 20px; flex-wrap: wrap; background: #fff; padding: 16px 20px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .ctrl input[type=date] { padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
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
  .footer { margin-top: 16px; font-size: 12px; color: #bbb; text-align: center; }
  @media (max-width: 600px) { .cards { flex-direction: column; } .rb .rn { min-width: 120px; } }
</style>
</head>
<body>

<!-- 로그인 화면 -->
<div class="container" id="loginView">
  <div class="login-box">
    <h1>QnA 답변불가 리포트</h1>
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

<!-- 리포트 화면 -->
<div class="container report" id="reportView">
  <h1>답변불가 리포트</h1>
  <div class="ctrl">
    <input type="date" id="startDt"> <span>~</span> <input type="date" id="endDt">
    <button class="btn" id="goBtn" onclick="doReport()">조회</button>
    <button class="btn ex" id="exBtn" style="display:none" onclick="doExport()">HTML 내보내기</button>
  </div>
  <div id="result"></div>
  <div class="footer">QnA 관리자 답변불가 리포트</div>
</div>

<script>
let TOKEN = null, savedId = '', savedPw = '', lastData = null;

async function doLogin() {
  const id = document.getElementById('uid').value.trim();
  const pw = document.getElementById('upw').value;
  if (!id || !pw) return;
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = '로그인 중...';
  document.getElementById('loginErr').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: id, accountPassword: pw })
    });
    const data = await res.json();
    if (data.code === 'R20000') {
      savedId = id; savedPw = pw;
      document.getElementById('step1').style.display = 'none';
      document.getElementById('step2').style.display = 'block';
      document.getElementById('code').focus();
    } else {
      document.getElementById('loginErr').textContent = data.message || '로그인 실패';
    }
  } catch (e) {
    document.getElementById('loginErr').textContent = '서버 오류: ' + e.message;
  }
  btn.disabled = false; btn.textContent = '로그인';
}

async function doVerify() {
  const code = document.getElementById('code').value.trim();
  if (!code) return;
  const btn = document.getElementById('verifyBtn');
  btn.disabled = true; btn.textContent = '확인 중...';
  document.getElementById('verifyErr').textContent = '';
  try {
    const res = await fetch('/api/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: savedId, accountPassword: savedPw, certNo: code })
    });
    const data = await res.json();
    if (data.ok && data.accessToken) {
      TOKEN = data.accessToken;
      showReport();
    } else {
      document.getElementById('verifyErr').textContent = data.message || '인증 실패';
    }
  } catch (e) {
    document.getElementById('verifyErr').textContent = '서버 오류: ' + e.message;
  }
  btn.disabled = false; btn.textContent = '확인';
}

function showReport() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('reportView').classList.add('active');
  const now = new Date();
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('startDt').value = ym + '-01';
  document.getElementById('endDt').value = now.toISOString().slice(0, 10);
}

async function doReport() {
  const s = document.getElementById('startDt').value, e = document.getElementById('endDt').value;
  if (!s || !e || !TOKEN) return;
  const btn = document.getElementById('goBtn');
  btn.disabled = true; btn.textContent = '조회 중...';
  document.getElementById('exBtn').style.display = 'none';
  document.getElementById('result').innerHTML = '<div class="loading">데이터 조회 중... (상세 사유 확인으로 시간이 걸릴 수 있습니다)</div>';
  try {
    const res = await fetch('/api/report?token=' + encodeURIComponent(TOKEN) + '&start=' + s + '&end=' + e);
    if (!res.ok) throw new Error(await res.text());
    lastData = await res.json();
    render(lastData);
    document.getElementById('exBtn').style.display = '';
  } catch (err) {
    document.getElementById('result').innerHTML = '<div style="color:#e53e3e;padding:20px">오류: ' + esc(err.message) + '</div>';
  }
  btn.disabled = false; btn.textContent = '조회';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function render(d) {
  const pct = d.totalUnanswerable > 0 ? (d.timeoutCount / d.totalUnanswerable * 100).toFixed(1) : '0';
  const reasons = Object.entries(d.reasonDist).sort((a, b) => b[1] - a[1]);
  const mx = reasons.length > 0 ? reasons[0][1] : 1;

  let h = '<div class="cards">' +
    '<div class="card"><div class="lb">전체 답변불가</div><div class="vl">' + d.totalUnanswerable + '건</div></div>' +
    '<div class="card"><div class="lb">제한 시간 내 TA 미답변</div><div class="vl hl">' + d.timeoutCount + '건</div><div class="sm">' + pct + '%</div></div>' +
    '<div class="card"><div class="lb">해당 TA 수</div><div class="vl">' + d.taCount + '명</div></div></div>';

  h += '<div class="section"><h2>사유별 분포</h2>';
  for (const [name, cnt] of reasons) {
    const w = (cnt / mx * 100).toFixed(0);
    const bg = name === '제한 시간 내 TA 미답변' ? '#feb2b2' : '#e2e8f0';
    h += '<div class="rb"><span class="rn">' + esc(name) + '</span><span class="bar" style="width:' + w + '%;background:' + bg + '"></span><span class="rc">' + cnt + '</span></div>';
  }
  h += '</div>';

  h += '<table><thead><tr><th>#</th><th>TA ID</th><th>TA 이름</th><th style="text-align:right">건수</th></tr></thead><tbody>';
  d.taList.forEach((ta, i) => {
    h += '<tr><td>' + (i + 1) + '</td><td>' + esc(ta.taId) + '</td><td>' + esc(ta.name) + '</td><td class="r">' + ta.count + '</td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('result').innerHTML = h;
}

function doExport() {
  if (!lastData) return;
  const d = lastData;
  const pct = d.totalUnanswerable > 0 ? (d.timeoutCount / d.totalUnanswerable * 100).toFixed(1) : '0';
  const reasons = Object.entries(d.reasonDist).sort((a, b) => b[1] - a[1]);
  const mx = reasons.length > 0 ? reasons[0][1] : 1;

  let rbars = '';
  for (const [name, cnt] of reasons) {
    const w = (cnt / mx * 100).toFixed(0);
    const bg = name === '제한 시간 내 TA 미답변' ? '#feb2b2' : '#e2e8f0';
    rbars += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px"><span style="min-width:200px">' + esc(name) + '</span><span style="height:18px;background:' + bg + ';border-radius:4px;width:' + w + '%;min-width:4px"></span><span style="min-width:40px;text-align:right;color:#888">' + cnt + '</span></div>';
  }
  let rows = '';
  d.taList.forEach((ta, i) => {
    rows += '<tr><td>' + (i+1) + '</td><td>' + esc(ta.taId) + '</td><td>' + esc(ta.name) + '</td><td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">' + ta.count + '</td></tr>';
  });

  const out = '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>답변불가 리포트 (' + d.period.start + ' ~ ' + d.period.end + ')</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f5;color:#333;padding:24px}.c{max-width:800px;margin:0 auto}h1{font-size:20px;font-weight:700;margin-bottom:8px}.p{color:#888;font-size:14px;margin-bottom:24px}.ds{display:flex;gap:16px;margin-bottom:24px}.d{flex:1;background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}.d .l{font-size:13px;color:#888;margin-bottom:4px}.d .v{font-size:28px;font-weight:700}.d .v.h{color:#e53e3e}.d .s{font-size:12px;color:#aaa;margin-top:4px}.rd{margin-bottom:24px;background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}.rd h2{font-size:14px;font-weight:600;color:#666;margin-bottom:12px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}th{background:#fafafa;text-align:left;padding:12px 16px;font-size:13px;color:#666;font-weight:600;border-bottom:1px solid #eee}td{padding:10px 16px;font-size:14px;border-bottom:1px solid #f0f0f0}tr:last-child td{border-bottom:none}tr:hover{background:#fafafa}.f{margin-top:16px;font-size:12px;color:#bbb;text-align:center}</style></head><body><div class="c"><h1>답변불가 - 제한 시간 내 TA 미답변</h1><div class="p">' + d.period.start + ' ~ ' + d.period.end + '</div><div class="ds"><div class="d"><div class="l">전체 답변불가</div><div class="v">' + d.totalUnanswerable + '건</div></div><div class="d"><div class="l">제한 시간 내 TA 미답변</div><div class="v h">' + d.timeoutCount + '건</div><div class="s">' + pct + '%</div></div><div class="d"><div class="l">해당 TA 수</div><div class="v">' + d.taCount + '명</div></div></div><div class="rd"><h2>사유별 분포</h2>' + rbars + '</div><table><thead><tr><th>#</th><th>TA ID</th><th>TA 이름</th><th style="text-align:right">건수</th></tr></thead><tbody>' + rows + '</tbody></table><div class="f">생성: ' + new Date().toLocaleString('ko-KR') + '</div></div></body></html>';

  const blob = new Blob([out], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '답변불가_' + d.period.start + '_' + d.period.end + '.html';
  a.click();
}

// Enter 키 지원
document.getElementById('upw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('code').addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); });
</script>
</body>
</html>`;

server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
