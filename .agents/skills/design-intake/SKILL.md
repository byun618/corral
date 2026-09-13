---
name: design-intake
description: Claude Design(claude.ai/design)에서 돌아온 corral 앱 디자인 핸드오프(`design-handoff.md` +
  `screens/desktop/` 목업 + 토큰)를 `specs/`로 이관·완결성 검증·코드 정합성 체크(IPC 타입 이름·화면 계층·
  herdr 경계 누출). 디자인은 외부에서 그리고 결과물만 들인다. 트리거 예시 — "디자인 받았어" / "핸드오프
  이관해줘" / "목업 들어왔어" / "design 산출물 반영" / "specs에 디자인 넣자". 그리기 X(Claude Design),
  브리프 → `design-brief`, 구현 → AGENTS.md 작업 플로우.
---

# Design — Intake (핸드오프 이관)

Claude Design 결과물을 `specs/` 정규 위치로 **이관·검증·등록**해 구현이 시각 ground truth로 쓰게 만든다.
cpm-macro `design-intake` 축소판 — 표면은 `desktop` 하나, `_canon`·`design-screens.md` 는 corral 에 없다
(2026-09-13, 다회차 병합 수요가 생기기 전엔 안 만듦 — `design-brief` 참고).

## 입력 계약 (고정) = `design-brief` forward 계약의 거울

- **수령 본문 = `specs/LIFE-NNN-<슬러그>/design-handoff.md`** (사용자가 Claude Design 산출물을 그대로
  붙여넣음). 머리말 3줄(수신=`design-intake` · 결정 근거 경로 · `surface: desktop`) + 5섹션(§0 산출 파일 ·
  §1 채택 결정 · §2 컴포넌트 스펙 · §3 토큰 diff · §4 동작 계약).
- **본체 = `screens/desktop/*.dc.html`(+`support.js`)** — 경로/다운로드 폴더/붙여넣기 중 어떻게 주는지
  확인.
- 머리말이 어긋나거나 `surface`가 없으면 사용자에게 확인(추측 X).

## specs/ 정규 위치

| 산출물 | 위치 | 역할 |
|---|---|---|
| 디자인 토큰 | `specs/design-tokens.css` | CSS 변수(색/타입/스페이스/radius). **원본** — `app/src/renderer/`는 이걸 import, hex 직접 X |
| hi-fi 목업 | `specs/LIFE-NNN-<슬러그>/mockups/desktop/` | 이 티켓의 채택 목업 그대로 보관(별도 캐논 이관 없음) |
| 핸드오프 원본 | `specs/LIFE-NNN-<슬러그>/design-handoff.md` | 그대로 둔다 (인덱스 역할) |

> 화면이 여러 티켓에 걸쳐 반복 재디자인되는 지점이 오면 그때 `specs/mockups/_canon/desktop/` 같은
> 캐논 폴더를 새로 판단한다 — 지금은 티켓별 보관으로 충분(2026-09-13 판단, `00-project.md` 참고).

## 절차

1. **수령** — `design-handoff.md` 머리말 읽기 → 들어온 것 목록화(목업? 토큰? 없는 건 무엇인지).
2. **완결성** — 완결 번들 = 토큰(신규 있으면) + 목업(+`support.js` 동반) + 동작 계약. 빠진 게 있으면 보고.
3. **이관** — 토큰 → `specs/design-tokens.css`(기존과 diff, 값 변경 시 UI 재도입 필요 표시) / 목업 →
   `specs/LIFE-NNN-<슬러그>/mockups/desktop/`.
4. **코드 정합성 체크(corral 특유)** — 표로 사용자에게:
   - 화면 계층이 `repo → worktree → tab → pane` 4단(LIFE-344 확정)과 맞나 — 디자인이 이걸 흐트러뜨렸나.
   - 버튼이 부르는 동작이 실제 어댑터 메서드(`app/src/main/adapter/`)에 있나 — 없는 액션을 그렸나.
   - IPC 로 넘어오는 필드 이름이 `app/src/shared/types.ts`(`PaneRow`·`TabRow`·`WorktreeRow` 등)와
     일치하나.
   - **herdr 자체 타입(`PaneInfo`·`AgentStatus` 등)이 UI 카피·라벨에 그대로 노출됐나** → 있으면 어댑터
     경계 위반, 수정 요청 대상 (`00-project.md` 헤지 #1).
   - 서버·클라우드·로그인 전제가 섞였나 → 있으면 수정 요청 대상.
   - 없는 기능을 그렸나(다음 Step 영역이면 표기하고 이번 이관에서는 반영 보류).
   - 어긋난 항목은 `design-brief` 스킬의 "수정 요청 N" 절로 넘겨 다시 붙여넣기 프롬프트를 만든다.
5. **등록** — 커밋 `design(LIFE-NNN): intake — <요약>`. 사용자에게 이관 요약 1줄 + "이제 구현 — 렌더러가
   목업을 보고 재구현(복사 X)".

## 안 하는 것

- 디자인을 그리지 않는다. 목업 `.dc.html`을 렌더러에 그대로 복사 X(재구현). `_canon`·`design-screens.md`
  를 만들지 않는다.

## 전환

- 수정 필요 → `design-brief`(수정 요청 프롬프트). 이관 끝 → 구현(AGENTS.md 작업 플로우, 이미 분석·기준이
  끝나 있으면 바로 구현 단계).
