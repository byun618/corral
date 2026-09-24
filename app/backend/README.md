# Terminal backend v1

LIFE-393 CLI는 명시적으로 연결한 corral terminal backend를 쓴다. 설치 herdr 0.9.0에는 이 가드/출력 계약이 없으므로 `unsupported_backend`로 거절하며, 설치본을 교체하거나 가드 없는 제어로 fallback하지 않는다. 기존 GUI 경로는 그대로 설치 backend에도 연결할 수 있다.

`source.json`의 upstream v0.9.0 commit/archive와 **세 patch**가 빌드 입력이다. stream patch는 과거 후보 `ca85c70`에서 필요한 PTY 출력 링 부분만 추출했다. guard patch는 LIFE-393 구현이고 LIFE-394가 agent 갈래를 얹었다. detect patch는 LIFE-394가 추가했다. 적용 순서는 stream → guard → detect로 고정이며 `patch_digest`가 세 파일을 모두 덮으므로 patch가 바뀌면 새 build root가 필요하다. 관리 범위는 macOS arm64, Rust 1.96.1, Zig 0.15.2, 로컬 SDK 15.4다. 다른 OS/아키텍처 지원을 주장하지 않는다.

```sh
# Node >=22.12.0. 설치 도구나 PATH의 herdr를 덮어쓰지 않는다.
export CORRAL_BACKEND_BUILD_ROOT="$(mktemp -d /tmp/l393-codex-build-XXXXXX)"
sh app/scripts/build-terminal-backend.sh
export CORRAL_TEST_BACKEND="$CORRAL_BACKEND_BUILD_ROOT/herdr-0.9.0/target/debug/herdr"
node app/scripts/l393/verify-backend-source.mjs
npm --prefix app ci
npm --prefix app run build
node app/scripts/l393/live.mjs
node app/scripts/l393/gui.mjs
node app/scripts/l393/failures.mjs
node app/scripts/l393/gui-race.mjs
node app/scripts/l393/contract.mjs
node app/scripts/l393/receipt-loss.mjs
node app/scripts/l393/stdin-bom.mjs
node app/scripts/l393/wait-boundary.mjs
node app/scripts/l393/installed.mjs
node app/scripts/l394/fixtures.mjs        # F12: stock / LIFE-393 guard / 새 guard 세 backend
node app/scripts/l394/l393-regression.mjs # F13: LIFE-393 terminal 계약 회귀 (명령 9 + terminal prompt)
node app/scripts/l394/global-config-diff.mjs before|after|diff|selftest
node app/scripts/l394/leak-check.mjs <raw 디렉터리>   # LIFE-426 누출 검사 (2중 검사)
node app/scripts/l394/leak-check.mjs selftest          # 그 검사기 자신의 대조 (V6·V7)
```

빌드 root 안에 도구 체인·의존성·소스·binary와 `<binary>.json` 영수증이 생긴다. archive SHA-256을 검사하고, patch 집합이 달라진 캐시의 재사용은 거절한다. `verify-backend-source.mjs`는 깨끗한 archive에 patch를 적용한 결과와 빌드 소스의 해당 파일들을 byte 비교한다. `CORRAL_BACKEND_TEST=1`이면 실제 PTY를 같은 terminal ID에 재기동한 뒤 이전 세대의 send/interrupt/close를 거절하는 Rust 테스트도 실행한다. 이 테스트에도 `HERDR_CONFIG_PATH`·`XDG_CONFIG_HOME`을 별도 build root로 지정한다.

검증 helper는 새 git repo/worktree·config·profile·session·소켓을 만들고 자신이 기동한 PID만 종료한다. 환경에서 `CORRAL_VERIFY_OWNER=review-codex` 또는 `review-grok`를 지정하면 `/tmp/l393-review-<tool>-*`와 `life393-review-<tool>-*` 세션을 사용한다. `CORRAL_VERIFY_RAW`로 원자료 출력 디렉터리를 별도 지정할 수 있다. 실제 Claude/Codex/Grok 제품 실행 대신 shell/Python 수신 fixture를 사용한다.

## 전역 설정 수집기 (`l394/global-config-diff.mjs`)

`before`·`after`는 사용자 전역 설정 8개 파일을 읽어 **개수와 salt digest만** 쓴다 — 파일마다 `exists`·`whole`·`keyCount`·`trustKeyCount`·`keysDigest`·`entriesDigest`. 값도 키 경로도 산출물에 남지 않는다. `diff`가 필요로 하는 키 단위 비교본은 **레포 밖 사이드카**(`L394_SIDECAR_DIR`, 기본값은 salt 파일과 같은 디렉터리. 디렉터리 mode 0700 · 파일 0600)에 `l394-keys-<raw 경로 digest>-{before,after}.json` 으로 간다. 사이드카는 키 맵만 담는다 — 자기 자신에서 다시 계산할 수 있는 digest 를 곁에 저장하면 검증이 아니다 (리뷰 V13·claude #6).

키 경로에 남는 **경로형 세그먼트**(`/` 를 포함하거나 `~` 로 시작)는 전부 같은 salt 로 `<p:digest>` 치환한다 (`l394/redact.mjs`). 판정은 이름을 `.` 으로 나눈 **어느 파트라도** 경로형이면 원래 이름 **전체**를 치환하는 쪽이다 — 완성된 키 경로는 점으로 다시 쪼개 읽히므로 `prefix.~secret` 처럼 통째로는 경로형이 아닌 이름도 세그먼트를 만들면 걸린다 (리뷰 V4). TOML 인용 키는 basic/literal string 규칙과 escape(`\"`·`\\`·`\uXXXX`·`\UXXXXXXXX`)를 해석한 **원래 키 한 개**를 치환하고, 읽을 수 없는 헤더는 파트로 쪼개지 않고 줄 전체를 한 토큰으로 치환한다 (리뷰 V1). 디렉터리 엔트리 이름도 같은 규칙을 지난다 (V12). `~/.claude.json` 의 `projects.<절대경로>.*`, `~/.codex/config.toml` 의 `[projects."<절대경로>"]`, `~/.grok/trusted_folders.toml` 의 키 전량이 사용자 디렉터리 이름이었다 (LIFE-426). 치환은 세그먼트 단위라 선두 세그먼트와 말단 키 이름이 그대로 남고, LIFE-409 F13 의 `summary` 판정과 LIFE-410 F14 의 `isTrust` 분류가 형식 변경 전과 같이 동작한다. 수집 파일 이름도 `~/` 를 떼고 구분자를 점으로 바꿔 쓴다 (`~/.claude/settings.json` → `.claude.settings.json`).

`diff`는 사이드카의 키 맵을 두 번 다시 digest 해서 스냅샷과 대조한다 — 키 목록은 `keysDigest`, `[키, 값 digest]` 쌍은 `entriesDigest`. 키 목록만 보면 **같은 키·다른 값** 사이드카가 통과해서, `after` 사이드카를 `before` 자리에 두면 exit 0 과 빈 diff 가 나왔다 (리뷰 V3). 사이드카가 없거나 두 digest 중 하나라도 어긋나면 **exit 3 으로 멈춘다** — 관문이 "키 경로 0개"를 "아무것도 안 움직였다"로 읽기 때문에 조용한 빈 diff 를 내면 안 된다.

`selftest`는 양성 대조 **열**이며 하나라도 깨지면 **exit 1** 한다: ① 같은 키 아래 값 변경(D7) ② 키 추가·삭제 ③ trust 키 추가와 F14 분류 유지 ④ 가짜 홈(`/Users/<가짜>` 키가 든 JSON·TOML)을 before→after→diff 로 굴린 뒤 산출물·사이드카 누출 0건, 그리고 치환 **전** 같은 fixture 는 검출되는지 음성 대조(V9) ⑤ `summary` 계수 ⑥ TOML 인용 키 6형(큰따옴표·작은따옴표·escaped quote·`\u002f`·`key = value` 두 형, V1) ⑦ 점 뒤에 경로형 파트가 오는 JSON 키 3형(V4) ⑧ 다른 스냅샷의 사이드카 → exit 3, 대조군 → exit 0(V3) ⑨ `~` 로 시작하는 hooks 엔트리(V12) ⑩ 사이드카 디렉터리 mode 0700(V13). ① 을 뺀 전부가 이 스크립트를 자식 프로세스로 실제 실행한다. ⑥~⑨ fixture 는 경로형 키 안에 표식(`TOPSECRET`)을 심고 **표식이 어느 산출물에도 없음**을 단언한다 — 반쯤 치환된 디렉터리 이름은 경로 모양이 남지 않아 누출 검사로는 보이지 않는다.

`leak-check.mjs`는 01-criteria 의 누출 검사 2중 검사를 그대로 돌린다 — ① `/Users/`·`/private/`·`/tmp/`·`/Volumes/`·`/home/`·`~/` grep ② JSON 문자열(키와 키 경로 값 모두)의 경로형 세그먼트. 적중은 파일·줄·패턴만 보고하고 적중한 **문자열 자체는 출력하지 않는다** — 이 출력이 그대로 원자료로 커밋되기 때문이다. 같은 이유로 파일 경로는 스캔 루트 기준 상대경로로 내고 스캔 루트 자체도 치환한다 (리뷰 V7: 절대경로 인자로 돌리면 출력 자신이 누출이었다). **갈래 ② 는 `.json` 전용**이라 `.md` 산출물은 grep 만 받는다 (V10 — 지금 두 관문의 markdown 은 `summary` 계수만 인라인하고 키 경로를 싣지 않는다). 읽을 수 없는 것은 통과가 아니다: 파싱 안 되는 `.json` 과 NUL 든 `.json` 은 `prong: "unreadable"` 적중으로 세고, 훑은 파일이 0개인 실행도 **exit 1** 이다 (V6). `.json` 이 아닌 바이너리만 조용히 건너뛴다. `selftest` 가 V6·V7 대조를 돌린다.

직접 GUI/runtime을 연결할 때는 같은 backend의 `CORRAL_BACKEND_SOCKET`·`CORRAL_SESSION`을 명시하고 각 GUI의 `CORRAL_USER_DATA`·`CORRAL_CONTROL_SOCKET`을 나눈다. debug backend의 named session 소켓은 `$XDG_CONFIG_HOME/herdr-dev/sessions/$CORRAL_SESSION/herdr.sock`이다. backend는 외부 프로세스로 runtime과 독립적으로 살아 있으며, runtime의 종료/재시작은 backend를 기동하거나 종료하지 않는다. 기존 runtime/profile 저장·복원 규칙을 사용한다.

## 계약

- `corral.terminal`은 backend boot nonce, 실제 PTY 런타임 세대, pane/terminal 매핑, 절대 deadline을 App 이벤트 루프의 같은 실행 구간에서 확인하고 기존 lifecycle/input/read 함수를 호출한다. PTY 런타임 객체마다 증가하는 세대 번호는 같은 terminal ID의 내부 shell 재기동도 구분한다. 검사와 효과 사이 별도 큐·await·이벤트 drain이 없다.
- `--expect-process`는 미지원이다. 일반 입력은 선택 PTY의 현재 foreground에 전달하며 process/agent/Dispatch 소유권을 보장하지 않는다. 조건부 요청을 일반 입력/종료로 바꾸지 않는다.
- raw 출력은 PTY가 낸 마지막 1,048,576 bytes를 PTY 런타임 수명 동안 보존한다. cursor는 profile 서명, backend/PTY 세대, byte offset, 최대 3-byte UTF-8 carry를 갖는다. `bytesBase64`는 정확한 바이트이고 `text`는 UTF-8 해석이다. 유효하지 않은 UTF-8은 text에서 replacement 문자로 표현되지만 base64에는 그대로 남는다. 보존 손실은 `gap/truncated/retainedFrom/recoveryCursor`로 표시한다.
- `--screen`은 herdr의 현재 visible screen snapshot이다. raw 출력과 다르며 cursor가 없다. GUI는 기존 endpoint+xterm을 계속 사용한다.
- create/send receipt는 효과 전에 fsync한 pending 기록, 효과 후 completed 결과로 남는다. 24시간·10,000개까지 보존한다. `r1.<Unix ms>.<UUID>` ID를 새 요청 직전에 만들며 CLI는 생략 시 생성한다. 같은 ID/같은 입력은 결과 재생, 다른 입력은 conflict다. runtime은 수락한 ID와 fingerprint를 결과 파일과 별도로 기억하므로 파일 유실도 용량을 해제하지 않는다. 만료 ID는 expired, 이미 수락했거나 이전 runtime보다 오래된 missing ID 또는 pending receipt는 unknown으로 거절한다. 입력 본문은 receipt에 저장하지 않고 fingerprint만 저장한다.
- `--stdin`은 선두 U+FEFF(BOM)를 포함한 유효 UTF-8을 literal bytes로 전달한다. NUL·잘못된 UTF-8·65,536 bytes 초과는 효과 없이 거절한다.
- **`agent_ops` (LIFE-394).** guard handshake가 `"agent_ops": 1`을 실으면 `agent.start`·`agent.get`·`agent.prompt`가 같은 `corral.terminal` 봉투 안에서 돈다. 싣지 않는 backend(스톡 herdr, LIFE-393 guard 빌드)에서 agent 명령은 **pane을 만들기 전에** `unsupported_backend`로 거절한다 — 반쯤 만들어진 pane이 남지 않는다.
- **`agent.prompt`는 compare-and-submit이다.** herdr의 app dispatch table에 `agent.prompt`가 없으므로 guard가 직접 `App::queue_agent_prompt`를 부르되, 호출자가 보낸 `expected_state_change_seq`가 현재 값과 다르면 효과 없이 `agent_not_ready`로 거절하고 오류에 관측한 `AgentInfo`를 싣는다. 검사와 효과 사이에 await이 없다.
- **`server.agent_manifests`는 target 없는 읽기 전용 갈래다.** corral이 어떤 detect 매니페스트가 실제로 활성인지 guard 봉투 안에서 확인한다. pane을 겨냥하지 않으므로 비교할 세대가 없다.
- **detect patch (LIFE-394).** codex·grok의 `trust_directory` 규칙을 "지금 살아 있는 chooser"까지 좁히고 두 매니페스트 `version`을 `2026.09.21.3`으로 올린다. 인용문과 live 다이얼로그를 가르는 것은 선택지 줄쌍과, 그 **뒤에** 오는 composer/footer **전체 행**을 잡는 `not` 게이트다 — 임의 위치의 부분 문자열이 아니다(cwd에 마커가 들어간 실제 chooser와, chooser 위에 남은 옛 footer 한 줄이 반례였다). corral은 이 버전을 기대값으로 들고 있고, guard가 그 provider의 활성 매니페스트를 기대 버전·`bundled`·그림자 없음으로 답하지 않으면 **제출 자체를 하지 않는다**(`detect_manifest_unverified`). claude 매니페스트는 손대지 않지만 같은 게이트를 지난다 — 기대값은 스톡 bundled 버전 `2026.09.04.1`이다.
- guard 빌드가 실제로 무엇을 활성 매니페스트로 보는지는 `corral terminal show --terminal HANDLE --json`의 `agent.evidence.detectManifest`, 또는 guard 봉투로 직접 부른 `server.agent_manifests`로 확인한다.
- GUI focus는 renderer의 worktree/tab 준비 및 실제 선택된 pane의 DOM 키보드 focus와 main의 선택이 일치한다는 ACK 뒤 성공한다. wait의 ready는 transport, send의 성공은 backend 수락이다. 프로그램 소비·agent ready·작업 완료는 별도 계약이다.

`node app/scripts/l393/negative.mjs`는 timeout 전파를 검증하기 위해 **의도적으로 exit 1** 한다. 성공으로 감추면 안 된다.
