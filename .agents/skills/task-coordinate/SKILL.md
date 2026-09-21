---
name: task-coordinate
description: >-
  corral 작업 코디네이터 절차. 작업 worktree의 Claude 또는 Codex 코디네이터가 킥오프 직후 읽는다.
  분석·판정 기준·킥오프 승인·설계·설계 리뷰·단일/경쟁 구현·독립 코드 리뷰·판정·세 승인 게이트·본체 마무리 인계를 다룬다.
  Orca orchestration으로 워커 기동·완료 감지·질의응답을 처리한다.
---

# task-coordinate — 코디네이터 절차 (작업 worktree 세션에서 실행)

전제: task-start 가 만든 작업 worktree(`.claude/worktrees/LIFE-NNN-<슬러그>/`, 작업 브랜치 체크아웃) 안이다.
원칙은 AGENTS.md, 완료 조건은 `.agents/rules/validation.md`. 문서 산출물은 전부 작업 브랜치에 커밋한다.

## 0. 실제 코디네이터 세션 확인

- `specs/LIFE-NNN-<슬러그>/00-start.md`의 코디네이터·모델/effort·worktree를 확인한다.
  현재 세션과 기록이 다르면 작업을 시작하지 말고 `00-start.md`에 불일치를 기록하고 사용자에게 보고한다.
  재개 시 기존 Run·워커·승인 상태부터 확인하고 중복 기동하지 않는다.
- **이 세션에서** LA `issue_by_seq` 조회, 웹 검색 도구의 사용 가능 여부, `grok-search` 본문 읽기,
  `command -v grok`, `orca status --json`을 확인한다. 시작 세션에서 됐다는 이유로 생략하지 않는다.
  MCP를 새로 등록했다면 실제 호출 도구로 나타나는지도 확인한다. 인증값은 문서·프롬프트에 적지 않는다.
- 빠진 도구·권한이 있으면 해결 가능한 설정을 점검하고, 남은 차단 사유를 시작 기록과 사용자에게
  보고한다. 임의로 다른 코디네이터로 바꾸거나 필수 리뷰를 생략하지 않는다.
- 통과하면 `00-start.md`를 `준비 완료`로 갱신·커밋한다. 코디네이터 선택은 구현자·리뷰어
  페어링을 바꾸지 않는다. 문서 작성·판정은 코디네이터, 구현은 별도 워커가 맡는다.
- 각 단계에 필요한 `.agents/rules/` 문서를 읽는다: 글 작성 전 writing.md, 코드 작업 전 coding.md,
  완료 판정 전 validation.md. 디렉터리의 자동 로딩 여부에 기대지 않는다.

## LA 상태 전이 (life-assistant `issue_transition`, forward-only)

분석·설계·설계 리뷰는 "분석 중", 구현 시작 → "개발 중", 코드 리뷰 → "검증 중", main 머지 후 → "완료".
설계 리뷰에서 "검증 중"으로 앞당기지 않는다(forward-only).

## 1. 분석 — 4박자 (외부 서치가 수 분 걸리므로 순차가 아니라 겹친다)

1. **일감 본문 확보**: `issue_by_seq` 로 LIFE-N 상세를 읽는다. `specs/LIFE-NNN-<슬러그>/` 생성
2. **외부 서치 먼저 띄운다**: 코디네이터의 웹 검색으로 개요를 먼저 깔고, grok은 Orca 터미널
   대화형으로 병렬 위임한다(공통 grok-search 스킬). Claude Code는 WebSearch/WebFetch,
   Codex는 제공된 웹 검색·페이지 열기 도구를 사용한다. grok 결과는 자체 검색과 대조해 귀속 표기한다.
3. **서치 대기 중 기준 초안** 작성 (§2)
4. **서치 취합 → 기준 확정**: 서치 결과가 기준을 바꿀 수 있다. 기준 freeze는 게이트 ⓪ 승인 시점이다
- **선행 문서의 사실 주장을 대조표로 검증한다** — 일감 본문·00-project.md 의 전제가 틀렸을 수 있다
  (LIFE-342 에서 5건 중 2건 오류 발견). 산출물: `00-analysis.md` (+ 외부 서치 원문 `00-analysis-grok.md`)
- 절차가 이 스킬과 어긋나면 `00-analysis.md` 의 "절차 어긋남" 섹션에 누적 기록한다 (스킬 개정 재료)
- **UI 비중이 큰 일감이면 여기서 `design-brief`/`design-intake` 스킬 삽입 여부를 검토한다** — 비주얼
  디테일(간격·톤·인터랙션 느낌)이 판정 기준에 안 잡히는 일감은 목업 없이 구현자 재량에 맡기면
  재작업 위험이 있다 (LIFE-357 판단 뒤집음, 2026-09-13). 넣기로 하면 순서는 `specs/app-screens.md`
  (화면 인벤토리, 없으면 먼저) → `design-brief` 스킬 → 외부 Claude Design → `design-intake` 스킬 →
  그 결과를 반영해 `01-criteria.md`/`02-kickoff.md` 작성·freeze. 안 넣기로 하면 그 판단 사유를
  `00-analysis.md` 에 한 줄 남긴다(추측 판정 금지 원칙과 같은 결의 — 판단 없이 생략하지 않는다)

## 2. 판정 기준 — `01-criteria.md`

- 항목별 통과선 + **필수 관문**: ① 실제 실행 + 재현 가능한 원자료 ② 추측 판정 금지 (실행 없는 칸 = 항목 무효)
  ③ **통과선을 낮춰 통과시킨 흔적이 없을 것** (LIFE-342 탈락 사유가 이것이었다)
- 기준 없이 구현 시작 금지

## 3. 킥오프 문서 — `02-kickoff.md` (경쟁이면 양 구현자에게 동일한 기준)

- **물류만 정한다. 설계는 지시하지 않는다** — 구조·라이브러리·계측 방법은 워커가 설계하고 §4에서 구현 전에 검토받는다
- 정체 표: 브랜치 / worktree / 격리 리소스(예: herdr 세션명) / 원자료 경로 / 결과 파일
- `00-start.md`의 코디네이터 선택과 지정 모델·effort를 정체 표에 옮긴다. 재선택하지 않는다.
  워커·advisor·설계 리뷰·코드 리뷰 구성도 시작 기록에서 옮긴다.
  신규 기본값은 [task-start/defaults.md](../task-start/defaults.md)이며 미지정 설정을 다시 묻지 않는다.
- **격리 규칙**: 사용자가 실제 쓰는 리소스(default 세션·소켓 등)를 건드리지 않는다.
  외부 도구 실측은 전용 격리 인스턴스에서. 상대 브랜치 보지 않기, 작업 브랜치에 커밋하지 않기
- **격리 인스턴스 기동에 "헤드리스는 안 된다" 고 단정하지 않는다.** 정확히는 *TTY 가 없으면* 안 되는
  것이고, `script(1)` 같은 PTY 래퍼로 붙는 경로가 있다. LIFE-344 에서 herdr 세션 기동이
  Orca 탭 경로 61.5초 · PTY 경로 53ms 로 갈렸다 — 재기동 시간이 통과선에 들어가는 항목이 있으면
  이 차이가 판정을 뒤집는다. (**각각 1회 측정**이라 수치는 자릿수로만 쓴다)
- 원자료 규칙: 로그·스냅샷·타이밍 원본을 `specs/LIFE-NNN-*/raw/<도구>/` 에 커밋.
  판정표 "근거" 칸이 가리킬 실물이 없으면 그 항목은 무효
- **결과 문서**: 전부 커밋 + `raw/<도구>/DONE.md` (한 줄 요약 + 미완 목록) — 이건 감사 추적용
  기록이지 프로세스 완료 감지 신호가 아니다. 완료 감지는 §4 의 orchestration `worker_done` 메시지로
  한다. "커밋되지 않은 결과는 없는 것이다"

## ⛔ 승인 게이트 ⓪ — 킥오프 (§3 후 · §4 전, worker-start 금지 지점)

00-analysis · 01-criteria · 02-kickoff 를 커밋한 뒤 사용자에게 보고하고 **멈춘다**:

- **문제 정의·범위**: 뭘 구현하기로 했고, 뭘 명시적으로 뺐는지 (분석에서 좁힌 결과)
- **판정 기준 요약**: 01-criteria 통과선 핵심 몇 줄
- **구현 방식**: 확정한 단독/경쟁 구성, 워커·advisor·설계/코드 리뷰 모델·effort, 디자인 브리프 삽입 여부와 사유

승인이 오면 §4 로 진행한다. 지적이 나오면 문서를 고쳐 재보고한다 — 기준 freeze 는 이 승인
시점이다. 이때는 문제·기준·물류를 승인하고, 워커의 상세 설계는 이후 독립 검토한다.

## 4. 설계 → 독립 설계 리뷰 → 같은 워커의 구현

기본은 Opus high 단일 워커 + Fable advisor다. 역할별 모델·effort는 `00-start.md`를 따른다.
설계·advisor·설계 리뷰·구현을 **서로 다른 Task/Dispatch**로 관리한다. 설계 Task 성공은
구현 허가나 제품 완료가 아니다. 코디네이터는 설계 판정을 커밋하기 전 구현 Task를 기동하지 않는다.

### 4.1 설계와 advisor

- 설계 Task는 분석·기준·킥오프를 읽고 `03-design-<도구>.md`를 자신의 구현 브랜치에 커밋한다.
  기존 코드 근거, 선택한 접근·대안, 인터페이스/상태 전이, 실패·재시도·소유권, 기준별 검증 방법,
  미확인 가정을 짧게 정리한다. 가정 확인용 격리 실험은 허용하되 제품 구현을 시작하지 않는다.
- 워커는 핵심 설계 질문을 `ask`로 코디네이터에게 보낸다. 코디네이터가 질문·설계 commit·관련
  기준을 지정해 별도 Fable advisor Task를 같은 Run에서 기동한다. advisor는 기존 구현 worktree에
  새 `--agent claude --model <advisor_model> --effort <advisor_effort>` 세션으로 붙인다.
  advisor 전용 CLI 옵션을 가정하지 않는다. 워커는 질문 응답을 기다리는 동안 파일 편집을 멈춘다.
  advisor는 보고서 파일만 커밋하고 코디네이터는 그 경로와 commit을 회수한다.
- advisor는 코드 읽기·설계 조언을 맡고 제품 파일을 수정하지 않는다. 보고서는
  `raw/advisor/<task-id>.md`, 완료는 `worker_done`으로 전달한다. 코디네이터는 완료 확인 후
  워커 질문에 보고서 경로로 `reply`하고 사용한 advisor를 release/ACK한다.
  기본은 설계의 핵심 결정에 한 번 자문하며, 추가 자문은 새 쟁점과 사유를 기록한다.
- 워커가 조언 수용/기각 사유를 설계에 반영하고 `worker_done`을 보낸다. 코디네이터는
  **설계 파일·원자료만** 작업 브랜치에 회수하고 원 commit을 기록한다(구현 브랜치 전체 merge 금지).
  설계 워커는 release하지 않고 후속 보완/구현에 재사용한다.

### 4.2 설계 리뷰와 판정

- 별도 Codex Astra high 세션에 설계·기준·대상 commit을 주고 `.agents/agents/reviewer.md`의
  설계 리뷰 규칙을 읽게 한다. 같은 Run의 새 Task/Dispatch로 실행하고 실제 코드 근거도 확인한다.
- 결과 `review-design-codex.md`를 회수한다. 경쟁이면 후보별 파일·세션을 분리한다.
  설계 수정은 같은 워커 terminal에 새 Task로 맡기고, reviewer는 바뀐 부분을 재검토한다.
- 코디네이터는 `04-design-verdict.md`에 지적 수용/기각 사유·잔존 위험·검토한 설계 commit을 기록한다.
  경쟁이면 후보별 판정 파일과 설계 경로를 분리하며 상대 후보 판정을 워커에게 전달하지 않는다.
  미해결 높음/중간 0건, 낮음 취합 1회 처리 후 구현 진행을 판정한다. 설계 수정 상한 3회;
  미수렴이면 이유와 범위 조정안을 사용자에게 보고한다. 제품 검증 성공을 미리 판정하지 않는다.
- 내부 설계 판정에 새 사용자 승인 게이트를 추가하지 않는다. 승인된 범위·기준을 바꿔야 하면
  사용자에게 보고하고 변경 승인 후 진행한다. 설계 리뷰어는 완료 후 release/ACK한다.

### 4.3 구현 이어가기

- 별도 구현 Task에 `04-design-verdict.md`와 최종 설계 commit을 지정한다. 구현 브랜치에 없는
  판정은 작업 브랜치의 고정 commit에 대해 `git show <commit>:<경로>`로 읽게 한다. 같은 Opus terminal과
  명시 worktree를 `worker-start --terminal`로 재사용한다. 이 경우 모델/effort 옵션을 다시 넣지 않는다.
- 세션이 없어졌으면 남은 실행 상태·commit부터 확인하고 기록된 모델로 대체 세션을 기동한다.
  인계 내용을 읽혀 재개하며, 기존 세션이 실행 중인데 중복 기동하지 않는다.
- 핵심 인터페이스·상태/실패 계약이 바뀌면 구현을 멈추고 설계 변경분만 §4.2로 재검토한다.
  내부 함수 구성 등 계약에 영향 없는 변경은 워커 재량이다.
- 코드·테스트·원자료·결과를 자신의 구현 브랜치에 커밋하고 구현 Task의 `worker_done`으로 보고한다.
  이후 제품 결과 문서는 `05-` 이후 번호를 사용한다. 기존 작업의 파일명은 바꾸지 않는다.

### 4.4 기동·메시지·회수 공통 절차

**워커 기동·완료 감지는 Orca `orchestration` 계층으로 한다** (2026-09-18 전환, 저수준
`terminal create/send/read` 조합 폐기). 먼저 `orca skills get orchestration`으로 스킬 본문을 읽는다.
이유: 저수준 조합은 완료 감지를 git 파일 존재(`DONE.md`)로 대체 판단해야 했고 이게 두 번 헛불렀다
(`specs/LIFE-345-terminal-view/verdict.md` — ① 자리표시자 든 초안을 완료로 오판 ② 워커가 계속
도는데 파일만 보고 완료로 오판, 사용자가 잡음). `orchestration`은 워커가 보내는 구조화된
`worker_done` 메시지로 이 문제를 근본에서 없앤다. 워크트리 배치 경로는 그대로
`.claude/worktrees/<이름>`이다(Orca 기본값 — life-assistant·home-coffing 두 레포에서 실측 확인,
`orca.yaml` 오버라이드 없이도 이 경로를 씀).

```bash
orca orchestration run-create --objective "LIFE-NNN <슬러그>" --json
orca orchestration task-create --spec "00-analysis.md, 01-criteria.md, 02-kickoff.md를 읽고 설계만 수행한다. 03-design-claude.md를 커밋하고 worker_done으로 보고한다. 제품 구현은 별도 Task에서 시작한다." --json
# 실제 spec에는 대상 specs 절대경로와 advisor 질문·보고 절차(§4.1)를 포함한다.
orca orchestration worker-start --task <design_task_id> --worktree new-child \
  --name LIFE-NNN-<슬러그>-claude --agent claude --model <worker_model> --effort <worker_effort> --json

# 설계 리뷰·판정 완료 후 새 구현 Task를 발급하고 같은 terminal을 재사용한다.
orca orchestration worker-start --task <implementation_task_id> \
  --terminal <worker_handle> --worktree path:<워커 worktree 절대경로> --json
# 경쟁 지정 시 각 후보에 설계→리뷰→구현을 따로 적용하고 상대 후보를 공유하지 않는다.
```

- 브랜치·worktree 이름은 `--name`으로 기존 컨벤션(`LIFE-NNN-<슬러그>-<도구>`) 그대로 지정
- 구현 브랜치가 살아 있는 동안 작업 브랜치 rebase 금지
- **완료 대기는 블로킹으로 건다 — 폴링하지 않는다**:
  ```bash
  orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 60000 --json
  ```
  타임아웃이나 `{count:0}`은 실패가 아니라 체크포인트다 — 긴 구현은 15~60분 걸리는 게 정상이니
  받은 배치를 처리하고 `check --ack <delivery_id> --wait ...`로 이어서 다시 건다. 유효한
  `worker_done`을 받으면 해당 task/dispatch의 `outcome`을 확인한다. `succeeded`와 `failed` 모두
  종료 보고이며 성공을 뜻하는 것은 아니다. 상태 전이는 Orca가 처리한다(`task-update`로 수동 완료 금지).
- 호스트 실행 도구도 60초 이내에 제어를 돌려받도록 한다. Codex는 셸 실행의 session ID 또는
  실행 중 cell ID를 반환받았으면 해당 대기 도구로 이어 받는다. 기존 대기 프로세스가 살아 있는 동안
  같은 Run의 `check`를 중복 실행하지 않는다. Claude Code는 장기 대기를 백그라운드로 실행할 수 있다.
- **워커가 막혀서 `question`을 보내면** `orca orchestration reply --id <msg_id> --body <답> --json`으로
  답하고 계속 대기한다 — "질문 대기 화면을 코디네이터가 키 입력으로 풀어주던" 임시방편(LIFE-356)의
  정식 대체
- **완료된 워커는 정리한다**: `orca orchestration worker-release --dispatch <dispatch_id> --json`.
  수정 라운드로 같은 워커에 바로 이어 맡길 거면 release 하지 말고
  `orca orchestration worker-start --task <다음_task_id> --terminal <handle> --worktree path:<해당 워커 worktree 절대경로> --json`로 재사용한다.
  배치의 모든 메시지와 정리·재사용 결정을 처리한 뒤 delivery를 ack한다.

## 5. 독립 코드 리뷰

- 검토 전 `.agents/agents/reviewer.md` 필독. **모든 리뷰어는 코디네이터·구현자와 별도 세션**이다.
  Codex 코디네이터가 Codex 리뷰를 대신하거나, Claude 코디네이터가 Claude 리뷰를 대신하지 않는다.
- 기본은 별도 Codex Astra xhigh + Grok이다. 모델·effort는 시작 기록을 따르고 advisor와
  설계 리뷰어를 코드 리뷰어로 재사용하지 않는다. 같은 코드 수정 라운드에서는 코드 리뷰 세션 재사용 가능.
- Codex는 §4.4와 같은 Run에서 새 Task/Dispatch와 새 `--agent` 세션으로 기동한다.
  완료 대기는 `check --wait --types worker_done,escalation,question`이다.
  Grok은 grok-search의 Orca 대화형 경로를 따른다. 실제 검증 범위를 구분해 기록한다.
- `git diff LIFE-NNN-<슬러그>..LIFE-NNN-<슬러그>-<도구>` 로 검토 (체크아웃 불필요)
- **리뷰어 터미널은 구현 worktree 에서 돌려도 된다** (LIFE-356, 사용자 승인 2026-09-13) —
  원자료 재검산·독립 재실행(하네스 재투입)이 체크아웃 상태를 요구할 때 이쪽이 싸다.
  판정문·기준서는 `git show <작업브랜치>:specs/...` 로 읽는다. 리뷰 실행 흔적은 리뷰어가
  스스로 정리(구현자 원자료 불변, git status clean)하고 코디네이터가 취합 전 확인한다
- 결과: `review-<도구>.md`, 코디네이터가 작업 브랜치에 커밋

## 6. 취합·판정 — `verdict.md`

- 경쟁이면 **패자 raw/ 를 먼저 작업 브랜치로 회수한다** — 브랜치 삭제 전에. 안 하면 판정 재검증 불가
- 실제 구현 브랜치 HEAD를 태그로 고정(단독이면 하나): `LIFE-NNN-claude-final` / `LIFE-NNN-codex-final` (리뷰가 줄 번호로 인용하므로)
- 기각·탈락엔 사유 기록, 자기 구현분 지적 기각은 특히 상세히
- 수렴: 높음+중간 0건 → 낮음 모아 1회 수정 후 종료. 수정 상한 3회

## 7. ⛔ 승인 게이트 ① — 채택

판정 결과를 사용자에게 보고하고 **멈춘다**. 이 시점엔 구현 브랜치 전체 머지 0건 — 승자 변경·추가 수정 요구가 가능하다.
조용한 완료 금지.

## 8. (채택 승인 후) 작업 브랜치 머지 → 사용자 확인 → ⛔ 승인 게이트 ② — 출고

```bash
git merge LIFE-NNN-<슬러그>-<승자>                      # 승자 → 작업 브랜치
```

- 머지 후 사용자에게 알린다: **작업 worktree 에서 통합 결과를 직접 실행·확인해 달라**
  (실행 방법을 한 줄로 같이 준다). 문제가 나오면 수정 라운드 → 재확인
- **게이트 ① 사용자 수정 라운드** (LIFE-353 fix3 · LIFE-356 G1~G6 전례): 확인 중 나온 지시·결함은
  범위를 문서로 박고(04-gate1-fix.md 류) 워커가 구현 브랜치에 이어 커밋(rN 태그) → 코디네이터가
  diff 정독·게이트 재실행·스모크 원자료 검증 후 verdict 에 판정 부록 append → 작업 브랜치 머지.
  전체 코드 리뷰는 다시 돌리지 않는다 (범위가 UI/문구 수준일 때 — 가드·기준 경로를 건드리면 재리뷰 판단)
- 수정 라운드 워커도 §4 패턴 그대로: 같은 워커에 이어 맡기면
  `orchestration worker-start --task <fix_task_id> --terminal <handle> --worktree path:<해당 워커 worktree 절대경로>`로 재사용, 완료 대기·질문
  응답은 `check --wait`/`reply`로 처리한다(codex 류 승인 프롬프트 정지도 이제 `question` 메시지로
  들어오므로 화면 감시가 따로 필요 없다 — LIFE-356 verdict §5 임시방편의 정식 대체)
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
