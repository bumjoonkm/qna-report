// ════════════════════════════════════════════════════════════════════════
//  질문 분류기 (성능 기능 / 분류 로직)  ―  여기만 수정하면 됩니다
// ────────────────────────────────────────────────────────────────────────
//  이 파일은 "질문을 읽고 정상질문/학습상담/학습무관 중 무엇인지 판단"하는
//  로직만 담는다. 폴링 주기·답변대기 조회·seen/로그·토큰·거절 처리(PATCH) 같은
//  형식/인프라 코드는 전부 server.mjs(런타임) 쪽이며 여기서 건드리지 않는다.
//
//  분류 기준을 바꾸려면 아래 4가지만 손대면 된다:
//    1) MONITOR_SYS_PROMPT       — 분류 규칙(프롬프트). 무엇이 학습무관/상담/정상인가.
//    2) MONITOR_CONFIDENCE_THRESHOLD — 학습무관 자동거절 최소 신뢰도.
//    3) MONITOR_IMG_GUARD_MAXLEN — 이미지+짧은 본문을 LLM 없이 정상질문으로 볼 길이.
//    4) MONITOR_MODEL            — 분류에 쓰는 Claude 모델.
//  noteworthy: server.mjs는 classify()/shouldReject()/extractQuestionText()
//  인터페이스만 사용한다. 이 세 함수의 시그니처(입출력)는 유지할 것.
// ════════════════════════════════════════════════════════════════════════

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── 분류 기준 노브 ──────────────────────────────────────────────────────
export const MONITOR_MODEL = process.env.MONITOR_MODEL || 'claude-haiku-4-5';
export const MONITOR_CONFIDENCE_THRESHOLD = 0.85; // 학습무관 거절 최소 신뢰도 (고정밀: 오거절 방지)
export const MONITOR_IMG_GUARD_MAXLEN = 4;        // 이미지 첨부 + 본문 이 길이 이하(아주 짧은 캡션: "이거요" 등)면 LLM 없이 정상질문. 그 이상은 LLM이 판정(맛집/잡담 등 학습무관 포착, 예: "밥집 추천좀 해주세여")

// 라벨 (분류 결과 3종). 변경 시 server.mjs의 표시/통계 키도 함께 확인할 것.
export const LABELS = { OFFTOPIC: '학습무관', COUNSEL: '학습상담', NORMAL: '정상질문' };

// ── 분류 규칙 (프롬프트) ────────────────────────────────────────────────
export const MONITOR_SYS_PROMPT = [
  '너는 학원 TA(조교) 온라인 질문게시판의 분류기다. 학생 질문 한 건을 읽고 아래 3가지 중 하나로 분류한다.',
  '',
  '입력 형식(user 메시지)은 두 줄이다:',
  '  첨부 이미지: <장수 또는 "없음">',
  '  질문 본문: <학생이 입력한 텍스트>',
  '학생은 보통 문제를 사진으로 첨부하고 본문에는 짧은 설명·콘텐츠명·인사만 적는다. 첨부 이미지가 있으면 본문이 빈약해도 이미지 속 문제에 대한 질문이다.',
  '',
  '◆ 가장 중요한 대원칙 ◆',
  '"학습무관"은 본문에 "학습과 무관한 내용이 실제로 들어 있을 때"만 붙인다.',
  '본문이 짧거나, 빈약하거나, 출처·콘텐츠명·숫자만 있거나, 의미가 불명확한 것은 "학습무관"이 아니다 → "정상질문"이다.',
  '즉 "학습 내용이 없다"는 이유로 거절하면 안 된다. "학습과 무관한 내용이 있다"가 거절의 유일한 근거다. 애매하면 정상질문이다.',
  '',
  '판정 순서:',
  '',
  '1) "학습무관" (거절 대상) — 본문에 학습과 무관한 내용이 실제로 들어 있는 경우. 문제 질문이 앞에 있어도 아래가 섞이면 학습무관이다(override):',
  '   - TA/조교 신변·사담: "대면 티에이 이제 안 와요?", "방학 때 부엉이(자습실)에 얼마나 계셨어요?", 운동/건강/일정 잡담.',
  '   - 외부 콘텐츠 요청: 노래·곡·OST·뮤비 틀어/불러달라, 드라마·소설·웹툰·괴담 줄거리나 등장 소재 소개, 성대모사, 영상편지.',
  '   - 과목과 무관한 잡상식: 연예·스포츠 경기결과·시사·게임 등. (⚠️ 과목 지식·개념 질문은 여기 아님 → 정상질문. 아래 3 참고.)',
  '   - 생활 잡담: 맛집/점심 추천, 연애 상담, 프로필사진·신변 독백, 학습과 무관한 단순 잡담.',
  '',
  '2) "학습상담" (거절 안 함) — 특정 문제·개념 자체가 아니라, 공부를 "어떻게/어디서" 할지에 대한 상담·안내:',
  '   - 공부법·학습 방향·계획·성적·멘탈 상담, 컨텐츠/n제/강사 추천·비교.',
  '   - 입시 문의: 지원 가능 대학, 입결·백분위·가산점 비교, 정시/수시 전략.',
  '   - 콘텐츠·자료·강의의 위치/접근 방법, 자료 정리 요청.',
  '   ※ 단, 특정 개념·단원의 원리·판단법을 "설명/정리해 달라"거나, 특정 강사 풀이로 풀어달라/영상 설명 요청은 학습상담이 아니라 정상질문이다(아래 3).',
  '',
  '3) "정상질문" (거절 안 함) — 위 1·2가 아닌 나머지 전부. 특히 다음은 무조건 정상질문이다:',
  '   - 특정 문제·지문·선지 풀이/개념 질문, 풀이 영상 요청, 작품의 표현법·개념 판단(예: "이 구절 독백체야 대화체야").',
  '   - 특정 개념·단원의 원리·판단법을 설명·정리해 달라는 요청도 정상질문(문제 이미지 없어도). 예: "합성함수 극대/극소 판단법 알려줘", "이 단원 개념 정리해줘".',
  '   - 특정 강사·쌤 풀이법으로 풀어달라/그 풀이를 영상으로 설명해줄 TA가 있냐는 요청도 정상질문. 예: "연호쌤 스캔풀이로 풀어주실 TA 계실까요".',
  '   - 과목(국어·수학·영어·물리·화학·생명·지구과학·사회 등) 지식·개념·사실 질문은 특정 교재·회차·문제와 연결 안 돼도 정상질문. 예: "남극엔 간접순환 없지?", "우주의 나이는?", "이 영단어 뜻". 과목 내용이면 학습무관 아님.',
  '   - 첨부 이미지가 1장 이상이고 본문이 짧거나 비어 있으면(또는 풀이 요청·인사뿐이면) 정상질문. 단, 본문에 명백한 학습무관 내용(맛집/잡담/외부콘텐츠 등)이 있으면 이미지가 있어도 학습무관이다(1의 override).',
  '   - 콘텐츠/교재/회차/과목명만 적은 것: "브릿지", "서바이벌N", "시대기출", "교육청", "수2", "n제".',
  '   - 6자리/8자리 숫자 = 기출 출처 표기다(예: "241103" = 24학년도 수능 3번; 수능은 11월). 정상질문.',
  '   - 본문 밖(이미지)에 질문이 있음을 암시: "문제에 질문 같이 썼어요", "질문 적어뒀습니다", "사진에 적었어요".',
  '   - 인사·막연한 요청·짧은 단편 입력: "안녕하세요 풀이 부탁드립니다", "어떻게 해야 해?", "자세하게 설명해주세요", "도와주세요", "답이 뭐예요", "." 나 "d" 같은 한두 글자.',
  '',
  '반드시 아래 JSON 한 줄만 출력한다(다른 말 금지):',
  '{"label":"학습무관|학습상담|정상질문","confidence":0~1 사이 숫자,"reason":"짧은 근거"}',
].join('\n');

// ── 질문 본문 추출 (질문을 "읽는" 부분) ─────────────────────────────────
// 실제 질문 텍스트는 questionContent에 들어있음.
// (list 축약본 대비 상세의 questionContent를 우선. 폴백: questionDetails[].questionContsNm)
export function extractQuestionText(obj) {
  if (!obj) return '';
  if (typeof obj.questionContent === 'string' && obj.questionContent.trim()) return obj.questionContent.trim();
  const qd = obj.questionDetails && obj.questionDetails[0];
  if (qd) {
    if (typeof qd.questionContent === 'string' && qd.questionContent.trim()) return qd.questionContent.trim();
    if (typeof qd.questionContsNm === 'string' && qd.questionContsNm.trim()) return qd.questionContsNm.trim();
  }
  return '';
}

// ── LLM 분류 1회 (프롬프트 적용 + 응답 파싱) ────────────────────────────
async function classifyViaLLM(text, imageCount = 0) {
  if (!ANTHROPIC_API_KEY) throw new Error('NO_API_KEY');
  const userContent = `첨부 이미지: ${imageCount > 0 ? imageCount + '장' : '없음'}\n질문 본문: ${text}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MONITOR_MODEL,
      max_tokens: 200,
      system: MONITOR_SYS_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`anthropic ${res.status} ${t.slice(0, 150)}`); }
  const body = await res.json();
  const out = (body.content || []).map(b => b.text || '').join('');
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('파싱 실패');
  const j = JSON.parse(m[0]);
  return { label: j.label, confidence: Number(j.confidence) || 0, reason: j.reason || '' };
}

// ── 분류 1건 (메인 진입점) ──────────────────────────────────────────────
// 이미지 가드 후 LLM. tick·백테스트 공용. → {label, confidence, reason, viaLLM}
// 빈 본문 또는 (이미지 첨부 + 아주 짧은 본문)은 이미지 속 문제 질문이므로 LLM 없이 정상질문.
export async function classify(text, imageCount) {
  if (!text) {
    return { label: LABELS.NORMAL, confidence: 1, reason: imageCount > 0 ? `이미지 ${imageCount}장 첨부(본문 없음)` : '빈 텍스트', viaLLM: false };
  }
  if (imageCount > 0 && text.length <= MONITOR_IMG_GUARD_MAXLEN) {
    return { label: LABELS.NORMAL, confidence: 1, reason: `이미지 ${imageCount}장 + 짧은 본문(${text.length}자) → 이미지 질문`, viaLLM: false };
  }
  const c = await classifyViaLLM(text, imageCount);
  return { ...c, viaLLM: true };
}

// ── 거절 판정 ───────────────────────────────────────────────────────────
// 분류 결과가 "자동 거절 대상"인지. 학습무관 + 신뢰도 임계 이상.
export function shouldReject(c) {
  return !!c && c.label === LABELS.OFFTOPIC && (Number(c.confidence) || 0) >= MONITOR_CONFIDENCE_THRESHOLD;
}
