# harness learnings

Last reviewed: 2026-10-30

## 「응답에 X 가 있다」는 어느 명령의 응답인지까지 원자료로

- **Scope:** `.agents/harness/**`, 스킬이 매핑 응답 필드를 인용하는 자리
- **Learning:** 같은 매핑 안에서도 도구마다, 같은 도구에서도 명령마다 응답 필드가 다르다. 절차 문구에 응답 필드를 쓰기 전에 그 명령의 실제 응답 원자료를 연다. 표·요약만 보고 일반화하지 않는다.
- **Evidence:** LIFE-704 에서 세션 기록 경로를 r1 은 도구 단위로, fix2 는 매핑 단위로 일반화했다. 그러다 r4 에서 「기동 응답엔 없고 주입 응답에 늦게 온다」(Codex)로 뒤집혔다 — 같은 지적이 네 라운드 이어졌다.
- **Disposition:** `.agents/harness/capabilities.md` 작성 지침 — 다시 나면.

## corral 감독 기동의 codex 는 업데이트 확인을 끌 수 없다

- **Scope:** `.agents/harness/corral.md` 『감독 워커 기동』·『세션 기동』 — codex
- **Learning:** corral 이 만드는 codex argv 에는 `-c check_for_update_on_startup=false` 가 없고 넘길 플래그도 없다. 업데이트 안내가 뜨는 버전 간격에서는 모델과 무관하게 기동이 120초 `outcome_unknown`·주입 미확정으로 멈출 수 있다 — Codex 워커·리뷰어를 띄우기 전에 이 가능성을 본다.
- **Evidence:** LIFE-713 에서 codex-cli 0.162.1 → 0.164.0 안내 화면 아래 감독 기동 3회(카탈로그에 있는 모델 포함)가 모두 같은 상태로 멈췄다. 원인(안내 화면·기동 지연·배달 계층)은 가르지 못했다.
- **Disposition:** corral 매핑 『감독 워커 기동』 「상황 → 행동」 — 원인을 가르는 별도 일감 후보(corral 이 codex 기동 `-c` 를 받게 하거나 매핑에 우회 경로).

## 공유 프로필에서 Run 이 둘이면 워커의 `ask` 를 쓰지 않는다

- **Scope:** `.agents/harness/corral.md` 『질의응답』·『제어 문맥 격리』, 묶음 형제 동시 진행
- **Learning:** 같은 프로필에서 두 코디가 Run 을 따로 쓰면 바인딩은 한쪽만 가리킨다. 워커의 `send` 에는 `--run` 을 붙이고, `--run` 을 받지 않는 `ask` 대신 escalation 으로 묻게 한 뒤 코디가 답을 주입한다. 바인딩은 만든 직후 원래 Run 으로 되돌린다.
- **Evidence:** LIFE-716·717 이 한 프로필에서 동시에 돌았고 이 방식으로 보고가 모두 자기 Run 으로 왔다. escalation 질문 경로는 실측되지 않았다.
- **Disposition:** corral.md 『질의응답』 「하지 말 우회」 — escalation 경로를 한 번 실측한 뒤.

## Claude 코디의 독립 재실행은 셸 해석기 스크립트가 막힌다

- **Scope:** task-coordinate §5·§6, Claude 코디의 독립 재실행
- **Learning:** 문서에서 추출한 블록을 셸 해석기에 넘기고 지우기까지 하는 스크립트는 Claude Code 안전 검사가 막는다. 우회하지 않고 그 칸을 공백으로 두며, 문서 일감이면 처음부터 리뷰어 일감에 블록 실행을 넣어 독립 근거로 삼는다.
- **Evidence:** LIFE-719 — 코디 재실행이 두 번 막혔고, 리뷰어 세 라운드의 sandbox 실행 원자료가 독립 근거가 됐다.
- **Disposition:** task-coordinate §5 리뷰 일감 명세 — 다시 나면.

## 리뷰어 일감 명세에 완료 보고를 명시한다

- **Scope:** task-coordinate §5 리뷰 명세, corral 『감독 워커 기동』으로 띄운 리뷰어
- **Learning:** 감독 워커로 띄운 리뷰어는 보고서 파일만 쓰고 완료 보고 없이 끝날 수 있다 — 그러면 『완료 감지』가 공백이 된다. 리뷰 명세 끝에 「끝나면 반드시 완료 보고」를 적는다.
- **Evidence:** LIFE-724 r1 리뷰어가 완료 보고 없이 끝나 판정 근거가 관측(보고서 파일)으로 내려갔다. r2~r4 는 명세에 적어 모두 보고가 왔다.
- **Disposition:** task-coordinate §5 리뷰 기동 줄 또는 `.agents/agents/reviewer.md` — 다시 나면.

## 공유 프로필의 대기는 소켓 주인 재기동을 견디게 돈다

- **Scope:** corral 매핑 『완료 감지』 — `orchestration check --block`
- **Learning:** 같은 프로필의 다른 일감이 설치본을 재기동하면 소켓 주인이 바뀌어 긴 `check --block` 이 `outcome_unknown` 으로 끝난다. ack 없는 대기는 다시 불러도 안전하므로 짧은 간격 재연결 루프로 감싸고, 끊김을 메시지 손실·워커 이상으로 읽지 않는다. ack 만 하는 대기에도 `--types` 를 붙여 heartbeat 배치가 새 Delivery 로 따라오지 않게 한다.
- **Evidence:** LIFE-626 — 병렬 일감의 설치본 재기동마다 코디 대기가 끊겼고(워커 무영향), `--types` 없는 ack 가 heartbeat 18건 배치를 열었다.
- **Disposition:** `.agents/harness/corral.md` 『완료 감지』 복구 절.

## 설치본 관문의 「쓰기 0」 은 main 쪽 trace 와 양성 대조로

- **Scope:** 설치본을 CDP 로 관측하는 네이티브 관문(실제 외부 연결 위, 읽기 전용 조건)
- **Learning:** contextBridge 로 노출된 렌더러 API 는 얼어 있어 렌더러 쪽 쓰기 가드를 걸 수 없다. 처음부터 main 쪽 IPC trace 로 사후 검출하고 양성 대조(읽기 응답 ≥ 1, 보낸 요청 id 전부가 trace 에 있음)를 붙인다. trace 를 거치지 않는 IPC 는 판정표에 공백으로 둔다.
- **Evidence:** LIFE-711 — 첫 회차가 가드 불가로 클릭 전에 멈췄고, trace 사후 검출로 바꾼 뒤 통과했다.
- **Disposition:** `.agents/harness/corral.md` 설치본 관문 절 또는 validation.md 네이티브 관문 줄.

## 설치본 GUI 회차는 손 떼기를 먼저 받고, 대기에 대상 정체를 단언한다

- **Scope:** 사용자 설치본을 CDP·계측 제어 소켓으로 조작·관측하는 네이티브 관문(사용자가 같은 앱을 쓰는 중)
- **Learning:** 사용자가 그 앱 창(터미널 pane 포함)을 쓰면 페이지가 닫히거나 선택·보기가 바뀌어 회차가 무효가 된다. 시작 전에 손 떼는 시간을 받고, 「X 가 뜰 때까지」 대기에 대상 정체(선택된 worktree·보기)를 같이 담아 「못 봤다」와 「다른 대상을 봤다」를 가르며, 닫힘을 감지하면 다투지 말고 멈춘다. 마우스 이벤트로 동작하는 요소는 DOM `click()` 대신 입력 이벤트 클릭을, 겹치는 줄이 없는 가장 작은 요소에 쓴다.
- **Evidence:** LIFE-745 관측 두 회차가 작업 페이지 닫힘으로 무효였고 손 떼기 뒤 정상이었다. LIFE-683 반영 시간 측정 2회가 선택 변경으로 무효, 카드 가운데 클릭이 제목 줄에 맞아 엉뚱한 페이지를 열었다.
- **Disposition:** `.agents/harness/corral.md` 설치본 관문 절 또는 validation.md 네이티브 관문 줄.
