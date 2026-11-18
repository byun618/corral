# harness learnings

Last reviewed: 2026-11-18

## 감독 기동의 120초 `outcome_unknown` 은 도구마다 뜻이 다르다

- **Scope:** `.agents/harness/corral.md` 『감독 워커 기동』·『세션 기동』 — codex·grok
- **Learning:** codex: corral 이 만드는 argv 에 `-c check_for_update_on_startup=false` 가 없어, 업데이트 안내가 뜨는 버전 간격에서는 모델과 무관하게 기동이 주입 미확정으로 멈춘다 — 띄우기 전에 이 가능성을 본다. grok: CLI 로컬 마감으로 `outcome_unknown` 이 나와도 본문은 들어갔을 수 있다 — 다시 넣지 말고 `dispatch-show --task` 의 heartbeat 와 화면으로 확인한 뒤 완료 보고를 기다린다.
- **Evidence:** LIFE-713 — codex 안내 화면 아래 감독 기동 3회가 멈췄다. LIFE-797·813 — grok 5회가 같은 모양이었고 5회 다 본문이 도착했다(원인은 가르지 못했다).
- **Disposition:** corral 매핑 『감독 워커 기동』 「상황 → 행동」 — 별도 일감 후보(codex 기동 `-c`, grok 배달 확인).

## 공유 프로필에서 Run 이 둘이면 워커의 `ask` 를 쓰지 않는다

- **Scope:** `.agents/harness/corral.md` 『질의응답』·『제어 문맥 격리』, 묶음 형제 동시 진행
- **Learning:** 같은 프로필에서 두 코디가 Run 을 따로 쓰면 바인딩은 한쪽만 가리킨다. 워커의 `send` 에는 `--run` 을 붙이고, `--run` 을 받지 않는 `ask` 대신 escalation 으로 묻게 한 뒤 코디가 답을 주입한다. 바인딩은 만든 직후 원래 Run 으로 되돌린다.
- **Evidence:** LIFE-716·717 동시 진행에서 보고가 모두 자기 Run 으로 왔다. escalation 경로는 실측 전.
- **Disposition:** corral.md 『질의응답』 「하지 말 우회」 — escalation 경로를 한 번 실측한 뒤.

## Claude 코디의 독립 재실행은 셸 해석기 스크립트가 막힌다

- **Scope:** task-coordinate §5·§6, Claude 코디의 독립 재실행
- **Learning:** 문서에서 뽑은 블록을 셸 해석기에 넘기는 스크립트는 Claude Code 안전 검사가 막는다. 우회하지 않고 그 칸을 공백으로 두며, 문서 일감이면 처음부터 리뷰어 일감에 블록 실행을 넣는다.
- **Evidence:** LIFE-719 — 코디 재실행이 두 번 막혔고 리뷰어의 sandbox 실행이 독립 근거가 됐다.
- **Disposition:** task-coordinate §5 리뷰 일감 명세 — 다시 나면.

## 리뷰어 일감 명세에 완료 보고를 명시한다

- **Scope:** task-coordinate §5 리뷰 명세, corral 『감독 워커 기동』으로 띄운 리뷰어
- **Learning:** 감독 워커로 띄운 리뷰어는 보고서 파일만 쓰고 끝날 수 있다 — 『완료 감지』가 공백이 된다. 리뷰 명세 끝에 「끝나면 반드시 완료 보고」를 적는다.
- **Evidence:** LIFE-724 — 첫 리뷰어가 보고 없이 끝났고, 명세에 적은 뒤 세 라운드는 모두 보고가 왔다.
- **Disposition:** task-coordinate §5 리뷰 기동 줄 또는 `.agents/agents/reviewer.md` — 다시 나면.

## 공유 프로필의 대기는 소켓 주인 재기동을 견디게 돈다

- **Scope:** corral 매핑 『완료 감지』 — `orchestration check --block`
- **Learning:** 같은 프로필의 다른 일감이 설치본을 재기동하면 소켓 주인이 바뀌어 긴 `check --block` 이 `outcome_unknown` 으로 끝난다. ack 없는 대기는 다시 불러도 안전하니 짧은 재연결 루프로 감싸고, 끊김을 손실·워커 이상으로 읽지 않는다. ack 만 하는 대기에도 `--types` 를 붙여 heartbeat 배치가 새 Delivery 로 따라오지 않게 한다. `rpc.sock` 만 사라져 `runtime_unavailable` 이 오래 가면 워커는 보고를 재시도 스크립트로 남기고 코디가 복구 뒤 한 번 돌린다 — 재기동으로 고치지 않는다.
- **Evidence:** LIFE-626 — 병렬 재기동마다 대기가 끊겼고 `--types` 없는 ack 가 heartbeat 배치를 열었다. LIFE-754 — 재시도 110회 소켓 없음, 복구 뒤 전송.
- **Disposition:** `.agents/harness/corral.md` 『완료 감지』 복구 절.

## 설치본 관문의 「쓰기 0」 은 main 쪽 trace 와 양성 대조로

- **Scope:** 설치본을 CDP 로 관측하는 네이티브 관문(실제 외부 연결 위, 읽기 전용 조건)
- **Learning:** contextBridge 로 노출된 렌더러 API 는 얼어 있어 렌더러 쪽 쓰기 가드를 걸 수 없다. main 쪽 IPC trace 로 사후 검출하고 양성 대조(읽기 응답 ≥ 1, 보낸 요청 id 전부가 trace 에 있음)를 붙인다. trace 를 거치지 않는 IPC 는 판정표에 공백으로 둔다.
- **Evidence:** LIFE-711 — 가드 불가로 멈췄다가 trace 검출로 통과.
- **Disposition:** `.agents/harness/corral.md` 설치본 관문 절 또는 validation.md 네이티브 관문 줄.

## 설치본 관문은 최소 환경으로 띄우고 교체·종료·해시를 한 절차로 묶는다

- **Scope:** 설치본을 dev 패키지로 바꾸거나 재기동하는 네이티브 관문(macOS, 병렬 일감이 같은 설치본을 씀)
- **Learning:** 셸의 `open -a` 는 호출 셸 환경(PATH 포함)을 앱에 넘기므로 PATH 가 판정 조건이면 `env -i HOME USER LOGNAME TMPDIR PATH=/usr/bin:/bin:/usr/sbin:/sbin open -a …` 로 띄우고 `ps eww` 로 앱 PATH 를 찍는다. 공유 설치본은 끈 사이 다른 주체가 띄울 수 있어 종료→교체→기동을 한 명령으로 묶고, 교체 전 GUI 잠금을 잡아 형제 코디에게 알린다. 설치본 해시는 방식까지 적고, 새 기동은 새 pid 로 단언한다. 앱만 재기동하는 블록은 코디가 세션을 떼어(setsid·nohup, 출력은 파일) 직접 돌릴 수 있다 — herdr 서버가 앱과 별개라 코디 pane 이 산다. 손 넘김은 GUI 조작·외부 쓰기·herdr 서버 재기동만.
- **Evidence:** LIFE-624 — `open` 기동이 셸 PATH 로 떠 무효. LIFE-520 — 일감마다 해시 방식이 달랐고 종료 중 인스턴스에 붙어 무효. LIFE-813 — 재기동 7회 동안 코디 pane 생존.
- **Disposition:** `.agents/harness/corral.md` 설치본 네이티브 관문 절 — 다시 나면.

## TUI 선택 프롬프트는 선택 상태를 다시 읽은 뒤 Enter 를 보낸다

- **Scope:** 하네스·워커가 에이전트 TUI 를 키 입력으로 넘기는 자리(신뢰·업데이트 프롬프트)
- **Learning:** 입력 준비 전에 보낸 이동 키는 사라지고 Enter 가 기본값을 고른다. 선택 표시가 원하는 항목에 있는지 화면에서 읽은 다음에만 Enter 를 보낸다.
- **Evidence:** LIFE-710 — 신뢰 프롬프트의 ↓ 가 유실돼 기본 「No, exit」 로 pane 이 꺼졌다.
- **Disposition:** 같은 실수가 다시 나오면 harness 매핑의 『준비 대기』 주의사항.

## 손 넘김 명령 블록은 실제 값으로 비파괴 부분을 먼저 친다

- **Scope:** 사용자 손 넘김 절차, task-coordinate §5 최종 관문
- **Learning:** 사용자가 붙여 넣을 블록은 문법 검사·스텁으로 끝내지 않고, 실제 값을 채워 비파괴 부분을 코디가 먼저 친다. zsh 는 큰따옴표 안 `"$v:s…"` 를 수식자로 읽으니 변수 뒤에 콜론이 오면 `${v}` 로 쓴다.
- **Evidence:** LIFE-575 — 리뷰 네 라운드가 못 잡은 수식자 오류가 사용자 첫 실행에서 깨졌다.
- **Disposition:** task-coordinate §5 — 다시 나면.

## 격리 herdr 장치는 모든 herdr CLI 호출의 env 를 지운다

- **Scope:** 격리 herdr 를 쓰는 워커·리뷰어·코디 실측, 킥오프 「격리 장치」 레시피
- **Learning:** pane 안 셸의 `HERDR_*`(소켓·pane id)가 `XDG_CONFIG_HOME` 보다 앞서서, 격리 서버를 띄워도 herdr CLI 를 그냥 치면 사용자 herdr 를 읽거나 누른다. env 를 지우는 래퍼로 모든 herdr 호출을 감싸고, 키를 보내기 전 그 서버의 pane 목록을 확인한다.
- **Evidence:** LIFE-797 — `pane list` 가 사용자 herdr 를 읽었다(읽기라 무해).
- **Disposition:** `.agents/harness/corral.md` 격리 실측 절 또는 킥오프 레시피 — 다시 나면.
