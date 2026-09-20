# Terminal backend v1

LIFE-393 CLI는 명시적으로 연결한 corral terminal backend를 쓴다. 설치 herdr 0.9.0에는 이 가드/출력 계약이 없으므로 `unsupported_backend`로 거절하며, 설치본을 교체하거나 가드 없는 제어로 fallback하지 않는다. 기존 GUI 경로는 그대로 설치 backend에도 연결할 수 있다.

`source.json`의 upstream v0.9.0 commit/archive와 두 patch가 빌드 입력이다. stream patch는 과거 후보 `ca85c70`에서 필요한 PTY 출력 링 부분만 추출했다. guard patch는 이번 구현이다. 관리 범위는 macOS arm64, Rust 1.96.1, Zig 0.15.2, 로컬 SDK 15.4다. 다른 OS/아키텍처 지원을 주장하지 않는다.

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
node app/scripts/l393/installed.mjs
```

빌드 root 안에 도구 체인·의존성·소스·binary와 `<binary>.json` 영수증이 생긴다. archive SHA-256을 검사하고, patch 집합이 달라진 캐시의 재사용은 거절한다. `verify-backend-source.mjs`는 깨끗한 archive에 patch를 적용한 결과와 빌드 소스의 해당 파일들을 byte 비교한다. `CORRAL_BACKEND_TEST=1`이면 실제 PTY를 같은 terminal ID에 재기동한 뒤 이전 세대의 send/interrupt/close를 거절하는 Rust 테스트도 실행한다. 이 테스트에도 `HERDR_CONFIG_PATH`·`XDG_CONFIG_HOME`을 별도 build root로 지정한다.

검증 helper는 새 git repo/worktree·config·profile·session·소켓을 만들고 자신이 기동한 PID만 종료한다. 환경에서 `CORRAL_VERIFY_OWNER=review-codex` 또는 `review-grok`를 지정하면 `/tmp/l393-review-<tool>-*`와 `life393-review-<tool>-*` 세션을 사용한다. `CORRAL_VERIFY_RAW`로 원자료 출력 디렉터리를 별도 지정할 수 있다. 실제 Claude/Codex/Grok 제품 실행 대신 shell/Python 수신 fixture를 사용한다.

직접 GUI/runtime을 연결할 때는 같은 backend의 `CORRAL_BACKEND_SOCKET`·`CORRAL_SESSION`을 명시하고 각 GUI의 `CORRAL_USER_DATA`·`CORRAL_CONTROL_SOCKET`을 나눈다. debug backend의 named session 소켓은 `$XDG_CONFIG_HOME/herdr-dev/sessions/$CORRAL_SESSION/herdr.sock`이다. backend는 외부 프로세스로 runtime과 독립적으로 살아 있으며, runtime의 종료/재시작은 backend를 기동하거나 종료하지 않는다. 기존 runtime/profile 저장·복원 규칙을 사용한다.

## 계약

- `corral.terminal`은 backend boot nonce, 실제 PTY 런타임 세대, pane/terminal 매핑, 절대 deadline을 App 이벤트 루프의 같은 실행 구간에서 확인하고 기존 lifecycle/input/read 함수를 호출한다. PTY 런타임 객체마다 증가하는 세대 번호는 같은 terminal ID의 내부 shell 재기동도 구분한다. 검사와 효과 사이 별도 큐·await·이벤트 drain이 없다.
- `--expect-process`는 미지원이다. 일반 입력은 선택 PTY의 현재 foreground에 전달하며 process/agent/Dispatch 소유권을 보장하지 않는다. 조건부 요청을 일반 입력/종료로 바꾸지 않는다.
- raw 출력은 PTY가 낸 마지막 1,048,576 bytes를 PTY 런타임 수명 동안 보존한다. cursor는 profile 서명, backend/PTY 세대, byte offset, 최대 3-byte UTF-8 carry를 갖는다. `bytesBase64`는 정확한 바이트이고 `text`는 UTF-8 해석이다. 유효하지 않은 UTF-8은 text에서 replacement 문자로 표현되지만 base64에는 그대로 남는다. 보존 손실은 `gap/truncated/retainedFrom/recoveryCursor`로 표시한다.
- `--screen`은 herdr의 현재 visible screen snapshot이다. raw 출력과 다르며 cursor가 없다. GUI는 기존 endpoint+xterm을 계속 사용한다.
- create/send receipt는 효과 전에 fsync한 pending 기록, 효과 후 completed 결과로 남는다. 24시간·10,000개까지 보존한다. `r1.<Unix ms>.<UUID>` ID를 새 요청 직전에 만들며 CLI는 생략 시 생성한다. 같은 ID/같은 입력은 결과 재생, 다른 입력은 conflict다. 만료 ID는 expired, 이전 runtime보다 오래된 missing ID 또는 pending receipt는 unknown으로 거절한다. 입력 본문은 receipt에 저장하지 않고 fingerprint만 저장한다.
- GUI focus는 renderer의 worktree/tab 준비 및 실제 선택된 pane의 DOM 키보드 focus와 main의 선택이 일치한다는 ACK 뒤 성공한다. wait의 ready는 transport, send의 성공은 backend 수락이다. 프로그램 소비·agent ready·작업 완료는 별도 계약이다.

`node app/scripts/l393/negative.mjs`는 timeout 전파를 검증하기 위해 **의도적으로 exit 1** 한다. 성공으로 감추면 안 된다.
