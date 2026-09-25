---
name: task-coordinate
description: >-
  corral 작업 코디네이터 절차. 작업 worktree의 Claude 또는 Codex 코디네이터가 킥오프 직후 읽는다.
  분석·판정 기준·킥오프 승인·단독 구현·3자 코드 리뷰·판정·세 승인 게이트·본체 마무리 인계를 다룬다.
  corral orchestration으로 워커 기동·완료 감지·질의응답을 처리한다.
---

# task-coordinate — 코디네이터 절차 (작업 worktree 세션에서 실행)

전제: task-start 가 만든 작업 worktree(`.claude/worktrees/LIFE-NNN-<슬러그>/`, 작업 브랜치 체크아웃) 안이다.
원칙은 AGENTS.md, 완료 조건은 `.agents/rules/validation.md`. 문서 산출물은 전부 작업 브랜치에 커밋한다.

## 0. 실제 코디네이터 세션 확인

- `specs/LIFE-NNN-<슬러그>/00-start.md`의 코디네이터·모델/effort·worktree를 확인한다.
  현재 세션과 기록이 다르면 작업을 시작하지 말고 `00-start.md`에 불일치를 기록하고 사용자에게 보고한다.
  재개 시 기존 Run·워커·승인 상태부터 확인하고 중복 기동하지 않는다.
- **이 세션에서** LA `issue_by_seq` 조회, 웹 검색 도구의 사용 가능 여부, `grok-search` 본문 읽기,
  `command -v grok`, `corral status --json`을 확인한다. 시작 세션에서 됐다는 이유로 생략하지 않는다.
  MCP를 새로 등록했다면 실제 호출 도구로 나타나는지도 확인한다. 인증값은 문서·프롬프트에 적지 않는다.
- 빠진 도구·권한은 설정을 점검하고 남은 차단 사유를 시작 기록·사용자에게 보고한다. 임의로 다른
  코디네이터로 바꾸거나 필수 리뷰를 생략하지 않는다.
- 통과하면 `00-start.md`를 `준비 완료`로 갱신·커밋한다. 코디네이터 선택은 구현자·리뷰어 구성을 바꾸지
  않는다 — 분석·기준·판정은 코디네이터, 구현은 별도 워커다.
- `.agents/rules/` 를 단계마다 읽는다: 글 전 writing.md, 코드 전 coding.md, 완료 판정 전 validation.md.
  디렉터리의 자동 로딩 여부에 기대지 않는다.

## LA 상태 전이 (life-assistant `issue_transition`, forward-only)

분석 시작 → "분석 중" / 구현 시작 → "개발 중" / 코드 리뷰 → "검증 중" / main 머지 후 → "완료"
코드 리뷰 중 수정 라운드도 LA는 "검증 중"을 유지하고 세부 단계는 specs에 기록한다 (forward-only라 개발 중으로 돌아갈 수 없다).

## 1. 분석 — 4박자 (외부 서치가 수 분 걸리므로 순차가 아니라 겹친다)

1. **일감 본문 확보**: `issue_by_seq` 로 LIFE-N 상세를 읽는다. `specs/LIFE-NNN-<슬러그>/` 생성
2. **외부 서치 먼저 띄운다**: 코디네이터의 웹 검색(Claude Code는 WebSearch/WebFetch, Codex는 제공된
   웹 검색·페이지 열기 도구)으로 개요를 깔고, grok은 corral pane 으로 병렬 위임한다 —
   `corral terminal create --agent grok --worktree path:<작업 worktree 절대경로> --title "grok: <주제>" --json`
   → `wait --for agent-ready` → `prompt --wait accepted` → 결과를 파일로 저장시키고 `terminal read`로 회수.
   **전역 grok-search 스킬에서는 리서치 규칙만 가져온다**(날짜 명시·파일 저장·호스트 검색과 대조) —
   그 스킬의 대화형 경로는 이전 제어 도구 명령이라 따르지 않는다. grok 결과는 자체 검색과 대조해 귀속한다.
3. **서치 대기 중 기준 초안** 작성 (§2)
4. **서치 취합 → 기준 확정**: 서치 결과가 기준을 바꿀 수 있다. 기준 freeze는 *킥오프 승인 시점*이다
- **선행 문서의 사실 주장을 대조표로 검증한다** — 일감 본문·00-project.md 의 전제가 틀렸을 수 있다
  (LIFE-342 에서 5건 중 2건 오류 발견). 산출물: `00-analysis.md` (+ 외부 서치 원문 `00-analysis-grok.md`)
- 절차가 이 스킬과 어긋나면 `00-analysis.md` 의 "절차 어긋남" 섹션에 누적 기록한다 (스킬 개정 재료)
- **UI 비중이 큰 일감이면 `design-brief`/`design-intake` 삽입 여부를 검토한다** — 비주얼 디테일이 판정
  기준에 안 잡히면 목업 없이 구현자 재량에 맡길 때 재작업 위험이 있다 (LIFE-357 판단 뒤집음, 2026-09-13).
  넣으면 `specs/app-screens.md`(없으면 먼저) → `design-brief` → 외부 Claude Design → `design-intake` →
  그 결과로 `01-criteria.md`/`02-kickoff.md` freeze. 안 넣으면 사유를 `00-analysis.md` 에 한 줄 (판단 없이 생략 금지)

## 2. 판정 기준 — `01-criteria.md`

- 항목별 통과선 + **필수 관문**: ① 실제 실행 + 재현 가능한 원자료 ② 추측 판정 금지 (실행 없는 칸 = 항목 무효)
  ③ **통과선을 낮춰 통과시킨 흔적이 없을 것** (LIFE-342 탈락 사유가 이것이었다)
  ④ **네이티브 실행**: 사용자의 네이티브 설치 경로에서 최소 1회 실행한 원자료가 있어야 통과로 센다.
     격리 인스턴스·fixture 실행만으로는 세지 않는다 — LIFE-394 의 높음 결함(네이티브 전경 프로세스
     이름이 격리 실행과 달라 기동 판정이 뒤집힘)이 정확히 이 경로로 3자 리뷰를 통과해 샜다
- 기준 없이 구현 시작 금지

## 3. 킥오프 문서 — `02-kickoff.md` (구현 워커와 리뷰어의 공통 기준)

- **설계는 워커가 흡수한다.** 코디네이터는 범위·제약·물류·검토 절차를 정하고, 구조·라이브러리·계측은
  워커 재량이다. 별도 설계 문서·설계 리뷰 단계는 없고 접근 타당성은 코드 리뷰에서 함께 본다.
- 정체 표: 브랜치 / worktree / 격리 리소스(예: herdr 세션명) / 원자료 경로 / 결과 파일
- `00-start.md`의 코디네이터 선택과 지정 모델·effort를 정체 표에 옮긴다(재선택 금지). 구현 워커·native
  advisor·코드 리뷰어 3자의 모델/effort와 실제 명령을 구분하고 handle/브랜치 실제 반환값도 기록한다.
  **Codex 워커·리뷰어는 모델·effort를 명령에 명시한다** — 없으면 세션 기본. advisor는 독립 effort가 없다.
- **경쟁 구현을 쓸 경우 발동 근거를 여기에 적는다** (defaults.md 의 4개 조건 중 무엇인지).
  적지 않으면 단독이다.
- **격리 규칙**: 사용자가 실제 쓰는 리소스(default 세션·소켓 등)를 건드리지 않는다.
  외부 도구 실측은 전용 격리 인스턴스에서. 상대 브랜치 보지 않기, 작업 브랜치에 커밋하지 않기
- **격리 기동에 "헤드리스는 안 된다" 고 단정하지 않는다** — 정확히는 *TTY 가 없으면* 안 되는 것이고
  `script(1)` 류 PTY 래퍼 경로가 있다. LIFE-344 에서 herdr 세션 기동이 Orca 탭 경로 61.5초 · PTY 경로 53ms 로
  갈렸다 — 재기동 시간이 통과선에 들면 이 차이가 판정을 뒤집는다 (각 1회 측정, 자릿수로만 쓴다).
- 원자료 규칙: 로그·스냅샷·타이밍 원본을 `specs/LIFE-NNN-*/raw/<도구>/` 에 커밋한다 — 판정표 "근거" 칸이 가리킬 실물이 없으면 그 항목은 무효
- **결과 문서**: 전부 커밋 + `raw/<도구>/DONE.md` (한 줄 요약 + 미완 목록) — 이건 감사 추적용
  기록이지 프로세스 완료 감지 신호가 아니다. 완료 감지는 §4 의 orchestration `worker_done` 메시지로
  한다. "커밋되지 않은 결과는 없는 것이다"

## ⛔ 승인 게이트 ⓪ — 킥오프 (§3 후 · §4 전, worker-start 금지 지점)

00-analysis · 01-criteria · 02-kickoff 를 커밋한 뒤 사용자에게 보고하고 **멈춘다**:

- **문제 정의·범위**: 뭘 구현하기로 했고, 뭘 명시적으로 뺐는지 (분석에서 좁힌 결과)
- **판정 기준 요약**: 01-criteria 통과선 핵심 몇 줄
- **진행 방식**: 단독 구현(또는 경쟁 발동 근거), 역할별 모델/effort·advisor, 디자인 브리프 삽입 여부와 사유

승인이 오면 §4 로 진행한다. 지적이 나오면 문서를 고쳐 재보고한다 — 기준 freeze 는 이 승인
시점이다. 기존 사용자 승인 범위·기준이 바뀌면 구현을 멈추고 갱신 문서를 커밋해 재승인을 받는다. (게이트 ⓪ 신설 2026-09-20 — 가장 비싼 구간인 구현 전에
방향 오류를 잡는다. LIFE-342 전제 오류·LIFE-357 디자인 판단 번복이 근거)

## 4. 구현

2026-09-22 신규 기본. 코디네이터 설정은 task-start/00-start.md 그대로 유지한다.

역할 기본값은 [task-start/defaults.md](../task-start/defaults.md) 한 곳에서 관리하고, 실제 작업은
`00-start.md`의 전체 역할 구성을 따른다(설정 재질문 금지). 워커는 수정 라운드까지 유지, 리뷰 3자는 별도 세션.

**설계 단계는 없다.** 워커가 접근을 정하고 바로 구현하며, 설계 문서·독립 설계 리뷰·설계 판정을 만들지
않는다. 타당성은 §5 에서 본다. (LIFE-394 에서 설계 리뷰만 4라운드가 돌았고 매 라운드 새 높음 지적이
나왔으며 기각은 0이었다. 대조군 LIFE-393 은 설계 단계 없이 리뷰 1라운드로 끝났다.)

Claude의 `opus`/`fable` alias가 해소된 실제 버전과 advisor 활성화를 확인한다 — provider 프로세스·argv는
`terminal show`(dispatch 스냅샷은 기동 시점 관측이라 `resolvedModel: null`), 배너는 `terminal read`. 모델
접근·사용량으로 기동할 수 없으면 차단을 보고한다 — advisor를 조용히 빼거나 다른 모델로 대체하지 않고, 기존 작업의 승인된 구성은 소급 변경하지 않는다.

**기동 전 [구현 워커 실행 절차](references/implementation.md)를 읽는다** — advisor 기동, 워커 보존·재사용·
종료, 단계 산출물의 명령 수준 계약이 거기 있다. 경쟁 구현이면 후보별 구현·리뷰·판정 파일과 리뷰 세션을
분리하고, 각 후보가 같은 기준을 받되 상대 구현·리뷰·판정을 워커에게 공유하지 않는다.

### 4.1 구현 지시와 진행

- 킥오프 승인 후 `implement` Task를 발급한다. 워커는 구현 브랜치에서 구현·검증하고
  제품·raw를 커밋한 뒤 `worker_done`으로 보고한다.
- Task spec에 고정한 기준 commit 경로, 원자료 규칙, **네이티브 실행 관문**을 명시한다.
  격리 인스턴스만으로 통과 보고하지 않도록 지시한다.
- 구현 중 승인된 범위·기준이 바뀌어야 하면 워커는 근거를 커밋하고 `ask`로 멈춘다.
  코디네이터는 범위·기준 변경이면 사용자 재승인으로 돌아가고, 그 외는 판단해 `reply`로 재개시킨다.
  세부 코드·구조 선택은 워커 재량이다.
- 구현 완료 후 수정 라운드를 위해 워커를 retain 한다.

### 4.2 완료·질문·복구 공통 규칙

먼저 `corral agent-context --json`으로 플래그를, `app/cli/README.md`로 계약을 확인하고 Run/Task/Dispatch를
기록한다 — 설치판 스킬 문서에 해당하는 것은 corral에 **없고** 이 두 곳이 전부다. 완료는 파일 존재나
TUI idle이 아니라 해당 Task/Dispatch의 `worker_done`으로 확인하며, `succeeded`/`failed` 모두 종료 보고다(failed를 성공으로 처리하지 않는다).

```bash
corral orchestration check --block --types worker_done,escalation,question --timeout-ms 60000 --json
corral orchestration reply --id <msg_id> --body <답> --json
```

배치의 모든 메시지를 처리하고 각 종료 워커의 재사용/retain/release를 결정한 뒤
`check --ack <delivery_id> --block ...`로 이어간다 — `--ack`는 대기 시작 **전에 1회만** 적용된다. 같은 Run의
check를 중복 실행하지 않는다. `--timeout-ms` 상한은 `check`·`ask`만 600000(`--block` 여부와 무관),
나머지는 120000이다. timeout/count:0은 새 워커를 만드는 근거가 아니고, 응답 유실은
request-show·worker-show로 기존 요청/실행을 확인한다. 실행 중 worker에 release하지 않으며
`release.state: unknown`을 terminal close로 우회하지 않는다.
구현 브랜치가 살아 있는 동안 작업 브랜치 rebase 금지. 모든 worktree는 형제 폴더다.

## 5. 독립 코드 리뷰 — 3자 (Codex Astra xhigh · Claude Opus high · Grok)

- `.agents/agents/reviewer.md`를 먼저 읽는다. 3자는 서로, 그리고 구현자·코디네이터와 각각 별도 세션이며 고정 구현 commit과 실제 실행 원자료를 검토한다. 설계 문서는 없으므로 접근 타당성도 여기서 본다.
- 기동:
  - Codex — `worker-start --task <review_task> --agent codex --model gpt-6-astra --effort xhigh --worktree path:<구현 worktree 절대경로> --timeout-ms 120000` (§8 codex 주의)
  - Claude — 같은 형태로 `--agent claude --model claude-opus-5 --effort high` (별도 세션)
  - Grok — §1 의 `terminal create --agent grok` 경로를 리뷰 주제로 쓴다
  `--agent`에는 `--worktree`가 필수다(없으면 거절). 리뷰어 3명은 **Task를 각각 따로 발급**한다 —
  같은 Task로 띄우면 미확정 attempt(`promptRequestId: null`)만 조용히 재개되고, 이미 주입된 attempt가 열려 있으면 `dispatch_active`로 거절된다. 리뷰어는 제품 파일을 수정하지 않는다.
- 결과는 `review-codex.md`·`review-claude.md`·`review-grok.md` — 자기 관측/미실행과 다른 리뷰 근거를 구분하고 코디네이터가 보고서를 작업 브랜치에 회수·커밋한다. 리뷰 중 구현자는 제품 변경을 멈춘다.
- 세 리뷰 모두 코드 정확성·기준 충족·실행 근거를 보고 Grok은 외부 사실을 추가 대조한다.
  **구현자와 같은 도구의 리뷰어도 둔다** — 새 세션이면 검출력이 유지된다. 자기 구현분 기각은 사유를 상세히.
- **수정 라운드의 재리뷰는 반드시 새 리뷰 세션으로 기동한다.** 이전 리뷰 세션을 이어 쓰지 않는다
  (LIFE-394 는 같은 Codex 세션을 4라운드 재사용했다).
- 코드 수정 라운드는 같은 구현 워커에 새 Task/Dispatch로 이어 맡기며 §4.2의 대기·ACK를 따른다. 미해결 지적을 추적하고 세션 보존·정리는 실행 절차를 따른다.

## 6. 취합·판정 — `verdict.md`

- **리뷰·구현 raw/를 작업 브랜치로 회수한다** — 채택 머지와 분리해 문서만 커밋한다. 경쟁이면 탈락
  후보 raw도 보존한다. 구현자의 파일을 코디네이터가 직접 고치지 않는다.
- 구현 HEAD를 `LIFE-NNN-<도구>-final`로 고정한다. 단독 구현에 비교 승자/탈락 후보를 꾸며 쓰지 않는다.
- **단일 리뷰어 지적을 다수결로 기각하지 않는다. 전원 침묵을 통과 근거로 쓰지 않는다**
  (LIFE-394 에서 3자가 모두 놓친 높음 결함을 게이트 ① 사용자 확인이 잡았다).
- **codex 의 "구조를 버리고 다시 쓰라" 류 지적은 코디네이터가 독립 재현한 뒤 채택한다.**
- **advisor 조언은 지적이 아니다** — diff 에서 재현 가능한 것만 지적으로 세고,
  advisor 동의를 교차 확인 근거로 쓰지 않는다.
- 기각·탈락엔 사유 기록, 자기 구현분 지적 기각은 특히 상세히.
  경쟁이면 자기 구현 브랜치에 대한 자기 리뷰는 승자 판정 근거로 세지 않는다.
- 수렴: 높음+중간 0건 → 낮음 모아 1회 수정 후 종료. 수정 상한 3회

## 7. ⛔ 승인 게이트 ① — 채택

판정 결과를 사용자에게 보고하고 **멈춘다**. 이 시점엔 머지 0건 — 채택안 변경·추가 수정 요구가 가능하다. 조용한 완료 금지.

## 8. (채택 승인 후) 작업 브랜치 머지 → 사용자 확인 → ⛔ 승인 게이트 ② — 출고

```bash
git merge <기록된_구현_브랜치>                      # 채택 구현 → 작업 브랜치
```

- 머지 후 사용자에게 알린다: **작업 worktree 에서 통합 결과를 직접 실행·확인해 달라**
  (실행 방법을 한 줄로 같이 준다). 문제가 나오면 수정 라운드 → 재확인
- **게이트 ① 사용자 수정 라운드** (LIFE-353 fix3 · LIFE-356 G1~G6): 확인 중 나온 지시·결함은 범위를
  문서로 박고(04-gate1-fix.md 류) 워커가 구현 브랜치에 이어 커밋(rN 태그) → 코디네이터가 diff 정독·게이트
  재실행·스모크 원자료 검증 후 verdict 에 판정 부록 append → 작업 브랜치 머지. 범위가 UI/문구 수준이면 전체 코드
  리뷰를 반복하지 않는다 (가드·기준 경로를 건드리면 재리뷰 판단)
- 수정 라운드 워커도 §4 패턴 그대로: 같은 워커에 이어 맡기면
  `orchestration worker-start --task <fix_task_id> --terminal <handle>`로 재사용하고(재개에는
  `--model`·`--effort`·`--advisor`·`--worktree`를 붙이지 않는다 — 검증 단계에서 거절된다),
  완료 대기·질문 응답은 `check --block`/`reply`로 처리한다.
  **provider 차단 화면(승인·업데이트·trust)은 `question`이 아니다** — `question`은 워커 `ask`만 만든다.
  차단이면 `worker-start`가 `agent_blocked`로 거절하고 `wait`는 `satisfied: false`로 즉시 돌아온다.
  **단 corral의 차단 판정은 herdr detect manifest의 label이 유일한 근거다** — label되지 않은 모달은
  `agent-ready`를 통과한다(실측: codex 0.156.1 업데이트 메뉴). 그래서 codex pane은 첫 `prompt` 전에
  `terminal read`로 화면을 한 번 확인한다. 떠 있으면 사람이 GUI에서 치우거나 `terminal send`로 정리한 뒤
  같은 Task에 `worker-start --task <t> --terminal <h>`로 재개한다(2단). trust 화면은 사람 몫이다
  **`worker-start --agent codex`는 준비→주입이 한 호출 안에서 원자적이라 중간 화면을 볼 자리가 없다**
  (`orchestration/index.ts:1076-1084`) — 기동 전 사용자 셸에서 codex를 최신으로 올리거나,
  `terminal create --agent codex` → `terminal read` 확인 → 같은 pane에 `--terminal <h>`로 붙인다
- 확인이 끝나 사용자가 **출고 승인**을 주면:
  1. `specs/LIFE-NNN-<슬러그>/handoff-main.md`를 작업 브랜치에 커밋한다.
     LIFE-N, 본체 경로, 작업 브랜치, 검증한 구현 커밋, 채택·출고 승인 근거, 마무리 명령,
     LA의 현재 상태와 다음 전이를 기록한다. **LA는 아직 완료로 바꾸지 않는다.**
  2. 사용자에게 **작업 worktree 절대경로와 인계 파일의 절대경로**, 본체에서 읽을 명령
     `git show LIFE-NNN-<슬러그>:specs/LIFE-NNN-<슬러그>/handoff-main.md`를 전달한다.
     머지 전에는 본체 main의 `specs/`에 이 파일이 없으므로 작업 worktree나 위 명령으로 읽는다.
     **본체 마무리 세션**은 시작 세션이 남아 있으면 그 세션, 없으면 사용자가 본체에서 여는
     Claude 또는 Codex 세션이다. 사용자가 전달받은 경로·명령으로 인계 문서를 읽고 이어받는다.
     코디네이터는 "출고 인계 완료, main 반영·LA 완료는 대기"라고 보고한다.
  3. 본체 마무리 세션은 인계 문서를 읽어 LA 접근과 승인 기록을 먼저 확인하고 본체에서
     `scripts/task-finish.sh LIFE-NNN-<슬러그>`를 실행한다.
     스크립트는 main 머지·push·worktree·브랜치 정리를 수행하며 태그는 유지한다.
  4. 본체 마무리 세션이 스크립트 성공 및 검증한 구현 커밋의 main 포함을 확인한 뒤
     `issue_transition(seq: NNN, toStatusLabel: "완료", resolution: "completed")`를 호출하고
     실제 응답을 확인해 사용자에게 완료를 보고한다. 부모 checkpoint는 다른 미완 자식이 없는지
     확인한 뒤 별도로 완료 여부를 판단한다.
- 스크립트가 실패하면 LA를 완료로 바꾸지 않는다. main 반영 후 LA 전이만 실패했다면
  "main 반영 완료 / LA 전이 미완"을 보고하고 본체 세션에서 전이만 재시도한다.
- 작업 worktree의 코디네이터는 main 머지·정리를 직접 실행하지 않는다. worktree 삭제 후에도
  필요한 인계 문서는 main의 specs에 남고, 후속 책임은 본체 마무리 세션에 있다.
