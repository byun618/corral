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
| 본문이 정확히 한 번 전달됐다 | **공백** | managed 에이전트에 본문을 넣고 **도착을 판정하는 명령이 없다.** `terminal send` 는 raw 입력이고 ack 가 없다. 본문 전달 경로는 `worker-start`(일감 본문)·`orca worktree create --prompt`·`orca terminal create --command` 뿐이고, 그 어느 것도 "provider 기록에 정확히 1건" 을 값으로 돌려준다고 적지 않는다 |
| 이 pane 이 맡긴 그 pane 이다 (세대 불변) | **공백** | 계약이 pane 의 **세대·epoch 값을 돌려주는 명령이 없다** — 명령 234개 레지스트리에 `generation`·`pty_replaced`·`pane_gone` 은 0회 등장한다(`grep -i` 로 확인, epoch 1회는 레지스트리의 `cookie set` 항목이 가진 `--expires <epoch>` 뿐이다). `worker-release` 의 "unproven identities / reused or pre-existing terminals 는 절대 닫지 않는다" 는 **닫기 부작용을 제한하는 정책**이고(그 근거는 『회수·정리』에 따로 적었다), 호출자가 "내가 주입한 그 pane 이 그새 교체됐는지" 를 **가려낼 값이 아니다.** 그래서 corral 의 `epoch_changed` 같은 판정을 여기서 기대하지 않는다 |
| 보고가 오래된 시도에서 온 게 아니다 | **증명(활성 task/dispatch id 대조까지)** | `orca orchestration send --type worker_done` 은 "완료는 그 task/dispatch id 로, **dispatched pane 에서만** Task 를 완료시킨다. 안정적인 pane 신원이 없으면 발신 handle 이 dispatch assignee 와 정확히 일치해야 한다" 고 적는다. **자격**: 계약의 대체 판정(handle = assignee)은 *pane 신원이 불안정할 때* 쓰는 것이고, 이 도구에서 pane 신원은 **바로 위 줄대로 공백**이다 — 그래서 **주입 뒤 pane 이 교체된 경우를 가려낼 값이 없다**(corral 의 `epoch_changed` 에 해당하는 것이 없다). 배제되는 것은 "다른 id·다른 handle 의 보고" 까지다 |
| 사람 개입 흔적 | **관측(+ 계약 한 조각)** | `terminal read` 화면(H2). 더해 `worker-show` 의 `observation.agentWait` 가 **사람만 답할 수 있는 프롬프트에 멈춘 워커**를 그 근거(hook·prompt-text·title)와 함께 이름 짓는다. null 은 "보고 없었다", **필드 부재는 "보지 않았다" 이고 절대 "안 기다린다" 가 아니다** |

---

## 이 매핑이 요구하는 명령·토큰 — 선언

`capability-check runtime --tool orca` 가 이 두 블록을 읽어 대조한다. 명령 이름은 **레지스트리**
(`agent-context`)와, 기능 토큰은 **`status` 의 광고**와 대조한다. 어느 블록이든 없거나 비어 있으면
통과가 아니라 **불일치(exit 1)** 다.

```required-commands
status                              # 『전제 점검』
agent-context                       # 『전제 점검』 — 명령 234개 레지스트리
open                                # 앱 열기 (이 매핑을 만들 때 미실행)
orchestration run-create            # 『제어 문맥 격리』
orchestration run-use               # 『제어 문맥 격리』
orchestration run-current           # 『제어 문맥 격리』
orchestration task-create           # 『감독 워커 기동』
orchestration worker-start          # 『감독 워커 기동』
orchestration dispatch-show         # 『감독 워커 기동』
orchestration check                 # 『완료 감지』 — --wait (corral 의 --block 이 아니다)
orchestration inbox                 # 『완료 감지』 — 확인 없이 들여다본다
orchestration send                  # 『완료 감지』 — **워커가** worker_done 을 보낸다
orchestration ask                   # 『질의응답』 (corral 과 달리 --run 을 받는다)
orchestration reply                 # 『질의응답』
orchestration worker-show           # 『회수·정리』·사람 개입(observation.agentWait)
orchestration worker-read           # 『회수·정리』 — 닫은 뒤에도 답한다
orchestration worker-list           # 『회수·정리』 — terminal state 회계
orchestration worker-retain         # 『회수·정리』
orchestration worker-release        # 『회수·정리』 — release_unknown 만 exit 1
orchestration worker-stop           # 『회수·정리』
orchestration worker-abandon        # 『회수·정리』
terminal create                     # 『세션 기동』
terminal wait                       # 『준비 대기』 — --for exit|tui-idle 뿐 (agent-ready 없음)
terminal read                       # 『화면 관측』
terminal show                       # 『세션 기동』 관측
terminal send                       # 『본문 주입』 — ack 가 없다 (배달 = 공백)
terminal close                      # 『회수·정리』
worktree create                     # 『세션 기동』 — --prompt 로 본문을 실을 수 있다
```

```required-tokens
orchestration.contract.v1                 # 『감독 워커 기동』·『완료 감지』·『질의응답』
terminal.multiplex.v1                     # 『세션 기동』·『화면 관측』 — pane 다중화
orchestration.worker-stop-verdict.v1      # 『회수·정리』 — worker-stop 의 판정
```

```mentioned-commands
terminal prompt                     # **orca 에 없다** — 배달 증명이 공백인 근거. 이름만 적는다
orchestration request-show          # 레지스트리엔 있고 361줄 --help 목록엔 없다 — 실행 지시로 쓰지 않는다(위 「두 오라클」)
orchestration gate-list             # --run 을 받는 명령 목록에만 나온다 — 이 매핑은 호출하지 않는다
orchestration dispatch              # 문맥 전용 Dispatch — H5 설명에만 나온다
orchestration reset                 # Run·Task·메시지를 지우는 명령 — "격리 수단으로 쓰지 말라" 를 적기 위한 언급
orchestration coordinator-start     # 폐기된 레거시 별칭 — 쓰지 않는다
orchestration coordinator-stop      # 같은 위
terminal stop                       # 폐기 예정 별칭 — 쓰지 않는다
cookie set                          # M2 근거(레지스트리에서 epoch 이 나오는 유일한 자리)로만 인용
```

**『세션 기록 오라클』은 orca 명령이 아니다** — `jq` 로 기록을 직접 읽는다.

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
- **이 점검이 보지 않는 것 — 프로필 선택.** **orca 는 `--socket`·`--instance` 를 받지 않는다**
  (레지스트리 실측 usage 는 `orca status [--json]`·`orca agent-context [--json]` 뿐이다). corral 에서 쓰는
  프로필 인자를 이 도구에 주면 **점검이 exit 2 로 죽는다** — 런타임 이상이 아니라 인자가 없는 것이다.
  여러 인스턴스를 가려 보는 축은 이 도구에서 **공백**이고, 원격은 명령별 `--on <saved-environment>` 가 대신한다
  (그건 프로필 선택이 아니라 실행 위치 선택이다).
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
"기존 체크아웃에 새 에이전트를 띄울 때는 `orca terminal create --worktree active --command "codex"` 를 쓰라" 고 적는다).
모델·effort 는 `orca orchestration worker-start --model/--effort` 로만 주고 **`--effort` 는 `--model` 을 요구하며 둘 다 `--terminal`
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
- **복구**: 차단이면 사람이 GUI 에서 치운다. `orca terminal send --text … --enter` 로 치우는 것은 **화면을 읽어
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
- **차단 화면**: 차단 화면에 `orca terminal send` 를 하면 그 화면에 대한 대답으로 먹힌다 — 본문이 사라지고 흔적도 남지 않는다.
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
  `--on` 은 **워커 서버만** 고르고 Run 과 이 명령은 현재 호스트에 남는다. 원격에서 `--worktree current`·`--worktree new-child` 는 무효다.
- **복구**: `--retry-of <dispatch_id>` 로 교체 시도를 연결한다 — 배치는 물려받지 않으니 다시 적는다.
  **응답을 잃었을 때(요청이 갔는지 모를 때)는 이렇게 본다** — `--help` 목록에 있는 두 조회로만 적는다:
  ① `orca orchestration dispatch-show --task <task_id>` 로 **그 Task 에 시도가 생겼는지** 본다
  ② 시도 id 가 있으면 `orca orchestration worker-show --dispatch <dispatch_id>` 로 그 시도의 상태·채택된 터미널을 본다.
  **둘 다 아무것도 안 보이면 거기서 멈춘다 — 이 도구의 복구는 공백이다.**
  요청이 실제로 실행됐는지(영수증)를 묻는 명령을 이 매핑은 쓰지 않는다(아래 「두 오라클이 갈리는 자리」).
  그래서 **조회로 가려지지 않는 상태에서 다시 기동하지 않는다** — 중복 기동은 같은 Task 에 두 번째 시도를
  만들 수 있고, 그것이 첫 시도를 밀어낸다. 사람에게 알리고 화면을 보게 한다.
  **메시지 조회(`inbox`)를 이 자리에 쓰지 않는다** — 그것은 워커가 **보낸 메시지**를 보는 것이고,
  내 기동 요청이 실행됐는지는 알려주지 않는다(라운드 3 회귀 지적).
- **하지 말 우회**: `dispatch` 로 만든 문맥 전용 Dispatch 를 감독 워커로 세지 않는다 — 계약이 그것을
  `unsupervised`·terminal state `retained` 로 보고한다. 레거시 `orchestration coordinator-start`/`orchestration coordinator-stop` 은
  아무 효과가 없는 명령이다(계약 스스로 그렇게 적는다) — 쓰지 않는다.

### 재사용 인자 규칙 (절차 문서가 가리키는 그 규칙)

**재사용 때 `--terminal <handle>` 과 그 터미널의 `--worktree` 를 함께 준다.** 계약이 그대로 적는다:
"When reusing --terminal, pass --worktree for that terminal; current means the coordinator worktree."
`--worktree current` 는 코디네이터 worktree 를 뜻하므로, **워커 worktree 를 쓰려면 그 selector 를 명시해야 한다.**

**corral 과 정반대라는 점이 이 규칙의 핵심이다** — corral 은 재사용에 `--worktree` 를 붙이면 거절하고,
orca 는 빼면 잘못된 작업 공간으로 붙는다. 그래서 절차 문서는 "매핑의 재사용 인자 규칙을 따른다" 만 적고
실제 인자는 이 표에서 읽는다. 미실행(읽기 전용 매핑).

## 『완료 감지』

### 명령
```bash
orca orchestration check [--run <run_id>] [--ack <delivery_id>] [--types <type,...>] [--wait] \
  [--timeout-ms <n>] --json
orca orchestration worker-show --dispatch <dispatch_id> --json
orca orchestration inbox [--limit <n>] [--terminal <handle>] [--full] --json   # 확인(ACK) 없이 들여다본다
# ↓ 워커 쪽이 치는 명령. 코디네이터가 "완료 감지" 를 말할 때 반대편에서 이게 돌고 있다
orca orchestration send --type <type> --task-id <task_id> --dispatch-id <dispatch_id> \
  --subject <제목> [--body <본문>] [--outcome succeeded|failed] [--run <run_id>] --json
```

**인자 이름이 corral 과 어긋나는 곳** — 여기서 틀리면 `invalid_argument` 다: 보고는 `--task-id`·`--dispatch-id`
(corral 도 같다) 이지만 **`inbox` 는 `--run` 을 받지 않는다**(`--limit`·`--terminal`·`--full` 뿐이다).
**두 오라클이 갈리는 자리 — 영수증 조회.** `orchestration request-show` 는 레지스트리에는 있고
**361줄 `orca --help` 목록에는 없다**(사용자 기계 실측). C4 의 통과선이 `--help` 실측 존재이므로
**이 매핑은 그 명령으로 실행을 지시하지 않는다.** 이름은 `mentioned-commands` 에 사유와 함께만 올렸고
『전제 점검』은 이 이름이 **명령줄로 다시 등장하면 멈춘다**(R1b).

그 결과 **이 도구에는 "요청이 이미 실행됐나" 를 묻는 수단이 없다 — 그 자리는 공백이다.**
다른 명령으로 대신하지 않는다. 특히 메시지 조회는 대체물이 **아니다**: 계약이 적는 일이 서로 다르다 —
`orchestration inbox` 는 *Show messages across (or for) recipients* 이고 request id 를 받지 않는다.
공백을 메우려면 두 오라클의 불일치를 먼저 해소하고(예: 사용자 확인 하에 서브명령 도움말 실행) 그 결과를 적는다.
그 전까지 응답 유실 상황의 규칙은 하나다 — **가려지지 않으면 다시 기동하지 않는다.**

### 보장 수준
**증명(계약).** 완료는 `orca orchestration send --type worker_done` 이고 `--outcome succeeded|failed` 가 필수다. 계약이
"활성 task/dispatch id 를 담은 `worker_done` 은 **그 dispatched pane 에서만** 그 Task 를 완료시키고, 안정적인
pane 신원이 없으면 발신 handle 이 dispatch assignee 와 정확히 일치해야 한다" 고 적는다 — 오래된 시도·다른
pane 의 보고를 배제하는 장치가 계약에 있다. `orca orchestration check` 는 바인딩된 Run 의 **가장 오래된 미확인 FIFO 배치**를
돌려주고 `--ack` 전까지 같은 Delivery 를 되돌린다. 미실행.

### 상황 → 행동
- **차단 화면**: 완료 감지 경로에서는 보이지 않는다. 차단은 『화면 관측』 또는 `worker-show` 의
  `observation.agentWait` 로 본다.
- **타임아웃·빈 결과**: `--wait` 는 **`--block` 이 아니다**(corral 과 플래그 이름이 다르다). 대기 중
  **15초마다 stderr 로 JSON keepalive 줄**을 뿜으므로 stdout 과 섞어 파이프할 때 `_keepalive` 를 걸러야 한다.
  `_keepalive` 는 heartbeat 메시지와 무관하다. 빈 배치는 새 워커를 만드는 근거가 아니다.
- **부분 실패**: 바인딩된 Run 은 `--ack` 전까지 같은 Delivery 를 되돌린다 — **확인 전에 배치의 모든 메시지를
  처리한다.** `--ack` 는 직전 배치 전체에만 적용된다.
- **복구**: `orca orchestration inbox --full` 로 수신자별 전체를 본다(옵션은 `--limit`·`--terminal`·`--full` 뿐이다).
  읽음 표시를 남기지 않는 조회는 **같은 명령의 옵션이 아니라 `orchestration check` 쪽**이다 —
  `orca orchestration check --peek` 는 확인 없이, `orca orchestration check --all` 은 그 handle 의 전체를 준다
  (`--unread`·`--peek`·`--all` 은 서로 배타다). 주어를 섞으면 `invalid_argument` 다.
- **하지 말 우회**: `orca terminal wait --for exit` 을 완료로 쓰지 않는다 — provider 가 죽은 것과 일을 끝낸 것은 다르다.
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
- **차단 화면**: 해당 없음 — 질문·답은 구조화된 메시지 경로이고 pane 화면을 거치지 않는다.
- **타임아웃·빈 결과**: 상한 수치가 레지스트리에 적혀 있지 않다 — **공백.** 필요하면 실측해 적는다.
  타임아웃 뒤에는 `--resume <원래 id>` 를 쓴다. 다시 물으면 중복 질문이 된다.
- **부분 실패**: 워커 보고(`worker_done`·`heartbeat`)는 그룹 주소로 보낼 수 없고 `--to` 를 비워 Dispatch 의
  Run mailbox 로 보낸다.
- **복구**: 답을 보낼 때는 **같은 orca 실행 파일**로 `orca orchestration reply --id` 를 쓴다(계약이 명시).
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
  조각으로 쌓여 온다(계약의 예: 셸에서 clear 한 번이 `cclclecleaclear` 로 보인다). **렌더된 화면이 필요하면
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
- **차단 화면**: 해당 없음 — 보존·회수는 구조화된 조회·정리이고 pane 에 입력을 넣지 않는다.
- **타임아웃·빈 결과**: `worker-list` 의 terminal state(`active`·`reclaimable`·`retained`·`release_pending`·
  `release_unknown`·`released`)는 **프로세스 회계이고 Task 상태와 별개다** — 완료된 Task 가 살아 있는 터미널을
  소유할 수 있다.
- **부분 실패**: **H5 — 빌린 pane 은 남는다.** `dispatch` 로 만든 문맥 전용 Dispatch 는 소유한 터미널 자원이
  없어 프로세스 조치 없이 `retained` 로 보고된다. 사람이 만든 pane 은 `terminal close` 로 따로 닫는다.
- **복구**: `worker-abandon` 은 **살아 있을 수 있는 자원을 모두 보존하고 프로세스·파일시스템에 아무 조치도 하지
  않는다** — 손댈 수 없는 워커에 쓴다. `worker-stop` 은 그 Dispatch 만 fence 하고 worktree·setup 터미널·설정된
  탭·무관한 프로세스를 **절대 지우지 않는다.**
- **하지 말 우회**: `orca terminal close --worktree <selector> --all` 은 그 작업 공간의 **모든** 터미널 프로세스를
  멈추고 탭·레이아웃·재개 기록까지 지운다 — 워커 하나 정리하는 데 쓰지 않는다. 나중에 재개할 것이면
  계약이 작업 공간 Sleep 을 쓰라고 적는다. `terminal stop` 은 폐기 예정 별칭이다(쓰지 않는다).

## 『세션 기록 오라클』

### 명령

**orca 의 1차 수단은 자기 계약의 transcript 다** — corral 의 응답 필드를 여기 옮겨 적지 않는다(N2 정정).

```bash
orca orchestration worker-read --dispatch <dispatch_id> --source transcript --json   # 훅 transcript 가 있을 때만
orca orchestration worker-read --dispatch <dispatch_id> --json                       # auto: transcript 없으면 터미널 출력
```

**provider 기록 파일을 직접 읽어야 하면 경로를 어떻게 얻나 — 여기가 이 도구의 공백이다.**
레지스트리 명령 234개에 **`sessionRecord` 는 0회** 등장한다(`grep -c` 로 확인). 즉 orca 는 "이 pane 이 소유한
기록 파일" 을 값으로 돌려주지 않는다. 그래서 순서는 이렇다:

1. `worker-read` 의 transcript 로 **먼저** 본다. 응답이 transcript 인지 터미널 출력인지 **구분해 적는다.**
2. 그래도 파일을 봐야 하면 H6 의 홈 경로에서 **후보를 좁힌다** — worktree(cwd)와 기동 시각으로 고른다.
   **어느 파일이 이 pane 의 것인지 증명할 수단은 없다**(corral 의 소유 증명에 해당하는 것이 없다).
   그러므로 이 경로로 얻은 것은 "후보 파일의 관측" 이고, 판정표에는 **공백**으로 적는다.
3. 파일을 골랐으면 읽는 방법은 corral 과 같다:

```bash
# 무엇이 들어갔고(user) 무엇이 응답됐나(assistant) — 경로를 인자로 준다
jq -r 'select(.type=="user" or .type=="assistant")
       | [.type, (.message.role // "-"),
          ((.message.content | if type=="array"
             then (map(.text // ("["+(.type//"?")+"]")) | join(" "))
             else (. // "") end) | tostring | gsub("\\s+";" ") | .[0:80])]
       | @tsv' <세션 기록 .jsonl 절대경로>
jq -r '.type' <세션 기록 .jsonl 절대경로> | sort | uniq -c | sort -rn   # 줄 종류만 세기
```

**⚠ `specs/*/raw/` 의 옛 스크립트를 명령으로 적지 않는다.** 누출 점검 도구가 절대경로류 문자열을 `<p:…>` 로
치환해 커밋했으므로 문법부터 깨져 있다(`b2-oracle-*.mjs` 3개 `node --check` 실패). 근거로 **인용**만 한다.

**이 절의 실행 근거**: `worker-read` 는 **미실행**이다(읽기 전용 매핑). 아래 jq 는 corral 로 띄운 Claude
세션에서 1회 실행했고(`raw/claude/fix1-m5-session-record-read.txt`) **그것은 읽는 방법의 근거일 뿐
orca 경로 확보의 근거가 아니다.** Codex·Grok 판은 필드 이름이 달라 **먼저 한 줄을 열어 키를 확인한다.**

### 보장 수준
**관측.** 기본 소스(`auto`)는 "훅이 보고한 정확한 transcript 가 **있을 때** 그것을, 없으면 라벨 붙은 터미널
출력" 을 준다 — **어느 쪽을 받았는지 응답으로 구분해야 한다.** 사람이 기록 파일을 직접 읽는 경로는 H1·H6 그대로
관측이고, 사람 입력과 주입 입력을 가르는 필드는 없다.

### 상황 → 행동
- **차단 화면**: 해당 없음 — 기록 파일을 읽는 것뿐이라 화면을 거치지 않는다.
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
**`ask` 도 `--run` 을 받고**, `orchestration gate-list` 는 `--run` 을 받되 바인딩하지 않고 들여다본다. `--from <handle>` 로 호출자
정체를 명시할 수 있다. 미실행.

### 상황 → 행동
- **차단 화면**: 해당 없음 — Run 바인딩 조회·전환은 화면과 무관하다.
- **타임아웃·빈 결과**: 바인딩 조회는 로컬 상태라 기다릴 것이 없다. **빈 결과는 "아직 어느 Run 에도 바인딩되지 않았다" 는 뜻**이고 실패가 아니다 — 그 상태에서 `--run` 없이 치면 엉뚱한 곳으로 가지 않고 거절되거나 새로 만든다.
- **부분 실패**: `--takeover-legacy` 는 **바인딩할 실제 코디네이터 에이전트 터미널 안에서** 실행해야 하고
  기존 워커 배정을 보존한다 — 다른 pane 에서 쓰지 않는다.
- **복구**: 바인딩이 의심되면 `orca orchestration run-current --from <handle>` 로 그 handle 기준으로 확인한다.
- **하지 말 우회**: `orchestration reset` 은 Run·Task·메시지를 지우는 명령이다 — **격리 수단으로 쓰지 않는다.**
  격리는 새 Run 과 `--run` 명시로 한다.
