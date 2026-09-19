---
name: design-brief
description: >-
  corral 앱의 디자인 브리프와 수정 요청 프롬프트를 작성한다. 사용자가 외부 Claude Design에
  전달할 specs의 design-brief.md를 코디네이터(Claude Code 또는 Codex)가 쓴다.
  "디자인 브리프 써줘", "Claude Design에 줄 프롬프트 만들어줘", "UI 디자인 하자" 요청에 사용한다.
  화면 인벤토리·렌더러·레퍼런스·토큰을 확인하고 6섹션 브리프와 핸드오프 형식을 정의한다.
  직접 디자인을 그리지 않으며, 돌아온 산출물 이관은 design-intake가 담당한다.
---

# Design — Brief (Claude Design에 줄 브리프)

디자인은 **Claude Design(claude.ai/design)에서** 그린다. 이 스킬은 *그리기 직전의 입력*을 만든다 — 산출물 하나,
`specs/LIFE-NNN-<슬러그>/design-brief.md`(붙여넣기용). cpm-macro `design-brief`를 corral(단일 표면 =
**Electron 데스크톱 앱**)에 맞게 축소·조정한 것 — `_canon`(캐논 마스터)·`design-screens.md`(누적 마스터 스펙)는
corral엔 아직 화면이 몇 개 안 되고 다회차 병합 수요가 없어 **뺐다** (2026-09-13 판단, 필요해지면 나중에 추가).

> 흐름: 화면 인벤토리(`specs/app-screens.md`) → **design-brief** → [Claude Design 외부, 사용자가 전달] →
> `design-intake`(specs/ 이관) → 구현(AGENTS.md 작업 플로우).

## Phase 0 — 컨텍스트

1. **LIFE-N 확정**(미명시면 1번 묻기). 작업 브랜치·worktree 가 있으면 그 안에서 진행(`task-start` 로 이미 파둔 것 전제).
2. **선행 게이트**: `specs/app-screens.md`(현재 화면 인벤토리 — 화면 목록·상태·버튼·데이터)가 없으면 브리프
   직행 X → 사용자와 먼저 정리해 커밋. 있으면 통과. 화면 인벤토리 없이 쓴 브리프는 corral에 없는 구조
   (예: 서버형 대시보드, 브라우저 탭)가 돌아온다.
3. **분석 문서가 있으면 인용**: `specs/LIFE-NNN-*/00-analysis.md`(모르는 것 목록)가 이미 있으면 그걸 브리프
   근거로 쓴다 — 없으면 이 스킬이 브리프를 쓰기 전에 최소한 "이 화면이 왜 필요한가"를 사용자와 확인한다.

## Phase 1 — 그라운딩 (브리프 전 항상)

추측 금지 — 아래를 실제로 읽고 브리프에 인용:

- `specs/app-screens.md` — 화면·상태·버튼·데이터 (없으면 Phase 0 게이트에서 먼저 만든다).
- 현재 렌더러 코드 — `app/src/renderer/src/App.tsx` · `TerminalPane.tsx` · `styles.css` (실제 구조·현재 없는 것을
  추측하지 말고 읽어서 인용).
- 디자인 시스템 앵커 — `specs/design-tokens.css`(있으면 — 새 색 만들지 말 것. 없으면 "이번에 만든다, CSS
  변수로"라고 브리프에 명시).
- **Orca/herdr-studio 레퍼런스** (corral 특유 — 참고 모델 축은 `specs/00-project.md` "방향 결정
  (2026-09-13)" 참고: **UI/UX 는 Orca, 엔진/데이터모델은 herdr-studio**):
  `specs/reference/layout-reference-2026-09-13.md` ·
  `specs/reference/settings-shortcuts-palette-reference-2026-09-13.md` ·
  `specs/reference/secondary-features-reference-2026-09-13.md` (관련 스텝에 해당하는 문서만 인용).
- herdr 어댑터 경계 — `app/src/main/adapter/`. UI 층으로 herdr 타입(`PaneInfo`·`AgentStatus` 등)이 새면 안
  된다는 게 corral 의 고정 아키텍처 제약이다(`00-project.md` 헤지 #1) — 디자인이 이 경계를 건너는 데이터를
  요구하면 브리프 §5(열린 질문)나 §6(범위 밖)에서 짚는다.

## Phase 2 — 브리프 작성 (6섹션 골격)

`specs/LIFE-NNN-<슬러그>/design-brief.md` — 헤더에 *"Claude Design에 붙여넣는 브리프, 산출물은
design-intake로 specs/ 이관"* 명시:

1. **제품 컨텍스트** — herdr 기반 AI 워크스페이스의 **설치형 Electron 데스크톱 앱**(단일 창). **고정
   제약**(매 브리프 반복): 화면 계층은 `repo → worktree(workspace) → tab → pane` 4단(LIFE-344 확정, 안
   바뀜) · 터미널 렌더링은 xterm.js(endpoint 스트리밍, R2 완료) · herdr 타입은 어댑터 경계를 못 넘음 ·
   브라우저 탭·URL·로그인·서버 없음 · 톤 = 에이전트 세션 워크스페이스답게 정보 밀도·상태 판별 우선, 장식 최소.
2. **JTBD / 이 일감이 만드는 것** — 인용형 문장(사용자 원문 우선, 예: "Orca/herdr-studio 랑 같이 쓸 수
   있을 정도의 UIUX 는 갖춰야 한다" 2026-09-13).
3. **디자인할 화면 (A/B/C…, ★ 핵심)** — 화면별 [현재 상태 → 디자인 거리 → 검토 포인트]. 상태(연결중/정상/
   재동기/거절 등, `link.phase`)마다 눌러도 되는 액션을 명시. **한 브리프에 화면을 너무 많이 담지 않는다** —
   해당 Step(`00-project.md` Step 4~10)이 다루는 범위만.
4. **디자인 시스템 앵커** — 토큰 파일 그대로(없으면 "이번에 만든다"), Orca/herdr-studio 레퍼런스 문서의
   구체적 패턴(파일:줄 근거) 인용, 컴포넌트 관용(모달 최소, 종료·삭제 같은 되돌릴 수 없는 동작은 확인 게이트).
5. **열린 디자인 질문** — **걱정거리와 제약을 주고 안은 저쪽이 낸다**. "A/B/C 중 골라달라"가 아니라
   *"이런 게 걱정된다 · 이건 못 바꾼다(화면 계층·어댑터 경계) — 풀어서 2~3안 제안해달라"*. 코디네이터가
   떠올린 해법은 **브리프에 넣지 않는다**. 예시 스크린샷이 도움될 화면이면 여기서 "예시 스크린샷을
   함께 보내주시면 좋습니다"를 사용자에게 명시적으로 요청한다.
6. **범위 밖 (안 그림)** — 별도 Step/LIFE로 분리할 것.

## 핸드오프 형식 계약 (FORWARD — ★형식 권위)

브리프 끝에 **"이 형식으로 돌려달라"**를 박는다. `design-intake`의 수신 계약은 이걸 거울처럼 받는다
(불일치 시 여기가 우선).

**돌려받을 핸드오프 = `screens/desktop/`(hi-fi 목업 `.dc.html`, + `support.js` 동반) + `design-handoff.md`.**
탐색안은 안 보내도 된다(원하면 `explorations/`에 남겨도 되지만 corral 은 이관 안 함).

- 파일·폴더명 kebab-case.
- **머리말 3줄**: 수신=`design-intake` · 결정 근거 경로(`00-analysis.md`/`specs/app-screens.md` 등) ·
  `surface: desktop`.
- **5섹션** (cpm-macro 6섹션에서 §3 `design-screens.md` diff 는 corral 에 그 문서가 없어 뺐다):
  §0 산출 파일 · §1 채택 결정(§5 열린 질문에 대한 답 포함) · §2 컴포넌트 스펙(상태×토큰) ·
  §3 토큰 diff(원칙 0, 신규면 CSS 변수로) · §4 동작 계약(design 관점 — 버튼이 부르는 어댑터 동작;
  IPC 타입 이름은 `app/src/shared/types.ts` 가 권위).

> 골격(5섹션·머리말·kebab·`screens/desktop`)은 스킬 소유 = 제품 무관. 제품 특정값(토큰·화면·제약 문구)은
> `specs/`.

## Phase 3 — 매듭

- 브리프 커밋(작업 브랜치, `design(LIFE-NNN): brief`).
- 채팅에 **요약 표**(화면 A/B/C + 핵심 디자인 질문) + "이 파일을 Claude Design `tickets/LIFE-NNN/brief.md`로
  붙여넣기" 안내.
- **왕복**: 디자인이 돌아와 리뷰 후 수정이 필요하면 같은 파일에 `## 수정 요청 N (날짜)` 절을 append해 다시
  붙여넣기용으로 준다 — IPC 타입 이름·화면 계층이 코드와 어긋난 것 / herdr 타입이 UI 층으로 새어나온 것 /
  없는 기능을 표로.

## 안 하는 것

- 디자인을 그리지 않는다. 목업 생성 X. 화면 인벤토리 없이 브리프 X.
- **해법 안을 미리 만들어 보내지 않는다** — 브리프가 나르는 건 문제·걱정·제약이지 내 설계안이 아니다.
- `_canon`·`design-screens.md` 를 만들지 않는다 — 여러 티켓에 걸친 마스터 병합이 실제로 필요해지기 전엔
  (예: 같은 화면이 3회 이상 재디자인되는 시점) 추가하지 않는다.
- 서버·클라우드·로그인 전제의 화면을 요청하지 않는다.

## 전환

- 화면 인벤토리 → 이 스킬 Phase 0 게이트에서 같이. 핸드오프 받으면 "디자인 받았어" → `design-intake`.
  구현 → AGENTS.md 작업 플로우(분석→기준→구현, 이미 끝났으면 바로 구현).
