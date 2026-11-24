# corral 매핑 보충 — 이 프로젝트에서 확인한 도구 동작과 설치본 관문

paddock 매핑(`.agents/harness/corral/`)에 없는 것만 둔다. 매핑 파일은 paddock 고정이라 고치지 않고 여기에 적는다 —
옛 `.agents/harness/corral.md` 에서 원문 그대로 옮겼다(2026-11-24 adopt). 도구 일반 동작으로 굳으면 paddock 에 되돌려 보낸다.

## 『전제 점검』·응답 필드

| 보고가 오래된 시도에서 온 게 아니다 | **증명** | 워커 보고는 `--task-id`·`--dispatch-id` + pane 신원(`HERDR_PANE_ID`·`HERDR_SESSION`)으로 검사된다. 다른 pane = `sender_mismatch`, 사라진 pane·교체된 시도 = `stale_dispatch`, 두 번째 완료 보고 = `illegal_transition`, 정산·중단·회수된 시도 = `capability_revoked`. **거절은 아무것도 저장하지 않는다**. `←`·`/bg` 로 옮긴 claude 워커는 pane 신원 대신 세션 사슬(`CLAUDE_CODE_SESSION_ID` 가 그 Dispatch 의 민팅 세션이거나 `continued-in` 대상)로 받는다(답의 `proof: session_chain`, LIFE-796). 대화가 없던 pane 을 `←` 로 보낸 경우는 민팅 기록이 없어 `continued-in` 이 없다 — 그때만 Claude 세션 레지스트리의 `parkedJobId` 한 hop 으로 bg 세션을 사슬에 넣는다(LIFE-797, 아래 『감독 워커 기동』 agent view 줄). **사슬 증명은 호출자가 싣는 세션 id 다 — 혼동 방지이지 인증이 아니다**(`sessionVerified: false`). 한계: claude 시도만 · bg 안 `/clear` 뒤는 사슬이 끊겨 `sender_mismatch` · pane 생존 관측은 그대로(사라진 pane 은 `stale_dispatch`) |
| 세션이 백그라운드로 옮겨 간 뒤의 기록 (claude, LIFE-771) | `…agent.sessionRecord.path`·`terminal prompt` → `result.record.path` 는 **이어 가기 규칙이 마지막으로 닿은 파일**(`continued-in` 을 따라간 끝 — 보통 지금 자라는 파일이지만 hop 상한 8(대화 없이 `←` 로 park 된 pane 은 레지스트리 hop 1 을 더해 9 — LIFE-797)·되살아난 원본·증명 못 한 다음 hop 에서는 아닐 수 있다), `…agent.sessionRecord.continuedIn` 은 거쳐 간 세션 id 들(안 옮겼으면 `[]`. 대화 없이 `←` 로 park 된 pane 은 레지스트리 hop 의 bg 세션 id 가 첫 칸 — LIFE-797), `…agent.sessionId` 는 **민팅한 id 그대로**(pane 정체) — 옮겨 간 뒤 기록을 볼 때 sessionId 로 경로를 짓지 말고 이 경로를 읽는다 |

## 『세션 기동』

- **격리 시험 pane 의 셸**: 시험용 셸 pane 은 `/bin/sh` 로 띄운다 — 사용자 zsh 의 oh-my-zsh 업데이트 질문이 명령 첫 글자를 먹는다. 코디·워커 기동은 해당 없음 (LIFE-769·771·772·787).

## 『본문 주입』

  `prompt_already_delivered` 는 라운드를 넘겨 같은 답(「진행」·「허용함」)을 다시 넣을 때도 난다 — 라운드·시각을 본문에 넣어 다르게 쓴다(LIFE-746).
- **agent view(LIFE-787)**: Claude pane 이 agent view(빈 프롬프트에서 `←`)면 `agent_view`(효과 없음, `not_started`)로 거절된다 —
  거기 넣으면 새 bg 세션이 생긴다. 사람이 그 pane 에서 `esc` 로 대화로 돌아온 뒤 **같은 `--request-id`** 로 다시 넣는다.
  판정 화면을 읽을 때 입력이 500ms 조용하지 않았거나(기다려 최대 6번 다시 읽음) 판정 뒤 사람 입력이 끼면 `input_changed`(효과 없음) — pane 을 보고 같은 방법으로 다시 넣는다.
  남는 한계: 500ms 는 폰 경로와 같은 상수라 한계도 같다 — 키의 에코가 그보다 늦게 화면에 오면 일반 화면으로 읽혀 걸러지지 않는다. 코디는 사용자·코디 pane 에서 `←` 를 누르지 않는다.

## 『감독 워커 기동』

- **agent view(LIFE-787)**: 워커 pane 이 Claude agent view 면 `worker-start` 가 리드 줄을 치기 **전에** 거절한다 — `incomplete`·`stage: dispatch_input`·
  `stages.input.error: agent_view`, pane 에는 아무것도 쓰지 않는다. 사람이 그 pane 에서 `esc` 로 대화로 돌아온 뒤 **같은 Task 에**
  `corral orchestration worker-start --task <t> --terminal <handle>` 을 다시 부르면 같은 Dispatch 로 재개된다(`launch: resumed`). 재개 중 본문 단계에서 걸려도 같다.
  아직 대화 기록이 없는 pane(민팅 세션 파일 없음)은 `←` 가 세션을 데몬의 bg 세션으로 park 하고, `esc` 뒤 본문은 그 bg 세션 파일에 들어간다(관측 Claude Code 2.1.296).
  corral 은 민팅 파일이 **없을 때만** Claude 세션 레지스트리(`~/.claude/sessions/<pid>.json`, 문서화되지 않은 내부 형식)를 한 hop 따라간다 — 민팅 id 의 대화형 항목 하나의
  `parkedJobId` → 그 job 의 `kind: "bg"` 항목 하나의 `sessionId`(job id 로 시작하는 세션 id 꼴) → 그 파일(LIFE-797). 파일을 찾는 곳은 둘이 다르다:
  - **배달 hop**(`terminal prompt`·`terminal show`·`orchestration worker-start` 입력 판정): pane cwd 로 정한 민팅 파일의 폴더 하나 — 그 폴더에 민팅 파일이 없고 bg 파일이 있어야 한다.
  - **보고자 hop**(`orchestration send`·`orchestration ask` 의 `proof: session_chain`): pane 없이 Dispatch 의 민팅 id 만 있어서 모든 project 폴더를 본다 — 민팅 id 파일이 어느 폴더에도 없고(못 읽는 폴더가 하나라도 있으면 hop 없음) bg 세션 파일이 정확히 한 폴더에 있어야 한다.
  - 비대칭은 양방향이다: bg 파일이 pane 폴더가 아닌 다른 project 폴더 하나에만 있으면 보고자 hop 만 서고, 민팅 id 파일이 다른 project 폴더에만 있고 bg 파일이 pane 폴더에 있으면 배달 hop 만 선다(보고자 쪽은 민팅 id 를 모든 폴더에서 0개로 본다).
  hop 뒤에는 `continued-in` 규칙이 그 bg 파일에서 다시 최대 8 hop 따라가므로 사슬은 민팅 뒤로 최대 1 + 8 = 9 세션이다.
  격리 실측 스모크 1회(2026-11-18, 2.1.296 Haiku 5.5 low — `corral-specs/LIFE-797-empty-pane-outcome/raw/claude/smoke1/`)에서 재개가 `ready`·`confirmed`·matchCount 1(`agent.sessionRecord.continuedIn` 첫 칸 = bg 세션 id)이고
  그 워커의 `worker_done` 이 `proof: session_chain` 으로 수락됐다 — 판정 회차(3회)는 최종 관문 몫이다. **남는 한계**: hop 의 어느 고리든 없거나·둘 이상이거나·모양이 다르면 hop 없음 — 이 일감 전과 같은 답
  (`incomplete`·`dispatch_input_unconfirmed`·`unavailableReason: not_found`, 예산을 다 쓰고 돌아옴 · 워커 보고 `sender_mismatch`)이다. 레지스트리 항목 하나라도 못 읽으면(쓰는 중 포함) 그 순간 hop 이 없고, 깨진 `.json` 항목이 영구히 남아 있으면 그동안 모든 빈 pane park 의 hop 이 없다(건너뛰면 무관한 항목이 아니라 같은 pane 항목을 숨길 수 있어 fail-closed 를 택했다).
  이 hop 은 runtime 판정(`terminal prompt`·`terminal show`·`orchestration worker-start`·보고자)만 따른다 — 채팅 뷰·폰 입력은 따르지 않는다(빈 pane park 뒤에도 민팅 경로를 본다). 민팅 파일은 있으나 대화가 빈 채로 park 된 경우(민팅 파일에 메타 줄만, `continued-in` 없음)는 확인하지 않았다 — 그때는 민팅 파일이 있으므로 hop 을 쓰지 않는다.
  형식은 Claude Code 2.1.296 에서 관측한 것뿐이다 — 더 새 버전(2.1.325 cwd 변경·2.1.326 빈 대화 `←` 뒤 Ctrl+C·Ctrl+D 두 번·`/exit` 로 세션 종료)의 park 동작은 확인하지 않았다.
  빈 idle bg 세션은 데몬이 약 5분 뒤 정리한다(v2.1.141 changelog 출처, 2.1.296 에서 관측하지 않음) — 그 뒤에는 hop 이 사라질 수 있다. agent view 에서 다른 행에 붙은 pane·bg 안 `/clear` 뒤는 다루지 않는다.
  그 답이 오면 `dispatch-show` 와 pane 을 먼저 보고 다시 넣지 않는다.
- **런타임 인스턴스가 바뀌었을 때**: 공유 설치본이 재기동돼 보존한 워커 pane 재사용이 `agent_not_found`, `worker-stop` 이 `identity_unproven` 이면
  `worker-abandon` → pane 정체(paneId·화면) 확인 후 `terminal close` → 새 세션에 이전 worklog·DONE·runs 를 읽게 하는 인계 문단으로 넘긴다(LIFE-754).

## 『완료 감지』

- **대기 루프**: 위 명령 그대로(`--block`·`--types`·`--timeout-ms` 상한 600000 안) 돌리고, 빈 결과가 너무 빨리 오거나 `ok:false` 면 루프를 멈추고 원인을 본다. 셸 `&` 가 아니라 도구의 백그라운드 실행으로 띄운다 (LIFE-769·787·795).

## 『회수·정리』

- **시험 bg 세션 정리**: `claude stop`·`claude rm` 은 id 앞 8자로 준다(전체 uuid 는 「No job matching」). rc≠0 은 실패로 적고, 정리 뒤 `claude agents --json --all` 로 다시 본다. bg 안 `/clear` 뒤에는 처음 job id 만 받는다 (LIFE-771·772·795).
- 격리 herdr 세션(`life<NNN>*`)은 `scripts/task-finish.sh` 가 더는 멈추지 않는다(paddock 판은 corral pane 후보만 알린다) — 띄운 세션은 띄운 쪽이 `herdr session list` 로 찾아 `herdr session stop <이름>` 으로 멈추고 stopped 를 확인한다. pane 이 많으면 stop 이 15초 안에 안 끝날 수 있어(실측 233 pane 에 4회) 다시 친다. 사용자 default 세션은 건드리지 않는다.

## 『세션 기록 오라클』

**이 방법은 이 일감에서 1회 실행했다** — `raw/claude/fix1-m5-session-record-read.txt`
(C6 3회차 자식 워커의 기록 62줄 중 user 4·assistant 4. 주입 본문 2건과 응답 2건이 그대로 보였고,
**두 user 줄의 모양이 같아 사람 입력과 주입 입력을 가를 필드가 없다는 것이 재확인됐다**).
Codex·Grok 판도 같은 형태의 JSONL 이지만 필드 이름이 다르므로 **먼저 한 줄을 열어 키를 확인한 뒤** 같은 요령으로 읽는다.

**⚠ `corral-specs/*/raw/` 의 옛 스크립트를 명령으로 적지 않는다.** 그 폴더의 파일은 누출 점검 도구가 절대경로류
문자열을 `<p:…>` 로 치환해 커밋한 것이라 **문법부터 깨져 있다**(`b2-oracle-*.mjs` 3개 모두 `node --check` 실패).
근거로 **인용**만 하고, 실행 방법은 위처럼 이 매핑에 직접 적는다.

## 설치본 네이티브 관문 (사용자 설치본을 CDP·계측 소켓으로 조작·관측할 때)

- **손 떼기 요청 = 키 + 포인터 + 시간.** 시작 전에 「키보드를 치지 않고, 포인터를 창 밖에 두고, N 분」을 받는다 — 창 위 포인터의 스크롤·hover 도 합성 입력과 섞여 회차를 무효로 만든다.
  실입력 칸(사용자가 창에 손을 대야 하는 회차)만 예외로 적는다. 닫힘·선택 변경을 감지하면 다투지 말고 멈춘다.
- **「X 가 뜰 때까지」 대기는 대상 정체(선택된 worktree·보기)를 같이 단언한다** — 「못 봤다」와 「다른 대상을 봤다」를 가른다.
- **교체·재기동은 최소 환경으로 띄우고 종료→교체→기동·해시를 한 절차로 묶는다.** 셸의 `open -a` 는 호출 셸 환경(PATH 포함)을 앱에 넘기므로 PATH 가 판정 조건이면
  `env -i HOME USER LOGNAME TMPDIR PATH=/usr/bin:/bin:/usr/sbin:/sbin open -a …` 로 띄우고 `ps eww` 로 앱 PATH 를 찍는다(로케일·셸 환경이 판정 조건인 관문은 Finder 기동 env 를 따로 찍는다).
  공유 설치본은 끈 사이 다른 주체가 띄울 수 있어 종료→교체→기동을 한 명령으로 묶고, 교체 전 GUI 잠금을 잡아 형제 코디에게 알린다. 설치본 해시는 방식까지 적고, 새 기동은 새 pid 로 단언한다.
  앱만 재기동하는 블록은 코디가 세션을 떼어(setsid·nohup, 출력은 파일) 직접 돌릴 수 있다 — herdr 서버가 앱과 별개라 코디 pane 이 산다. 손 넘김은 GUI 조작·외부 쓰기·herdr 서버 재기동만.
- **종료는 멈출 수 있다** — `--remote-debugging-port` 로 띄운 설치본은 osascript quit 에 끝나지 않고 CDP 도 빈 응답이 될 수 있다(원인 미확정). 교체 스크립트는 옛 PID 가
  정해진 시간 안에 내려가지 않으면 덮어쓰지 않고 멈춘다. 끝내는 것은 샘플(`sample <pid>`)을 남긴 뒤 그 PID 만 TERM→KILL. (LIFE-624·520·813·811·812)
- **CDP 로 시간을 재거나 누르는 회차는 창이 보일 때만 센다** — 창이 가려지면(`document.visibilityState === 'hidden'`) 렌더러 타이머와 CDP 마우스 입력이 초 단위로 늦어져 지연·연타 회차가 무효다. 회차 전에 보임을 단언하고 연타·끼어들기는 페이지 안 DOM 이벤트로 한다.
  클릭 좌표는 화면에 보이는 사각형 안에서 고르고(스크롤 컨테이너 안 요소는 사각형이 화면 밖까지 뻗는다) `elementFromPoint` 가 대상 안인지 단언한 뒤 누른다 — 결과는 상태 변화로 확인한다. (LIFE-803·808)
- **입력 금지의 사유는 키 입력이 그 순간 포커스 pane 으로 새는 것이다** — 마우스 이벤트(⌘ 는 `modifiers`)만 쓰고 누르는 자리를 코디가 만든 셸 pane 출력으로 한정하면 사용자 pane·에이전트 TUI 에 입력이 들어가지 않는다. 화면 전환은 CLI(`terminal switch`)로.
  계측 소켓 `click` 은 창 배율이 1 이 아니면 다른 요소를 누른다 — CDP `Input.dispatchMouseEvent`(CSS px)와 수신 대상 단언을 쓴다. 안 통하는 자리: 마우스 리포팅이 켜진 pane, 키 입력·OS 입력 경로가 판정 대상인 회차. (LIFE-835·802)
- **OS 대화상자 회차는 그 앱 창 어디에도 키 입력 금지 — 마우스로만.** 모달은 뜨는 순간 키 포커스를 가져가 사용자가 같은 앱의 다른 pane 에 친 Enter·Esc 가 답이 된다. 열기 전 입력 유휴를 확인하고, 회차마다 앱 로그의 선택값·기록기·사용자 보고를 대조한 뒤 다음 회차를 열고, 확인 질문은 대화상자가 닫힌 뒤에 묻는다.
  사람이 답을 치는 pane 이 대상 앱 안에 있으면 답할 때마다 그 pane 의 worktree 가 활성이 된다 — 단계마다 「대상 카드 먼저 → 화면의 대상 이름 확인」을 넣고 동작 로그의 대상으로 회차를 대조한다. (LIFE-829·831)
- **앱 본체 PID 는 「인자 없음 또는 `--` 로 시작하는 플래그」로 가른다** — CLI shim 이 같은 실행 파일을 node 모드로 쓰므로 「끝 고정·인자 허용」 패턴은 다른 일감의 CLI 대기까지 잡는다. macOS 에는 `setsid` 명령이 없다 — 세션 떼기는 perl `POSIX::setsid` 로. (LIFE-834·831)
- **ad-hoc 서명 헬퍼를 다시 빌드하면 TCC 권한이 초기화된다** — 설치본을 교체하는 라운드마다 권한 창이 다시 뜨고, 거부 회차 뒤엔 사용자가 직접 다시 켜야 한다. 권한 회차(허용·거부)는 마지막 설치본에서 한 번에 몰고 거부 회차는 맨 끝에 둔다. 정식 서명을 붙이면 이 줄을 지운다. (LIFE-834)
- **dev 빌드(서명이 다름)는 키체인 허용 대화상자가 뜬다** — 손 떼기를 받을 때 「뜨면 허용 한 번」을 같이 알리고, 워커는 대화상자를 누르지 않고 멈춘다.
- 안 통하는 자리: 창 없는 serve 관문(입력 혼입 없음), 폰 실기기 회차(맥 손 떼기와 별개), orca·bare 매핑(설치본 CDP 관문 없음). (LIFE-683·745·755)
