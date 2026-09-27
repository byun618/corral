# corral 매핑 — 능력 → 명령

능력 이름과 보장 어휘(증명/관측/공백)의 정본은 [capabilities.md](capabilities.md). 이 파일은 그 능력을
corral CLI 로 어떻게 수행하고, **무엇까지 증명되는지**를 적는다. 실측 원본은
`specs/LIFE-440-harness-capability-map/raw/claude/c3-corral-help.txt`(`corral <명령> --help` 36줄)와
`c3-corral-agent-context.json`(명령 58개의 시그니처·주의사항, 2026-09-27 실측).

## 이 도구를 쓰기 위한 전제

- **H7 — `corral` 은 npm-link 로 본체 `app/cli` 에 풀린다. 셸의 node 버전에 따라 아예 보이지 않는다.**
  이 머신에서는 `$HOME/.nvm/versions/node/v22.22.2/bin` 에만 있다. PATH 앞에 그 경로를 두거나
  `node <worktree>/app/cli/corral.mjs` 절대경로로 부른다. `command -v corral` 이 비면 도구 부재가 아니라
  PATH 문제로 먼저 의심한다.
- 모든 명령은 로컬 Unix 소켓 클라이언트다. `--socket` 을 생략하면 기본 프로필 소켓
  (`~/Library/Application Support/corral/runtime/rpc.sock`)에 붙는다 — 실측으로 같은 `runtimeId` 였다
  (`raw/claude/c6-socket-default.txt`). 다른 프로필·인스턴스를 쓸 때만 `--socket`·`--instance` 를 명시한다.
  **예외: `agent-context` 는 순수 로컬 레지스트리 읽기라 `--socket` 을 거절한다**(`invalid_argument`).
- 공통 플래그는 `--json`·`--timeout-ms`·`--request-id`. **`--timeout-ms` 상한은 `orchestration check` ·
  `orchestration ask` 만 600000 이고 나머지는 120000 이다** (초과는 `--timeout-ms must be 1..120000` 거절 —
  `raw/corral/a-03-wait-timeout-120001.json`).
- 재시도는 **같은 `--request-id` 를 다시 보내는 것**이다. 별도 retry 플래그는 없다. 같은 id + 다른 입력은
  `request_conflict`, 아직 기록되지 않은 영수증은 `outcome_unknown` 이고 **절대 자동 재실행되지 않는다**.
  영수증 보존은 24시간이다. `absent` 는 "아무 일도 없었다" 가 아니다.
- **H3 — 문서가 시그니처를 적지 않으면 추측한 플래그가 거절된다.** 실측으로 확인된 세 형태:
  `worker-stop` 에 `--reason` 없음(있는 쪽은 `worker-retain`) · `dispatch-show` 는 `--id`(또는 `--task`),
  `--dispatch` 아님 · `terminal wait --timeout-ms` 상한 120000. 근거
  `raw/corral/a-04-worker-stop-reason.json` · `a-05-dispatch-show-dispatch.json` · `a-03-wait-timeout-120001.json`.
- **H1' — 큰 본문은 파일로 넣는다.** `terminal prompt --file <경로>` 또는 `orchestration worker-start --spec-file <경로>`.
  `task-create` 에는 `--spec-file` 이 **없다**(`--spec` 만). 워커 본문은 preamble 이 한 번에 들어가야 하므로
  **49152 바이트 이하**여야 한다.

## 보장 요약 (네 가지 증명 대상)

| 증명 대상 | 수준 | 무엇이 그것을 돌려주는가 |
| --- | --- | --- |
| 본문이 정확히 한 번 전달됐다 | **증명** | `terminal prompt --wait accepted` 의 `outcome: completed` + `record.matchCount: 1` + `wait.satisfied`. 제출 창 안에서 정확히 1건 일치일 때만 `stage: confirmed`·`phase: accepted`. 2건 이상은 "확인된 1회" 가 아니라 **한 입력 규칙이 깨진 것**으로 보고된다 |
| 이 pane 이 맡긴 그 pane 이다 (세대 불변) | **증명** | handle 에 프로필·backend 부팅·PTY 세대가 묶여 있고, reconcile 이 `pane_gone`·`pty_replaced`·`epoch_changed` 로 시도를 `unknown` 으로 정산한다. 정리는 닫기 직전 같은 세대를 다시 관측하고 같은 lane 안에서 닫는다 |
| 보고가 오래된 시도에서 온 게 아니다 | **증명** | 워커 보고는 `--task-id`·`--dispatch-id` + pane 신원(`HERDR_PANE_ID`·`HERDR_SESSION`)으로 검사된다. 다른 pane = `sender_mismatch`, 사라진 pane·교체된 시도 = `stale_dispatch`, 두 번째 완료 보고 = `illegal_transition`, 정산·중단·회수된 시도 = `capability_revoked`. **거절은 아무것도 저장하지 않는다** |
| 사람 개입 흔적 | **관측** | `terminal read` 화면뿐(H2). 구조화된 조회는 GUI 직접 입력을 보지 못한다. `worker-retain --reason user_takeover` 는 **사람이 선언하는 기록**이지 감지가 아니다 |

---

## 『전제 점검』

### 명령
```bash
corral status --json                      # runtime.state·reachable·capabilities(명령 이름 58개)
node .agents/harness/capability-check.mjs runtime --tool corral   # 매핑 요구 능력 ↔ 광고 대조
corral agent-context --json               # 명령별 시그니처·주의사항 (--socket 거절)
```

### 보장 수준
**증명.** `status` 의 `runtime.capabilities` 는 **명령 이름 집합**이다(`terminal prompt`,
`orchestration worker-start` …). 대조 스크립트가 이 매핑이 요구하는 명령 이름을 그 집합과 차집합으로 비교하고
빠진 것이 있으면 0 이 아닌 종료로 멈춘다. `status` 가 exit 1 이면 런타임이 꺼진 것이다.

### 상황 → 행동
- **차단 화면**: 해당 없음 — 점검 명령은 pane 을 열지 않는다.
- **타임아웃·빈 결과**: `status` 가 응답하지 않거나 `reachable: false` 면 런타임이 없다. 다른 도구로 몰래
  대체하지 않고 원인을 보고한다. `capabilities` 가 비어 오는 것은 **광고 부재**이지 통과가 아니다.
- **부분 실패**: 광고에는 있는데 실제 호출이 거절되면 광고가 아니라 **실측을 믿는다** — 거절 원문을 원자료로
  남기고 이 매핑을 고친다.
- **복구**: 런타임이 꺼져 있으면 사용자가 데스크톱 앱을 띄운다. 런타임·backend 는
  `CLAUDE_CODE_*`·`CLAUDECODE`·`CLAUDE_PID`·`CLAUDE_EFFORT`·`ORCA_AGENT_HOOK_*` 를 **제거한 env** 로 띄운다
  (`app/scripts/l394/env.mjs` 규칙). pane 이 backend 에서 env 를 상속하므로 마커가 남으면 provider 가 세션
  기록을 쓰지 않아 『본문 주입』의 배달 판정이 조용히 무력화된다 — `record.unavailableReason` 이 null 이 아니면
  마커 상속부터 의심한다.
- **하지 말 우회**: 시작 세션에서 됐다는 이유로 이 점검을 생략하지 않는다. 대조 불일치를 "아마 될 것" 으로
  넘기지 않는다.

## 『세션 기동』

### 명령
```bash
corral terminal create --worktree path:<절대경로> --title "<제목>" \
  --agent claude|codex|grok [--model <id>] [--effort <등급>] [--advisor fable] [--focus] --json
corral terminal show --terminal <handle> --json     # provider 프로세스·argv
corral terminal read --terminal <handle> --screen --json   # 배너
```

### 보장 수준
**관측.** 기동 자체는 계약이지만 **모델·advisor 가 실제로 무엇으로 해소됐는지는 관측이다.** dispatch 스냅샷은
기동 시점 관측이라 갱신되지 않고 `resolvedModel: null` 일 수 있다. argv(`terminal show`)와 배너(`terminal read`)로
기록하고 **요청값과 관측값을 구분해 적는다.** 별칭(`opus`·`fable`)은 버전 고정이 아니다.

### 상황 → 행동
- **차단 화면**: `--prompt` 를 함께 준 경우, 차단이 먼저 뜨면 create 는 거기서 끝나고(complete) 본문을 들고
  있지 않는다 — 별도 `terminal prompt` 로 자기 `--request-id` 아래 다시 넣는다.
- **타임아웃·빈 결과**: `terminal create` 응답 타임아웃은 실패가 아니라 **지연일 수 있다.** 같은 worktree 의
  `corral terminal list` 로 그 도구 터미널을 먼저 찾고, 살아 있으면 그 handle 을 기록해 재사용한다. 확인 없이 재시도해
  중복 세션을 만들지 않는다.
- **부분 실패**: 단계별 상태(`stages` = worktree·terminal·agent·prompt)가 정본이다. 만들어진 git worktree 는
  뒤 단계 실패로 지워지지 않고, 관측되지 않은 단계는 `unknown` 으로 남고 재시도되지 않는다.
- **복구**: `--focus` 때문에 문제가 나면 `--focus` 를 빼고 만든 뒤 `corral terminal switch` 를 쓴다. 헤드리스에서는
  `switch`·`create --focus` 가 미지원이다.
- **하지 말 우회**: `--command` 로 provider argv 를 문자열로 조립하지 않는다 — `--command` 와 `--agent` 는
  상호배타이고 위반은 효과 없는 `invalid_request` 다. `--model`·`--effort`·`--advisor`·`--prompt` 는 `--agent`
  필수, `--advisor` 는 `--agent claude` 에만 붙는다. 모델 접근·사용량으로 못 띄우면 **다른 모델로 조용히
  대체하지 않고** 차단을 보고한다.

## 『준비 대기』

### 명령
```bash
corral terminal wait --terminal <handle> --for agent-ready --timeout-ms 60000 --json
# --for 는 ready|output|exit|agent-ready|agent-idle
```

### 보장 수준
**증명.** 준비·차단·타임아웃이 서로 다른 값으로 돌아온다. agent-ready 는 750ms 간격 두 관측이 모두
idle/done·interactive_ready·launch 대기 아님이고 같은 `state_change_seq` 를 공유하며, **가드가 그 provider 의
기대 detect manifest 를 보고한 경우**에만 만족이다. 차단 화면과 미검증 manifest 는 **기다리지 않고 즉시**
`satisfied: false` 로 돌아오고 이유가 `agent.evidence` 에 담긴다.

### 상황 → 행동
- **차단 화면**: trust·로그인·업데이트 화면은 corral 이 대답하지 않는다 — **사람이 치운다.** 단
  **차단 판정의 유일한 근거는 detect manifest 의 label 이다.** label 되지 않은 모달은 agent-ready 를
  그냥 통과한다(실측: codex 0.156.1 업데이트 메뉴). 그래서 **codex pane 은 첫 주입 전에 `terminal read` 로
  화면을 한 번 본다.**
- **타임아웃·빈 결과**: 타임아웃은 준비 완료가 **아니다.** 차단이었는지 그냥 느렸는지는 `agent.evidence`
  (`samples`·`detectManifest`)로 가른다. 만족하지 못한 대기를 준비로 읽고 주입하지 않는다.
- **부분 실패**: 이전에 ready 가 저장돼 있어도 지금 관문이 성립하지 않으면 `launching` 으로 보고된다 —
  저장된 ready 를 근거로 쓰지 않는다.
- **복구**: 화면을 읽어 차단이면 사람이 GUI 에서 치우거나 `corral terminal send` 로 정리한 뒤 다시 대기한다.
- **하지 말 우회**: `--for exit`·`--for output` 을 준비의 대용으로 쓰지 않는다. `agent-idle` 은 같은 술어를
  **다른 시점에** 묻는 것이라 기동 직후 준비 판정에 쓰지 않는다.

## 『본문 주입』

### 명령
```bash
corral terminal prompt --terminal <handle> (--text "<본문>" | --file <경로> | --stdin) \
  --wait accepted --json
```

### 보장 수준
**증명.** `--wait accepted` 가 만족된 `outcome: completed` + `record.matchCount: 1` 이 "정확히 한 번 도착" 이다.
배달과 대기는 **따로 보고된다**: `record.matchCount`/`unavailableReason` 이 배달을, `wait.requested/satisfied/reason`
이 대기를 답한다. `--wait` 없는 주입은 **큐에 들어간 것이지 완료가 아니다.** 응답의 `requestId` 형식은
`r1.<13자리 ms>.<UUID>` 이고, corral 은 **이 pane 이 소유했음을 증명할 수 있는 세션 기록만** 읽는다
(claude·grok 은 민팅한 세션 id, codex 는 cwd·시각이 맞는 rollout 하나). 그런 기록이 없거나 둘 이상이면
matchCount·resolvedModel·record.path 가 모두 unknown 이다 — **다른 세션 파일에서 읽어오지 않는다.**

### 상황 → 행동
- **차단 화면**: 주입은 fail-closed 이고 효과가 없다 — `agent_blocked`(차단 화면),
  `detect_manifest_unverified`(가드 manifest 불일치), `agent_not_ready`(준비 관문 또는 제출 직전
  `state_change_seq` 검사 실패), `prompt_already_delivered`(이미 기록에 그 본문이 있음).
- **타임아웃·빈 결과**: 마감·차단·종료로 대기가 끝나면 `wait.reason` 이 `deadline|agent_blocked|agent_exited` 다.
  `outcome` 은 만족한 대기에서만 `completed` 이고, 그 밖은 `outcome: unknown` 이며 **자동 재제출되지 않는다** —
  이때도 확인된 배달은 함께 보고된다. 그 보고를 먼저 읽고, `matchCount: 1` 이면 다시 넣지 않는다.
- **부분 실패**: `matchCount` 가 2 이상이면 **한 입력 규칙이 이미 깨진 것**이다. 통과로 승격하지 않고 사람에게
  보고한다. `unavailableReason` 이 null 이 아닌 `matchCount: 1` 은 **어느 쪽으로도 증거가 아니다**(커서가 무효화된
  1건과, 기록을 아직 쓰지 않은 provider 의 0건이 같은 모양으로 온다).
- **복구**: 큐 수락(`queued`)·`outcome_unknown` 에서 **중복 주입하지 않는다.** 같은 `--request-id` 로 재전송해
  영수증을 replay 하거나, `corral orchestration request-show --id <request_id>` 로 무엇이 일어났는지 먼저 본다.
- **하지 말 우회**: `terminal send` 는 raw 입력이라 배달 판정이 없다 — managed 에이전트에 지시를 넣는 정본은
  `terminal prompt` 다. 65536 UTF-8 바이트를 넘는 본문은 `--file` 로 넣는다(H1'). NUL 은 거절된다.

## 『감독 워커 기동』

### 명령
```bash
corral orchestration task-create --spec "<일감 명세>" [--title "<제목>"] --run <run_id> --json
corral orchestration worker-start --task <task_id> \
  --agent claude|codex|grok --model <id> --effort <등급> [--advisor fable] \
  --worktree path:<구현 worktree 절대경로> [--spec-file <경로>] --run <run_id> --timeout-ms 120000 --json
corral orchestration worker-start --task <task_id> --terminal <handle> --run <run_id> --json   # pane 재사용
```

### 보장 수준
**증명.** `worker-start` 는 pane 생성 → Dispatch 기록 → 준비 대기 → preamble+본문 주입을 **한 호출로 묶고
제출을 판정한다**: `state: ready` 는 주입이 `outcome: completed` + 만족한 대기였을 때, 또는 그 본문이 provider
기록에 정확히 1건 있을 때만이다. 그 밖은 전부 `state: incomplete`·`stage: dispatch_input_unconfirmed` 이고
`promptRequestId` 가 null 로 남아 **재개 가능**하다. **pane 에 도달하지 못한 Dispatch 가 ready 로 보고되는
경로는 없다.** preamble 은 Dispatch 당 정확히 한 번 도달한다.

### 상황 → 행동
- **차단 화면**: 차단이면 `worker-start` 가 `agent_blocked` 로 거절한다. **`--agent codex` 는 준비→주입이 한
  호출 안에서 원자적이라 중간 화면을 볼 자리가 없다**(`app/src/runtime/orchestration/index.ts` 의 기동 경로) —
  기동 전에 사용자 셸에서 codex 를 최신으로 올리거나, `terminal create --agent codex` → `terminal read` 확인 →
  같은 pane 에 `--terminal <handle>` 로 붙이는 2단을 쓴다. **trust 화면은 사람 몫이다.**
- **타임아웃·빈 결과**: 대기 예산은 `--timeout-ms` 로 주고 상한은 120000 이다. codex 는 같은 과제에서 Claude 보다
  느리고 타임아웃이 잦으니 예산을 넉넉히 잡는다. 타임아웃은 "안 갔다" 가 아니다 — `dispatch-show --task <t>` 로
  시도 상태를 먼저 본다.
- **부분 실패**: 단계별로 보고되고 **실패한 단계가 앞 단계를 되돌리지 않는다** — 남은 것은
  `residualResources` 에 담긴다. `input_line` 항목은 **이전 실행이 pane 입력줄에 타이핑한 한 줄**이고 corral 은
  그것을 지울 수 없다 — 사람이 치운다(기록 기준, 화면 기준이 아니다). `dispatch_input_unprovable` 은 재개로
  수렴하지 않는다 — 사람이 pane 을 읽고 `corral orchestration worker-stop --dispatch <ctx>` 로 끝낸다.
- **복구**: **`--retry-of` 류 플래그는 없다.** 복구는 2단이다 — `terminal read` 로 화면을 보고 차단이면 정리한 뒤
  **같은 Task 에** `worker-start --task <t> --terminal <handle>` 을 다시 부른다. 주입이 확정되지 않은 시도는 같은
  Dispatch 로 재개되고(`launch: resumed`), **이미 주입된 시도가 열려 있으면 `dispatch_active` 로 거절된다.**
  `launch: reused` 는 열린 시도가 없어 시작 가능한 Task 에 기존 pane 을 배정한 **새 시도**다. 재개는 Dispatch
  생성 시 기록된 본문 digest 를 배달하며, 명령줄에 남은 `--spec-file` 은 `ignoredOptions` 에 들어간다.
- **하지 말 우회**: `--terminal` 과 `--agent … --worktree` 를 **동시에 쓰지 않는다**(재사용 pane 은 기동 때의
  agent 를 그대로 쓰므로 `--model`·`--effort`·`--advisor`·`--worktree` 가 거절된다). `--agent` 에는 `--worktree`
  가 필수다. **리뷰어 3명은 Task 를 각각 따로 발급한다** — 같은 Task 로 띄우면 미확정 시도만 조용히 재개되거나
  `dispatch_active` 로 거절된다. 실행 중 Dispatch 위에 같은 terminal 의 새 Dispatch 를 겹쳐 기동하지 않는다.
  pane 재사용은 **소유권을 옮긴다** — 이전 시도는 `borrowed` 가 되고 `ownershipTransferredTo` 에 새 시도가 적힌다.

## 『완료 감지』

### 명령
```bash
corral orchestration check --block --types worker_done,escalation,question \
  --timeout-ms 600000 --run <run_id> --json
corral orchestration check --ack <delivery_id> --block --types … --run <run_id> --json
corral orchestration worker-show --dispatch <ctx_id> --json    # 유실 의심 시 현재 상태 조회
corral orchestration dispatch-show --task <task_id> --json     # 시도 상태·reconcile 기록
```

### 보장 수준
**증명.** 완료는 그 Task·그 Dispatch 의 `worker_done` 이다. `succeeded`/`failed` 모두 종료 보고이고
(`failed` 를 성공으로 처리하지 않는다), 메시지 저장과 시도 정산이 **한 번의 원자적 쓰기**라 둘이 어긋날 수 없다.
Run 은 미확인 Delivery 를 **하나만** 갖고, `--ack` 전까지 같은 배치를 `deliveryReplayed: true` 로 계속 돌려준다
(배치 최대 50건, 그 사이 도착한 메시지는 섞이지 않는다). 파일 존재·TUI idle·프로세스 종료는 완료가 아니다.

### 상황 → 행동
- **차단 화면**: **provider 차단 화면은 `question` 이 아니다** — `question` 은 워커의 『질의응답』만 만든다.
  차단은 기동이 `agent_blocked` 로 거절하거나 대기가 즉시 `satisfied: false` 로 돌아오는 것으로 나타난다.
- **타임아웃·빈 결과**: `--block` 의 마감은 `count: 0`·`timedOut: true` 로 오는 **정상 답**이다.
  **타임아웃·`count: 0` 은 새 워커를 만드는 근거가 아니다.** 응답 유실이 의심되면
  `request-show`·`worker-show`·`dispatch-show` 로 기존 요청·시도를 확인한다.
- **부분 실패**: 배치의 **모든 메시지를 처리한 뒤** 각 종료 워커의 재사용/보존/회수를 결정하고 나서 `--ack` 로
  이어간다. `--ack` 는 대기 시작 **전에 한 번만** 적용된다. 같은 Run 의 check 를 중복 실행하지 않는다.
  시도가 `unknown` 으로 정산됐다면 이유는 `pane_gone|pty_replaced|epoch_changed` 이고 Task 는 다시 기동
  가능한 상태로 남는다 — `unknown` 은 실패가 아니다.
- **복구**: `--peek` 로 다음 배치를 만들지 않고 들여다볼 수 있다. Run 메시지 상한은 10000건·본문 65536바이트이고
  한계에 닿으면 `message_capacity` 다 — corral 은 자리를 만들려고 메시지를 지우지 않는다.
- **하지 말 우회**: 화면에 "다 했다" 가 보인다는 이유로 완료로 적지 않는다. `DONE.md` 같은 파일은 감사 기록이지
  완료 신호가 아니다. 두 번째 `worker_done` 은 `illegal_transition` 이므로 워커에게 다시 보내게 하지 않는다.

## 『질의응답』

### 명령
```bash
# 코디네이터: 질문은 『완료 감지』의 check 배치로 받는다 (--types 에 question 포함)
corral orchestration reply --id <msg_id> --body "<답>" [--run <run_id>] --json
# 워커 쪽(preamble 이 주는 형태): corral orchestration ask --question … --task-id … --dispatch-id … --timeout-ms 600000
```

### 보장 수준
**증명.** 질문은 대기 시작 **전에 durable 하게 저장된다** — 타임아웃·클라이언트 취소·런타임 재시작에도 답할 수
있다. 마감은 오류가 아니라 `state: pending` + `messageId` + `resumeCommand` 이고, 재개는 새 질문을 만들지 않는다.
답은 물어본 워커에게 주소된 별도 메시지이고 **check 배치에 섞이지 않는다.** 이미 답이 있는 질문에 두 번째
`reply` 는 `already_answered` 로 아무것도 저장하지 않는다.

### 상황 → 행동
- **차단 화면**: 해당 없음 — 질의응답은 pane 화면을 거치지 않는다.
- **타임아웃·빈 결과**: `ask --timeout-ms` 상한은 600000 이다. 마감이면 워커는 **다시 묻지 않고**
  응답에 담긴 `resumeCommand`(`--resume <msg_id>`)를 실행한다. 다시 물으면 중복 질문이 생긴다.
- **부분 실패**: `reply --id` 가 가리키는 게 질문이 아니면 `not_a_question`, 없는 id 면 `message_not_found` —
  둘 다 아무것도 저장하지 않는다.
- **복구**: 질문을 놓친 것 같으면 `corral orchestration inbox --run <run_id> --json` 으로 Run 의 모든 메시지를 본다.
- **하지 말 우회**: **⚠ `orchestration ask` 에는 `--run` 이 없다.** 질문은 **프로필에 현재 바인딩된 Run** 으로
  간다. 바인딩을 바꿔 둔 구간에서는 `ask` 를 치지 않는다 — 『제어 문맥 격리』를 먼저 복원하고 묻는다.
  워커에게 로컬 대화형 프롬프트로 묻게 하지 않는다(코디네이터가 볼 수 없어 세션이 멈춘다).

## 『화면 관측』

### 명령
```bash
corral terminal read --terminal <handle> [--screen] [--cursor <n>] [--limit <바이트>] --json
corral orchestration worker-read --dispatch <ctx_id> [--screen] [--limit <바이트>] --json
```

### 보장 수준
**관측.** 화면 읽기는 본질적으로 관측이다(H2). `--screen` 은 렌더된 화면, 기본값은 누적 출력이다 —
줄을 다시 그리는 프로그램(셸·진행 표시·TUI)은 기본 읽기에서 조각으로 쌓여 온다. `worker-read` 는 그 Dispatch 가
묶인 pane 에 대한 `terminal read` 의 pass-through 이고 **corral 은 provider 훅을 설치하지 않고 transcript 를
읽지 않는다.** 읽기는 아무것도 저장하지 않는다.

### 상황 → 행동
- **차단 화면**: 이것이 차단 화면을 **볼 수 있는 유일한 능력**이다. detect manifest 가 label 하지 않은 모달은
  구조화된 조회로는 보이지 않으므로, codex pane 은 첫 주입 전에 여기서 한 번 본다.
- **타임아웃·빈 결과**: **`--limit` 은 줄 수가 아니라 바이트다**(읽기 1..262144, 화면 1..262144, 목록 1..10000).
  빈 출력은 "아무 일도 없었다" 가 아니라 "이 창에서 볼 게 없었다" 다. 보존은 PTY 당 마지막 1048576 바이트다.
- **부분 실패**: `--cursor` 는 바이트 오프셋 + UTF-8 디코더 carry 다. 잘린 문자는 다음 읽기에서 이어진다.
- **복구**: 사람 개입이 의심되면 화면을 읽어 원자료로 남기고, 사람이 잡은 pane 이면
  `corral orchestration worker-retain --dispatch <ctx> --reason user_takeover` 로 **선언**한다(감지가 아니다).
- **하지 말 우회**: 화면에서 읽은 문장을 『완료 감지』·『본문 주입』의 증명 대용으로 쓰지 않는다.
  화면으로 "보냈다/끝났다" 를 판정하지 않는다.

## 『회수·정리』

### 명령
```bash
corral orchestration worker-retain  --dispatch <ctx_id> [--reason user_requested|user_takeover] --run <run_id> --json
corral orchestration worker-release --dispatch <ctx_id> --run <run_id> --json
corral orchestration worker-stop    --dispatch <ctx_id> --run <run_id> --json   # 열린 시도 취소 (--reason 없음)
corral orchestration worker-abandon --dispatch <ctx_id> --run <run_id> --json   # 손대지 않고 정산
corral terminal close --terminal <handle> --json                                # 빌린 pane (H5)
```

### 보장 수준
**증명.** `released` 는 **이 시도가 pane 을 소유하고, 닫기 직전 관측한 pane 이 같은 세대일 때만** 나온다.
그 밖은 전부 `retained` + 이유(`borrowed`·`user_requested`·`user_takeover`·`pane_gone`·`identity_unproven`·
`observation_failed`)이고 프로세스에 손대지 않는다. 소유 판정과 닫기가 같은 lane 안에서 일어나므로
**판정한 pane 이 닫히는 pane 이다.** `worker-retain` 은 **보존 의사 기록일 뿐** 프로세스에 손대지 않고 새 Task
배정도 아니다. `worker-abandon` 은 pane 을 보지도 닫지도 않는다.

### 상황 → 행동
- **차단 화면**: 해당 없음 — 정리 명령은 화면을 대답하지 않는다.
- **타임아웃·빈 결과**: `worker-release` 를 열린 시도에 부르면 `dispatch_active` 이고 효과가 없다 — 취소는
  `worker-stop` 이다. 이미 회수된 시도에 다시 부르면 기록에서 답하고 아무것도 쓰지 않는다.
- **부분 실패**: **H5 — 사람이 만든 pane 은 `borrowed` 라 corral 이 닫지 않는다.** 원자료를 회수한 뒤
  `terminal show`·`worker-show` 로 handle·worktree·agent 정체, 활성 Dispatch 없음, 사용자 takeover 없음,
  이번 작업 전용임을 확인한 **경우에만** `terminal close` 로 정리한다. 불확실하면 보존하고 차단 사유를 보고한다.
  재사용된 옛 Dispatch 의 회수로 현재 워커가 정리됐다고 가정하지 않는다 — 최종 Dispatch 와 실제 소유권을 본다.
- **복구**: **`release.state: unknown` 은 `corral orchestration worker-show --dispatch <ctx>` 가 복구다.** 두 번째 close 로 우회하지
  않는다 — corral 스스로 그 우회를 권하지 않는다. `worker-stop` 의 닫기가 확인되지 않아도 시도는 정산된다
  (`release.state: unknown` + `worker-show` 복구).
- **하지 말 우회**: 회수가 실제 프로세스를 닫았다고 **가정하지 않는다.** 능력 수명 ≠ 프로세스 수명 —
  정산·중단·포기·회수는 모두 `capabilityRevokedAt` 을 기록하고, pane 이 살아 있어도 그 시도의 보고는 거절된다.
  사용자 확인용 worktree 는 출고 승인까지 유지한다 — **터미널 유지와 worktree 유지의 수명은 다르다.**

## 『세션 기록 오라클』

### 명령
```bash
# provider 가 남기는 기록을 직접 읽는다 (corral 명령이 아니다 — 경로는 capabilities.md H6)
node specs/LIFE-417-harness-validation/raw/orca/b2-oracle-claude.mjs   # codex·grok 판도 같은 폴더
```

### 보장 수준
**관측.** corral 은 provider 훅을 설치하지 않는다. `terminal prompt` 의 `record.matchCount` 는 corral 이
**이 pane 이 소유했음을 증명할 수 있는 기록**만 읽어 만든 값이라 증명이지만, 사람이 직접 파일을 읽는 이 경로는
관측이다 — 어느 기록에도 **사람이 친 입력과 주입된 입력을 가르는 필드가 없다**(H1·H2).

### 상황 → 행동
- **차단 화면**: 해당 없음.
- **타임아웃·빈 결과**: 기록 파일이 없는 것은 배달 실패의 증거가 **아니다** — provider 가 아직 쓰지 않았거나
  기록을 끄고 있을 수 있다(H1).
- **부분 실패**: 같은 cwd 에 세션이 여럿이면 어느 것이 이 pane 인지 corral 도 unknown 으로 답한다 —
  사람이 짚을 때도 같은 모호함을 안고 짚는 것이다. 짚은 근거를 함께 적는다.
- **복구**: pane 소유 기록이 필요하면 『본문 주입』 응답의 `agent.sessionRecord.path` 를 쓴다.
- **하지 말 우회**: 세션 기록을 『완료 감지』 대용으로 쓰지 않는다. 판정표의 완료 칸에 기록 파일을 근거로 적지 않는다.

## 『제어 문맥 격리』

### 명령
```bash
corral orchestration run-current --json                      # 지금 바인딩된 Run
corral orchestration run-create --objective "<목적>" --json   # ⚠ 만든 Run 으로 현재 바인딩을 재설정한다
corral orchestration run-use --id <run_id> --json            # 바인딩 복원
# 그리고 모든 orchestration 명령에 --run <run_id> 를 명시한다
```

### 보장 수준
**증명(단 구멍 하나).** **현재 Run 은 프로필 단위로 바인딩된다 — 부르는 터미널 단위가 아니다.**
`--run <id>` 는 그 한 번의 호출에만 적용되고 바인딩을 바꾸지 않는다. Run 이 없으면 `run_required` 로
효과 이전에 실패한다. **구멍: `orchestration ask` 에는 `--run` 이 없다**(`send`·`check`·`reply`·`task-*`·
`worker-*` 에는 있다) — 질문은 현재 바인딩을 따라간다.

### 상황 → 행동
- **차단 화면**: 해당 없음.
- **타임아웃·빈 결과**: `run-use` 의 모르는 `--id` 는 `run_not_found` 이고 **이전 바인딩을 건드리지 않는다.**
- **부분 실패**: 두 코디네이터(또는 순환 검증 중인 워커)가 한 프로필에서 `run-create` 하면 상대의
  `check`·`send` 가 엉뚱한 Run 으로 간다. **규율: 모든 orchestration 명령에 `--run` 을 명시한다.**
- **복구**: 바인딩을 바꿨다면 **바꾼 쪽이 복원한다** — `run-use --id <원래 Run>` 뒤 `run-current` 로 확인하고
  그 출력을 원자료로 남긴다. 워커 preamble 의 보고 명령에는 `--run` 이 없어 바인딩에 의존하므로, 바인딩을
  바꾼 구간이 자식 워커의 보고·회수를 덮으면 그 구간이 끝날 때까지 되돌리지 않는다.
- **하지 말 우회**: 남의 Run 에 `run-use` 하거나 남의 Run 의 메시지를 `--ack` 하지 않는다. 잔존 Run 을
  "아무도 안 쓰는 것 같으니" 재사용하지 않는다 — 새로 만들고 끝나면 복원한다.
