# orca 매핑 — 능력 → 명령

능력 이름과 보장 어휘(증명/관측/공백)의 정본은 [capabilities.md](capabilities.md).

## 이 매핑의 실행 근거 — 읽기 전용

orca 는 **사용자가 실제로 쓰는 앱**이다. 이 매핑을 만들 때 실행한 것은 읽기 전용 세 가지뿐이다:
`orca --help`(`raw/claude/c4-orca-help.txt`, 361줄) · `orca status --json`(`c5-orca-status.json`, 기능 토큰 67개) ·
`orca agent-context --json`(`c4-orca-agent-context.json`, 명령 234개의 시그니처·주의사항 — 앱이 없어도 되는 순수
로컬 레지스트리 읽기). **pane·Run 을 만드는 명령은 하나도 실행하지 않았다.**

따라서 아래 보장 수준은 **공개 계약 문서(그 레지스트리)가 무엇을 약속하는지**를 읽은 결과이고, 실측 칸은
전부 `미실행` 이다. 실행이 필요해지면 사용자 승인을 받고 실행한 뒤 이 파일을 고친다.
**계약이 약속하지 않은 것을 "아마 된다" 로 올려 적지 않는다.**

## 보장 요약 (네 가지 증명 대상)

| 증명 대상 | 수준 | 근거 |
| --- | --- | --- |
| 본문이 정확히 한 번 전달됐다 | **공백** | managed 에이전트에 본문을 넣고 **도착을 판정하는 명령이 없다.** `terminal send` 는 raw 입력이고 ack 가 없다. 본문 전달 경로는 `worker-start`(일감 본문)·`worktree create --prompt`·`terminal create --command` 뿐이고, 그 어느 것도 "provider 기록에 정확히 1건" 을 값으로 돌려준다고 적지 않는다 |
| 이 pane 이 맡긴 그 pane 이다 (세대 불변) | **공백** | 계약이 pane 의 **세대·epoch 값을 돌려주는 명령이 없다** — 명령 234개 레지스트리에 `generation`·`pty_replaced`·`pane_gone` 은 0회 등장한다(`grep -i` 로 확인, epoch 1회는 `cookie set --expires`). `worker-release` 의 "unproven identities / reused or pre-existing terminals 는 절대 닫지 않는다" 는 **닫기 부작용을 제한하는 정책**이고(그 근거는 『회수·정리』에 따로 적었다), 호출자가 "내가 주입한 그 pane 이 그새 교체됐는지" 를 **가려낼 값이 아니다.** 그래서 corral 의 `epoch_changed` 같은 판정을 여기서 기대하지 않는다 |
| 보고가 오래된 시도에서 온 게 아니다 | **증명(계약)** | `send --type worker_done` 은 "완료는 그 task/dispatch id 로, **dispatched pane 에서만** Task 를 완료시킨다. 안정적인 pane 신원이 없으면 발신 handle 이 dispatch assignee 와 정확히 일치해야 한다" 고 적는다 |
| 사람 개입 흔적 | **관측(+ 계약 한 조각)** | `terminal read` 화면(H2). 더해 `worker-show` 의 `observation.agentWait` 가 **사람만 답할 수 있는 프롬프트에 멈춘 워커**를 그 근거(hook·prompt-text·title)와 함께 이름 짓는다. null 은 "보고 없었다", **필드 부재는 "보지 않았다" 이고 절대 "안 기다린다" 가 아니다** |

---

## 『전제 점검』

### 명령
```bash
orca status --json          # runtime.capabilities = 기능 토큰 67개 (orchestration.contract.v1 류)
orca agent-context --json   # 명령 레지스트리 — 명령 이름·시그니처
node .agents/harness/capability-check.mjs runtime --tool orca
```

### 보장 수준
**증명 — 단 형식이 corral 과 다르다.** orca 의 광고는 **명령 이름이 아니라 기능 토큰**이다
(`orchestration.contract.v1`, `terminal.multiplex.v1`, `orchestration.worker-stop-verdict.v1` …).
그래서 대조는 두 갈래다: 매핑이 요구하는 **기능 토큰**은 `status` 의 집합과, 요구하는 **명령 이름**은
레지스트리의 명령 목록과 대조한다. 실측 1회 통과(`raw/claude/c5-*`).

### 상황 → 행동
- **차단 화면**: 해당 없음 — 점검 명령은 pane 을 열지 않는다.
- **타임아웃·빈 결과**: 레지스트리 읽기는 **앱이 꺼져 있어도 답한다**(계약에 그렇게 적혀 있다) — 그래서
  레지스트리만 보고 "런타임이 살아 있다" 고 판정하면 안 된다. 살아 있는지는 `status` 로 본다.
- **부분 실패**: 기능 토큰은 있는데 명령이 없거나 그 반대일 수 있다 — 둘 다 대조해야 한다.
- **복구**: `status` 가 안 되면 사용자가 앱을 띄운다(`orca open` 은 앱을 여는 명령이지만 이 매핑을 만들 때
  실행하지 않았다 — 미실행).
- **하지 말 우회**: 기능 토큰 이름을 명령 이름처럼 읽지 않는다. `orchestration.contract.v1` 이 있다고
  corral 과 같은 배달 판정이 있다는 뜻이 아니다 — **실제로 없다**(위 보장 요약 첫 줄).

## 『세션 기동』

### 명령
```bash
orca terminal create [--worktree <selector>] [--title <name>] [--command "<provider 실행 명령>"] [--focus] --json
orca orchestration worker-start --task <task_id> --agent <agent> [--model <id>] [--effort <level>] \
  [--worktree <current|selector|new-child|new-top-level>] [--run <run_id>] --json
orca terminal show [--terminal <handle>] --json     # 미실행
```

### 보장 수준
**관측.** `terminal create` 에는 `--agent` 가 **없다** — provider 는 `--command` 로 띄운다(계약이 명시적으로
"기존 체크아웃에 새 에이전트를 띄울 때는 `terminal create --worktree active --command "codex"` 를 쓰라" 고 적는다).
모델·effort 는 `worker-start --model/--effort` 로만 주고 **`--effort` 는 `--model` 을 요구하며 둘 다 `--terminal`
과 함께 쓸 수 없다.** **advisor 를 지정하는 플래그는 어디에도 없다 — advisor 지정은 공백이다.**

### 상황 → 행동
- **차단 화면**: 계약에 차단 화면 개념이 없다 — 기동이 차단을 이유로 거절된다는 문장이 없다. 차단은
  『화면 관측』으로 사람이 본다.
- **타임아웃·빈 결과**: `worker-start` 는 **ready 일 때만 exit 0** 이고, 실패·`outcome_unknown` 은 exit 1 로
  `stage`/`failedStage`·`setup`·`effects`·`residualResources`·복구 명령을 함께 낸다.
- **부분 실패**: 새 worktree 는 에이전트 우선 생성이고 `--setup` 기본이 run 이다. 기존·현재 worktree 에는
  생성 플래그(`--name`·`--repo`·`--base-branch`·`--display-name`·`--comment`·`--setup`)가 **거절된다.**
- **복구**: `--retry-of <dispatch_id>` 가 있다(corral 에는 없는 것) — 단 **배치를 물려받지 않으므로**
  의도한 `--on`/worktree/`--agent`/`--terminal` 선택을 다시 적어야 한다. 미실행.
- **하지 말 우회**: 모델 별칭을 그대로 기록하지 않는다 — 계약이 "Claude·Codex·Cursor 의 불투명한 provider
  모델 id" 라고만 적으므로 해소 결과는 관측으로 확인해야 한다(그 관측 경로도 미실행).

## 『준비 대기』

### 명령
```bash
orca terminal wait [--terminal <handle>] --for exit|tui-idle [--timeout-ms <ms>] --json
```

### 보장 수준
**관측, 그리고 차단 화면 구분은 공백.** `--for` 값은 `exit` 과 `tui-idle` **둘뿐이다** — corral 의
`agent-ready` 에 해당하는 조건이 없다. 따라서 "지시를 받을 수 있다" 와 "trust·업데이트 화면에서 멈춰 있다" 가
**같은 tui-idle 로 보인다.** 이것이 이 도구의 가장 큰 공백이고, 『본문 주입』의 공백과 맞물린다.

### 상황 → 행동
- **차단 화면**: **가려낼 수단이 없다.** 그래서 이 매핑에서는 첫 지시 전에 **항상** 『화면 관측』으로 화면을
  한 번 본다 — corral 에서 codex pane 에만 하던 것을 여기서는 모든 pane 에 한다.
- **타임아웃·빈 결과**: `tui-idle` 만족은 준비의 증거가 아니라 **조용함의 증거**다. 타임아웃을 준비로 읽지 않는다.
- **부분 실패**: 없음(대기는 아무것도 바꾸지 않는다).
- **복구**: 차단이면 사람이 GUI 에서 치운다. `terminal send --text … --enter` 로 치우는 것은 **화면을 읽어
  무엇인지 확인한 뒤에만** 한다 — 무엇에 답하는지 모르는 입력을 보내지 않는다.
- **하지 말 우회**: `tui-idle` 을 `agent-ready` 인 것처럼 판정표에 적지 않는다. 이 칸은 관측이다.

## 『본문 주입』

### 명령
```bash
orca terminal send [--terminal <handle>] --text "<본문>" --enter --json     # raw 입력, ack 없음
orca worktree create --name <name> --agent <id> --prompt "<본문>" --json    # 생성과 함께 첫 지시
```

### 보장 수준
**공백.** 이 도구에는 `terminal prompt` 에 해당하는 명령이 없다. `terminal send` 는 키 입력을 보내는 것이고
**도착·소비·1회성 중 무엇도 값으로 돌려주지 않는다.** 따라서 "본문이 정확히 한 번 전달됐다" 는 이 도구에서
**판정표 공백**이다. 사후 확인은 『세션 기록 오라클』(관측)로만 한다.

### 상황 → 행동
- **차단 화면**: 차단 화면에 `send` 를 하면 그 화면에 대한 대답으로 먹힌다 — 본문이 사라지고 흔적도 남지 않는다.
  그래서 **보내기 전에 반드시 화면을 읽는다.**
- **타임아웃·빈 결과**: 해당 없음 — 기다릴 대상이 없다(그게 공백의 뜻이다).
- **부분 실패**: 두 번 보내면 두 번 들어간다. **중복 방지 장치가 없으므로 사람이 세야 한다** — 보낸 시각과
  본문을 원자료로 남기고, 재전송 전에 『화면 관측』으로 이미 들어갔는지 확인한다.
- **복구**: 들어갔는지 불확실하면 **다시 보내지 않고** 화면과 세션 기록을 본다. 중복 주입이 의심되면
  그 사실을 판정표 근거 칸에 적는다.
- **하지 말 우회**: `--enter` 가 붙어 exit 0 이라는 것을 배달 증거로 쓰지 않는다. 판정표의 배달 칸에
  "보냈다" 를 적지 않는다 — `공백` 으로 적는다.

## 『감독 워커 기동』

### 명령
```bash
orca orchestration task-create --spec "<일감 명세>" [--task-title <text>] [--run <run_id>] --json
orca orchestration worker-start --task <task_id> (--agent <agent> | --terminal <handle>) \
  [--worktree <current|selector|new-child|new-top-level>] [--model <id>] [--effort <level>] \
  [--retry-of <dispatch_id>] [--timeout-ms <n>] [--run <run_id>] --json
orca orchestration dispatch-show --task <task_id> [--preamble] --json
```

### 보장 수준
**관측.** 계약이 약속하는 것은 "**ready 일 때만 exit 0**" 까지다. 어떤 값으로 본문 도착을 판정했는지
(provider 기록의 일치 건수 같은 것)는 **레지스트리에 적혀 있지 않다.** 그래서 이 도구에서 워커 기동은
"거절되지 않았다" 까지가 증명이고, "본문이 정확히 한 번 들어갔다" 는 위 『본문 주입』의 공백을 물려받는다.
미실행.

### 상황 → 행동
- **차단 화면**: 계약에 `agent_blocked` 류 거절이 없다 — 기동 직후 『화면 관측』으로 확인한다.
- **타임아웃·빈 결과**: `outcome_unknown` 은 exit 1 이고 `residualResources`·복구 명령을 낸다. `--timeout-ms`
  상한은 레지스트리에 수치로 적혀 있지 않다(corral 의 120000/600000 같은 값 — **공백**, 필요하면 실측해 적는다).
- **부분 실패**: 실패한 단계가 앞 단계를 되돌리지 않고 `residualResources` 에 남는다(corral 과 같은 모양).
  `--on` 은 **워커 서버만** 고르고 Run 과 이 명령은 현재 호스트에 남는다. 원격에서 `current`·`new-child` 는 무효다.
- **복구**: `--retry-of <dispatch_id>` 로 교체 시도를 연결한다 — 배치는 물려받지 않으니 다시 적는다.
  `request-show --request <request_id>` 로 잃어버린 응답을 조회한다(**`--id` 가 아니라 `--request` 다**).
- **하지 말 우회**: `dispatch` 로 만든 문맥 전용 Dispatch 를 감독 워커로 세지 않는다 — 계약이 그것을
  `unsupervised`·terminal state `retained` 로 보고한다. 레거시 `coordinator-start`/`coordinator-stop` 은
  아무 효과가 없는 명령이다(계약 스스로 그렇게 적는다) — 쓰지 않는다.

### 재사용 인자 규칙 (절차 문서가 가리키는 그 규칙)

**재사용 때 `--terminal <handle>` 과 그 터미널의 `--worktree` 를 함께 준다.** 계약이 그대로 적는다:
"When reusing --terminal, pass --worktree for that terminal; current means the coordinator worktree."
`current` 는 코디네이터 worktree 를 뜻하므로, **워커 worktree 를 쓰려면 그 selector 를 명시해야 한다.**

**corral 과 정반대라는 점이 이 규칙의 핵심이다** — corral 은 재사용에 `--worktree` 를 붙이면 거절하고,
orca 는 빼면 잘못된 작업 공간으로 붙는다. 그래서 절차 문서는 "매핑의 재사용 인자 규칙을 따른다" 만 적고
실제 인자는 이 표에서 읽는다. 미실행(읽기 전용 매핑).

## 『완료 감지』

### 명령
```bash
orca orchestration check [--run <run_id>] [--ack <delivery_id>] [--types <type,...>] [--wait] \
  [--timeout-ms <n>] --json
orca orchestration worker-show --dispatch <dispatch_id> --json
```

### 보장 수준
**증명(계약).** 완료는 `send --type worker_done` 이고 `--outcome succeeded|failed` 가 필수다. 계약이
"활성 task/dispatch id 를 담은 `worker_done` 은 **그 dispatched pane 에서만** 그 Task 를 완료시키고, 안정적인
pane 신원이 없으면 발신 handle 이 dispatch assignee 와 정확히 일치해야 한다" 고 적는다 — 오래된 시도·다른
pane 의 보고를 배제하는 장치가 계약에 있다. `check` 는 바인딩된 Run 의 **가장 오래된 미확인 FIFO 배치**를
돌려주고 `--ack` 전까지 같은 Delivery 를 되돌린다. 미실행.

### 상황 → 행동
- **차단 화면**: 완료 감지 경로에서는 보이지 않는다. 차단은 『화면 관측』 또는 `worker-show` 의
  `observation.agentWait` 로 본다.
- **타임아웃·빈 결과**: `--wait` 는 **`--block` 이 아니다**(corral 과 플래그 이름이 다르다). 대기 중
  **15초마다 stderr 로 JSON keepalive 줄**을 뿜으므로 stdout 과 섞어 파이프할 때 `_keepalive` 를 걸러야 한다.
  `_keepalive` 는 heartbeat 메시지와 무관하다. 빈 배치는 새 워커를 만드는 근거가 아니다.
- **부분 실패**: 바인딩된 Run 은 `--ack` 전까지 같은 Delivery 를 되돌린다 — **확인 전에 배치의 모든 메시지를
  처리한다.** `--ack` 는 직전 배치 전체에만 적용된다.
- **복구**: `inbox --full` 로 수신자별 전체를 본다. `--peek` 는 읽음 표시 없이, `--all` 은 그 handle 의 전체를
  읽음 표시 없이 준다.
- **하지 말 우회**: `terminal wait --for exit` 을 완료로 쓰지 않는다 — provider 가 죽은 것과 일을 끝낸 것은 다르다.
  `--format` 은 로컬 텍스트 렌더일 뿐 **다른 터미널에 아무것도 쓰지 않는다** — 그걸 전달로 착각하지 않는다.

## 『질의응답』

### 명령
```bash
orca orchestration ask (--question "<질문>" | --resume <message_id>) [--run <run_id>] [--options <csv>] \
  [--timeout-ms <n>] --json
orca orchestration reply --id <msg_id> --body "<답>" [--run <run_id>] --json
```

### 보장 수준
**증명(계약).** 계약이 "타임아웃은 질문을 pending 으로 남기고, **원래 메시지 id 로 재개한다**" 고 적는다.
**corral 과 다른 점: `ask` 가 `--run` 을 받는다** — 바인딩이 바뀐 구간에서도 질문을 원하는 Run 으로 보낼 수 있다.
활성 Dispatch 에서 새 질문은 기본적으로 그 Dispatch 가 속한 Run 의 mailbox 로 간다. 미실행.

### 상황 → 행동
- **차단 화면**: 해당 없음.
- **타임아웃·빈 결과**: 상한 수치가 레지스트리에 적혀 있지 않다 — **공백.** 필요하면 실측해 적는다.
  타임아웃 뒤에는 `--resume <원래 id>` 를 쓴다. 다시 물으면 중복 질문이 된다.
- **부분 실패**: 워커 보고(`worker_done`·`heartbeat`)는 그룹 주소로 보낼 수 없고 `--to` 를 비워 Dispatch 의
  Run mailbox 로 보낸다.
- **복구**: 답을 보낼 때는 **같은 orca 실행 파일**로 `reply --id` 를 쓴다(계약이 명시).
- **하지 말 우회**: `--payload` 로 raw JSON 을 조립하지 않는다 — 계약이 `--task-id`/`--dispatch-id` 류 전용
  플래그를 쓰라고 적는다. 로컬 대화형 프롬프트로 사람에게 묻지 않는다.

## 『화면 관측』

### 명령
```bash
orca terminal read [--terminal <handle>] [--screen] [--cursor <n>] [--limit <n>] --json
orca orchestration worker-read --dispatch <dispatch_id> [--source auto|transcript|terminal] \
  [--cursor <cursor>] [--limit <n>] --json
orca orchestration worker-show --dispatch <dispatch_id> --json     # observation.agentWait
```

### 보장 수준
**관측(H2), 단 사람 대기 관측은 이 도구가 더 낫다.** `worker-show` 의 `observation.agentWait` 는 사람만 답할 수
있는 프롬프트에 멈춘 워커를 **그 근거와 함께** 이름 짓는다. **null = 보았고 없었다, 필드 부재 = 보지 않았다**
(오래된 호스트·증명 불가한 신원·읽을 수 없는 pane·시간 내 응답 없는 탐침) — **필드 부재를 "안 기다린다" 로
읽지 않는다.** 계약이 "기다리는 워커는 건강한 것이고 실패가 아니다" 라고 적는다.

### 상황 → 행동
- **차단 화면**: 이 능력으로 본다. 『준비 대기』가 차단을 가리지 못하므로 **첫 지시 전 화면 읽기가 이 도구에서는
  선택이 아니다.**
- **타임아웃·빈 결과**: 기본 읽기는 **누적 출력**이고 escape 가 제거된 상태라, 줄을 다시 그리는 프로그램은
  조각으로 쌓여 온다(계약의 예: `clear` 한 번이 `cclclecleaclear` 로 보인다). **렌더된 화면이 필요하면
  `--screen`** 을 쓴다. `--screen` 과 `--cursor` 는 상호배타다.
- **부분 실패**: 응답의 `source` 가 `stream`·`screen`·`screen-unavailable` 을 구분한다. 필드 부재는 오래된
  호스트다. `draft` 는 UI 전용 작성 중 텍스트이니 **출력이나 제출된 지시로 읽지 않는다.**
- **복구**: 명령 응답을 잡을 때는 보내기 전에 한 번 읽고, 기다린 뒤 `--cursor <이전 nextCursor>` 로 새 출력만 읽는다.
  `worker-read` 의 커서는 소스에 고정되므로 `source_changed` 면 새로 읽는다.
- **하지 말 우회**: 화면 문장을 『완료 감지』 대용으로 쓰지 않는다. `--source transcript` 가 있다고 transcript 가
  항상 있는 것은 아니다 — 계약이 "훅이 보고한 transcript 가 **있을 때**" 라고 적는다.

## 『회수·정리』

### 명령
```bash
orca orchestration worker-retain  --dispatch <dispatch_id> --json
orca orchestration worker-release --dispatch <dispatch_id> --json
orca orchestration worker-stop    --dispatch <dispatch_id> --json
orca orchestration worker-abandon --dispatch <dispatch_id> --json
orca orchestration worker-list [--run <run_id>] [--terminal-state <상태>] --json
orca terminal close ([--terminal <handle>] [--tab] | --worktree <selector> --all) --json
```

### 보장 수준
**증명(계약) — 단 "닫아도 되는가" 에 대해서만이다.** 이 칸은 보장 요약의 세대 불변(공백)과 다른 것을 말한다:
계약은 **잘못된 대상을 닫지 않겠다**고 약속하고, **내가 맡긴 pane 이 그대로인지 알려주겠다**고는 약속하지 않는다.
`worker-release` 는 정산된(succeeded/failed) 워커의 **정확히 그 코디네이터 소유 에이전트
터미널만** 닫고, **setup 터미널·설정된 탭·재사용되거나 이미 있던 터미널·사용자가 가져간 터미널·증명되지 않은
신원은 절대 닫지 않는다.** 멱등이고 반복하면 `already_released` 다. **`release_unknown` 만 exit 1** 이고
`retained`·`release_pending`·`already_released` 는 exit 0 이다 — **exit 0 을 "닫혔다" 로 읽으면 틀린다.**
닫기 전에 출력 아카이브가 보존되므로 `worker-read` 가 그 뒤에도 답한다. 미실행.

### 상황 → 행동
- **차단 화면**: 해당 없음.
- **타임아웃·빈 결과**: `worker-list` 의 terminal state(`active`·`reclaimable`·`retained`·`release_pending`·
  `release_unknown`·`released`)는 **프로세스 회계이고 Task 상태와 별개다** — 완료된 Task 가 살아 있는 터미널을
  소유할 수 있다.
- **부분 실패**: **H5 — 빌린 pane 은 남는다.** `dispatch` 로 만든 문맥 전용 Dispatch 는 소유한 터미널 자원이
  없어 프로세스 조치 없이 `retained` 로 보고된다. 사람이 만든 pane 은 `terminal close` 로 따로 닫는다.
- **복구**: `worker-abandon` 은 **살아 있을 수 있는 자원을 모두 보존하고 프로세스·파일시스템에 아무 조치도 하지
  않는다** — 손댈 수 없는 워커에 쓴다. `worker-stop` 은 그 Dispatch 만 fence 하고 worktree·setup 터미널·설정된
  탭·무관한 프로세스를 **절대 지우지 않는다.**
- **하지 말 우회**: `terminal close --worktree <selector> --all` 은 그 작업 공간의 **모든** 터미널 프로세스를
  멈추고 탭·레이아웃·재개 기록까지 지운다 — 워커 하나 정리하는 데 쓰지 않는다. 나중에 재개할 것이면
  계약이 작업 공간 Sleep 을 쓰라고 적는다. `terminal stop` 은 폐기 예정 별칭이다.

## 『세션 기록 오라클』

### 명령
```bash
# 1) 이 pane 이 소유한 기록의 경로를 응답에서 꺼낸다 (짐작하지 않는다)
#    worker-start → result.input.agent.sessionRecord.path · terminal prompt → result.record.path
# 2) 그 경로를 인자로 주고 읽는다 — 무엇이 들어갔고(user) 무엇이 응답됐나(assistant)
jq -r 'select(.type=="user" or .type=="assistant")
       | [.type, (.message.role // "-"),
          ((.message.content | if type=="array"
             then (map(.text // ("["+(.type//"?")+"]")) | join(" "))
             else (. // "") end) | tostring | gsub("\\s+";" ") | .[0:80])]
       | @tsv' <세션 기록 .jsonl 절대경로>
# 3) 줄 종류만 세고 싶으면
jq -r '.type' <세션 기록 .jsonl 절대경로> | sort | uniq -c | sort -rn
```

**이 방법은 이 일감에서 1회 실행했다** — `raw/claude/fix1-m5-session-record-read.txt`
(C6 3회차 자식 워커의 기록 62줄 중 user 4·assistant 4. 주입 본문 2건과 응답 2건이 그대로 보였고,
**두 user 줄의 모양이 같아 사람 입력과 주입 입력을 가를 필드가 없다는 것이 재확인됐다**).
Codex·Grok 판도 같은 형태의 JSONL 이지만 필드 이름이 다르므로 **먼저 한 줄을 열어 키를 확인한 뒤** 같은 요령으로 읽는다.

**⚠ `specs/*/raw/` 의 옛 스크립트를 명령으로 적지 않는다.** 그 폴더의 파일은 누출 점검 도구가 절대경로류
문자열을 `<p:…>` 로 치환해 커밋한 것이라 **문법부터 깨져 있다**(`b2-oracle-*.mjs` 3개 모두 `node --check` 실패).
근거로 **인용**만 하고, 실행 방법은 위처럼 이 매핑에 직접 적는다.

```bash
orca orchestration worker-read --dispatch <dispatch_id> --source transcript --json   # 훅 transcript 가 있을 때만
```

### 보장 수준
**관측.** 기본 소스(`auto`)는 "훅이 보고한 정확한 transcript 가 **있을 때** 그것을, 없으면 라벨 붙은 터미널
출력" 을 준다 — **어느 쪽을 받았는지 응답으로 구분해야 한다.** 사람이 기록 파일을 직접 읽는 경로는 H1·H6 그대로
관측이고, 사람 입력과 주입 입력을 가르는 필드는 없다.

### 상황 → 행동
- **차단 화면**: 해당 없음.
- **타임아웃·빈 결과**: 기록이 없는 것은 배달 실패의 증거가 아니다(H1).
- **부분 실패**: `source_changed` 면 커서를 버리고 새로 읽는다.
- **복구**: transcript 가 없으면 터미널 출력으로 떨어진다 — 그 사실을 근거 칸에 적는다.
- **하지 말 우회**: transcript 가 있었다는 것을 『본문 주입』의 배달 증명으로 승격하지 않는다.
  이 도구의 배달은 공백이다.

## 『제어 문맥 격리』

### 명령
```bash
orca orchestration run-current [--from <handle>] --json
orca orchestration run-create --objective "<목적>" --json
orca orchestration run-use --id <run_id> [--takeover-legacy] --json
# 그리고 명령마다 --run <run_id> / 필요하면 --from <handle>
```

### 보장 수준
**증명(계약), 그리고 corral 보다 넓다.** 계약이 `run-use` 를 "**이 코디네이터 터미널**을 기존 Run 에 바인딩",
`run-current` 를 "**이 터미널의** 바인딩된 Run" 이라고 적는다 — 바인딩이 터미널 단위다. 더해
**`ask` 도 `--run` 을 받고**, `gate-list --run` 은 바인딩하지 않고 들여다본다. `--from <handle>` 로 호출자
정체를 명시할 수 있다. 미실행.

### 상황 → 행동
- **차단 화면**: 해당 없음.
- **타임아웃·빈 결과**: 없음.
- **부분 실패**: `--takeover-legacy` 는 **바인딩할 실제 코디네이터 에이전트 터미널 안에서** 실행해야 하고
  기존 워커 배정을 보존한다 — 다른 pane 에서 쓰지 않는다.
- **복구**: 바인딩이 의심되면 `run-current --from <handle>` 로 그 handle 기준으로 확인한다.
- **하지 말 우회**: `orchestration reset` 은 Run·Task·메시지를 지우는 명령이다 — **격리 수단으로 쓰지 않는다.**
  격리는 새 Run 과 `--run` 명시로 한다.
