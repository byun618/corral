# Terminal backend v1

LIFE-393 CLI는 명시적으로 연결한 corral terminal backend를 쓴다. 설치 herdr 0.9.0에는 이 가드/출력 계약이 없으므로 `unsupported_backend`로 거절하며, 설치본을 교체하거나 가드 없는 제어로 fallback하지 않는다. 기존 GUI 경로는 그대로 설치 backend에도 연결할 수 있다.

`source.json`의 upstream v0.9.0 commit/archive와 **여섯 patch**가 빌드 입력이다(네 번째 bundle patch 는 LIFE-556 — 아래 「설치본 동봉 release 빌드」, 다섯 번째 shift-enter patch 는 LIFE-571, 여섯 번째 restore patch 는 LIFE-628). stream patch는 과거 후보 `ca85c70`에서 필요한 PTY 출력 링 부분만 추출했다. guard patch는 LIFE-393 구현이고 LIFE-394가 agent 갈래를 얹었다. detect patch는 LIFE-394가 추가했다. shift-enter patch는 레거시 pane(kitty 플래그 0·modifyOtherKeys 0)의 Shift+Enter 를 Ghostty 인코더의 `CSI 27;2;13~` 대신 `\r` 로 보낸다 — 렌더러가 Shift+Enter 를 CSI-u 로 보내도 셸 pane 은 지금처럼 Enter 로 받는다(LIFE-571). restore patch는 재기동 복원에서 저장된 pane cwd 가 없을 때 HOME 으로 바꿔 셸·에이전트를 띄우던 상류 0.9.0 동작을 상류 PR #4400(v0.9.2)의 동작으로 백포트한다 — 그 pane 은 PTY 없이(셸·에이전트 재개 없음) 저장 cwd·라벨·에이전트 세션 참조를 그대로 들고 남고(`restore_error` 에 사유), 지연 재개 직전에도 cwd 가 없으면 재개 계획을 지운다(`agent_resume.rs`, 상류 v0.9.5 257행과 같은 이중 문). cwd 가 있는 pane 의 재개는 그대로다. 상류 PR 의 나머지(API `restore_error` 필드·TUI 안내 문구·셸 기동 실패 처리·history 지문·Linux 종료)는 가져오지 않았다(LIFE-628). 적용 순서는 stream → guard → detect → bundle → shift-enter → restore로 고정이며 `patch_digest`가 여섯 파일을 모두 덮으므로 patch가 바뀌면 새 build root가 필요하다. 관리 범위는 macOS arm64, Rust 1.96.1, Zig 0.15.2, 로컬 SDK 15.4다. 다른 OS/아키텍처 지원을 주장하지 않는다.

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
node app/scripts/l394/leak-check.mjs selftest          # 그 검사기 자신의 대조 (V6·V7·V15·V23)
node app/scripts/l409/attribution.mjs selftest         # F13 실패 경로의 양성 대조 (V2·V14)
```

## 개발 실행용 레포 guard (LIFE-561)

바인딩 없는 개발 실행(`npm run dev` 류, `CORRAL_SESSION`·`CORRAL_BACKEND_SOCKET`·`CORRAL_HERDR_BIN`·프로필 바인딩 없음)이 쓰는 debug guard 를 레포 명령 하나로 빌드한다.
brew 등 따로 설치한 herdr 가 없어도 레포 GUI 가 뜬다.

```sh
npm --prefix app run herdr:guard    # 레포 루트(어느 worktree 든)에서. app/ 안이면 npm run herdr:guard
```

- **고정 자리**: `<git-common-dir>/corral-herdr-dev/` — 본체 `.git` 안이라 `git status` 에 나타나지 않고, 본체와 모든 worktree 가 같은 자리를 본다.
  - `toolchain/` — rustup·cargo·zig·상류 archive. 칸끼리 한 번만 받는다(첫 빌드 실측 약 1.6GB).
  - `<패치 digest 16자>/` — build root 한 칸(실측 약 1.4GB). 칸 이름은 `build-terminal-backend.sh` 의 `patch_digest`(여섯 patch 를 순서대로 이은 sha256) 앞 16자다.
    바이너리는 `<칸>/herdr-0.9.0/target/debug/herdr`, 영수증은 그 옆 `herdr.json`.
- **재실행**: 그 칸의 영수증이 지금 체크아웃과 맞으면 빌드하지 않고 `up to date` 로 끝난다.
- **패치가 바뀌면** 같은 명령이 새 칸에 새로 빌드한다(툴체인은 다시 받지 않는다) — `use a fresh CORRAL_BACKEND_BUILD_ROOT` 로 멈추지 않는다.
  패치가 다른 브랜치는 자기 칸을 따로 갖는다. 옛 칸은 지우지 않는다 — 필요 없으면 손으로 지운다(도는 서버가 그 바이너리를 쓰고 있지 않은지 먼저 본다).
- 칸의 바이너리를 **다시** 빌드해야 하는데(영수증 불일치) 그 바이너리로 도는 `herdr server`·`herdr --session <이름> server` 가 있으면 빌드하지 않고 멈춘다 — 실행 중 실행 파일을 바꾸면
  서버가 pane 에 알려 준 `HERDR_BIN_PATH` 가 깨질 수 있다(상류 #4474). 그 서버를 멈춘 뒤 다시 실행한다.
- **중단된 칸**: 압축 풀기·패치 적용 중 끊긴 칸(트리는 있는데 패치 표식 `.corral-patches` 가 없거나 다름)은 다음 실행이 그 트리를 지우고 다시 푼다 — 같은 명령을 다시 돌리면 된다.
- **동시 실행**: 빌드는 자리 전체(공유 `toolchain/`·모든 칸)에 잠금 하나 `<자리>/build.lock` 을 잡고 돈다 — 다른 worktree 의 다른 칸 빌드와도 동시에 돌지 않는다.
  잠금이 이미 있으면 누구 것이든 거절하고, 기록(래퍼 pid·빌더 프로세스 그룹)과 확인·삭제 명령을 한 줄로 보인다. 자동으로 걷지 않는다.
  정상 종료·Ctrl-C·SIGTERM·SIGHUP 에서는 잠금을 걷고(빌드 중이면 신호를 빌더 그룹에 넘기고 끝나기를 기다린다), `kill -9` 등으로 래퍼가 죽으면 잠금이 남는다 —
  안내대로 아무것도 돌지 않는 것을 확인한 뒤 지운다.
- **공유 툴체인 복구**: 빌드 전에 `toolchain/` 을 점검한다 — 상류 archive·zig archive 의 sha256 이 틀리면(끊긴 다운로드) 지우고 다시 받는다(`.part` 로 받아 검증 뒤 옮김),
  덜 풀린 zig 폴더(archive 목록과 파일 대조)는 지우고 다시 풀며, cargo·rustc 가 답하지 않는 rustup 설치는 지우고 다시 깐다. 그래도 실패하면 지울 대상을 한 줄로 안내한다.
  이 점검은 `herdr:guard` 래퍼에만 있다 — `CORRAL_BACKEND_BUILD_ROOT` 직접 호출은 종전 그대로다.
- **앱의 해소 순서**(`src/main/adapter/internal/server.ts` `locateHerdr`, 개발 실행·바인딩 없음): `CORRAL_HERDR_BIN` → **레포 guard** → 로그인 셸 `command -v herdr` → 알려진 위치.
  설치본은 동봉만(LIFE-556 그대로), 바인딩 있는 개발 실행은 종전대로 레포 guard 를 보지 않는다. `herdr.resolve` 로그의 `source` 가 `repo-guard` 다.
  - **없음**(고정 자리 자체가 없다 — 이 레포에서 빌드한 적이 없다): 종전 후보로 내려간다. 그것도 없으면 미설치 카드가 위 빌드 명령을 안내한다.
  - **낡음**(자리는 있는데 이 체크아웃과 맞지 않는다 — 이 패치의 칸이 없음, 영수증의 profile·패치 sha256·상류 commit·archive 불일치, 바이너리 sha256 불일치):
    그 바이너리를 쓰지 않고 **종전 후보로도 내려가지 않는다**. 카드가 어긋난 이유 한 줄과 재빌드 명령을 보인다. 재빌드하면 1분 안에 다시 찾는다.
    대조 규칙은 `src/main/adapter/internal/dev-guard.ts` `checkGuardReceipt` 와 `scripts/build-dev-guard.mjs` 가 같다.
- **앱 경로 가정**: 앱은 `app.getAppPath()` 를 체크아웃의 `app/` 로 보고 그 `backend/`·git 공용 폴더를 읽는다. 개발 실행은 `app/` 디렉터리(`electron .`·`npm run dev`)로 띄운다 —
  파일 경로 인자로 띄우면 `source.json` 을 못 읽어 낡음 카드(읽으려던 경로가 이유에 실린다)로 멈춘다.
- **폴더·세션**: debug guard 의 앱 폴더는 `herdr-dev`(`~/.config/herdr-dev`) — 세션 폴백 폴더도 그것을 따른다. 레포 guard 로 풀린 개발 실행은
  `herdr-dev` 의 **`default` 하나에만** 붙는다(설치본과 같은 규칙). 다른 이름 세션(다른 작업의 서버)이 돌고 있어도 붙지 않고, `default` 가 없거나 멈췄으면
  종전 기동 규칙(확인 카드·자동 기동)대로 `default` 를 띄운다. 이름 세션에는 `CORRAL_SESSION` 명시 바인딩으로만 붙는다.
- **`CORRAL_BACKEND_BUILD_ROOT` 직접 호출과의 관계**: `herdr:guard` 는 `build-terminal-backend.sh` 를 `CORRAL_BACKEND_BUILD_ROOT=<칸>`·
  `CORRAL_BACKEND_TOOLCHAIN_ROOT=<자리>/toolchain`·`CORRAL_BACKEND_PROFILE=debug` 로 부르는 래퍼다. 직접 호출(위·아래 절의 debug·release)은 그대로 돈다 —
  `CORRAL_BACKEND_TOOLCHAIN_ROOT` 를 주지 않으면 종전처럼 툴체인도 build root 안에 둔다. 측정·하네스는 종전대로 명시 바인딩이나 자기 build root 를 쓴다.

## 설치본 동봉 release 빌드 (LIFE-556)

```sh
export CORRAL_BACKEND_BUILD_ROOT="$(mktemp -d /tmp/corral-herdr-release-XXXXXX)"
CORRAL_BACKEND_PROFILE=release sh app/scripts/build-terminal-backend.sh   # → target/release/herdr + herdr.json
npm --prefix app run package:mac                                          # scripts/bundle-herdr.mjs 가 검증해 Contents/Resources/backend/ 에 넣는다
```

- **같은 스크립트·같은 패치**다. `CORRAL_BACKEND_PROFILE` 기본값은 `debug` 라 종전 명령은 그대로 debug 를 만든다. release 는 `cargo build --release` 에
  `--remap-path-prefix=<build root>=/corral-herdr-build` 를 붙여 build root 경로(`/tmp`·`CARGO_HOME`)가 바이너리에 박히지 않게 한다.
  영수증에 `profile`·`buildSeconds`·`binaryBytes` 가 더 실린다(실측: release 44~82초·약 20MB, debug 약 68MB).
- **`herdr-bundle.patch`** (stream → guard → detect → bundle → shift-enter → restore 순서의 넷째). 이 패치가 바꾸는 아래 네 가지는 release 에서만 바뀌고 debug 동작은 그대로다.
  다섯째 `herdr-shift-enter.patch`(LIFE-571, 레거시 pane Shift+Enter → `\r`)와 여섯째 `herdr-restore.patch`(LIFE-628, cwd 없는 pane 복원)는 프로필과 무관하게 **debug·release 둘 다** 바꾼다 — 위 첫 절:
  - 앱 폴더 이름 `app_dir_name()` — release `corral-herdr` (stock `herdr`), debug `herdr-dev` 유지. 설정 `~/.config/corral-herdr`(`XDG_CONFIG_HOME`
    아래) · 상태 `~/.local/state/corral-herdr` · 세션·소켓(`herdr.sock`·`herdr-client.sock`)이 전부 이 이름을 따른다. 그래서 따로 설치한 herdr
    (`~/.config/herdr`)와 소켓·세션·config 를 나누지 않는다. `XDG_*` 를 서버 env 로 주는 방식은 pane 셸이 물려받으므로 쓰지 않는다.
  - 백그라운드 업데이트·매니페스트 확인 끔(`auto_updates_enabled` → false — debug 는 원래 꺼져 있다).
  - `herdr update` 거절 — `self-update is disabled for the herdr bundled with corral; update corral instead`(exit 1, 바이너리 무변경).
  - worktree 기본 위치(`src/config/model.rs` WorktreesConfig) — release `~/.corral-herdr/worktrees`, debug 는 상류 `~/.herdr/worktrees` 그대로.
    `app_dir_name()` 을 따르지 않는 상류 기본값이라 따로 바꿨다(LIFE-556 fix1 M2). 사용자 config 의 `worktrees.directory` 가 있으면 그것이 먼저다.
- corral 쪽 짝: `src/main/adapter/internal/server.ts` 의 `BUNDLED_HERDR_APP_DIR`(패치 값과 같이 바뀌어야 한다)·`bundledHerdrPath()`,
  설치본 서버 env 는 `bundledServerEnv()`(`HERDR_*` 전부 뺌, `XDG_*` 손대지 않음).
- 번들 안 `backend/herdr.json` 의 `buildBinarySHA256` 은 cargo 산출물 값이다 — electron-builder 가 번들을 ad-hoc 재서명하므로 번들 안 바이너리
  sha256 은 다르다.

빌드 root 안에 도구 체인·의존성·소스·binary와 `<binary>.json` 영수증이 생긴다. archive SHA-256을 검사하고, patch 집합이 달라진 캐시의 재사용은 거절한다. `verify-backend-source.mjs`는 깨끗한 archive에 patch를 적용한 결과와 빌드 소스의 해당 파일들을 byte 비교한다. `CORRAL_BACKEND_TEST=1`이면 실제 PTY를 같은 terminal ID에 재기동한 뒤 이전 세대의 send/interrupt/close를 거절하는 Rust 테스트도 실행한다. 이 테스트에도 `HERDR_CONFIG_PATH`·`XDG_CONFIG_HOME`을 별도 build root로 지정한다.

검증 helper는 새 git repo/worktree·config·profile·session·소켓을 만들고 자신이 기동한 PID만 종료한다. 환경에서 `CORRAL_VERIFY_OWNER=review-codex` 또는 `review-grok`를 지정하면 `/tmp/l393-review-<tool>-*`와 `life393-review-<tool>-*` 세션을 사용한다. `CORRAL_VERIFY_RAW`로 원자료 출력 디렉터리를 별도 지정할 수 있다. 실제 Claude/Codex/Grok 제품 실행 대신 shell/Python 수신 fixture를 사용한다.

## 전역 설정 수집기 (`l394/global-config-diff.mjs`)

`before`·`after`는 사용자 전역 설정 8개 파일을 읽어 **개수와 salt digest만** 쓴다 — 파일마다 `exists`·`whole`·`keyCount`·`trustKeyCount`·`keysDigest`·`entriesDigest`. 값도 키 경로도 산출물에 남지 않는다. `diff`가 필요로 하는 키 단위 비교본은 **레포 밖 사이드카**(`L394_SIDECAR_DIR`, 기본값은 salt 파일과 같은 디렉터리. 디렉터리 mode 0700 · 파일 0600)에 `l394-keys-<raw 경로 digest>-{before,after}.json` 으로 간다. 사이드카는 키 맵만 담는다 — 자기 자신에서 다시 계산할 수 있는 digest 를 곁에 저장하면 검증이 아니다 (리뷰 V13·claude #6).

키 경로에 남는 **경로형 세그먼트**(`/` 를 포함하거나 `~` 로 시작)는 전부 같은 salt 로 `<p:digest>` 치환한다 (`l394/redact.mjs`). 판정은 이름을 `.` 으로 나눈 **어느 파트라도** 경로형이면 원래 이름 **전체**를 치환하는 쪽이다 — 완성된 키 경로는 점으로 다시 쪼개 읽히므로 `prefix.~secret` 처럼 통째로는 경로형이 아닌 이름도 세그먼트를 만들면 걸린다 (리뷰 V4). TOML 인용 키는 basic/literal string 규칙과 escape(`\"`·`\\`·`\uXXXX`·`\UXXXXXXXX`)를 해석한 **원래 키 한 개**를 치환하고, 읽을 수 없는 헤더는 파트로 쪼개지 않고 줄 전체를 한 토큰으로 치환한다 (리뷰 V1). 디렉터리 엔트리 이름도 같은 규칙을 지난다 (V12). `~/.claude.json` 의 `projects.<절대경로>.*`, `~/.codex/config.toml` 의 `[projects."<절대경로>"]`, `~/.grok/trusted_folders.toml` 의 키 전량이 사용자 디렉터리 이름이었다 (LIFE-426). 치환은 세그먼트 단위라 선두 세그먼트와 말단 키 이름이 그대로 남고, LIFE-409 F13 의 `summary` 판정과 LIFE-410 F14 의 `isTrust` 분류가 형식 변경 전과 같이 동작한다. 수집 파일 이름도 `~/` 를 떼고 구분자를 점으로 바꿔 쓴다 (`~/.claude/settings.json` → `.claude.settings.json`).

`diff`는 사이드카의 키 맵을 두 번 다시 digest 해서 스냅샷과 대조한다 — 키 목록은 `keysDigest`, `[키, 값 digest]` 쌍은 `entriesDigest`. 키 목록만 보면 **같은 키·다른 값** 사이드카가 통과해서, `after` 사이드카를 `before` 자리에 두면 exit 0 과 빈 diff 가 나왔다 (리뷰 V3). 사이드카가 없거나 두 digest 중 하나라도 어긋나면 **exit 3 으로 멈춘다** — 관문이 "키 경로 0개"를 "아무것도 안 움직였다"로 읽기 때문에 조용한 빈 diff 를 내면 안 된다.

`selftest`는 양성 대조 **열넷**이며 하나라도 깨지면 **exit 1** 한다: ① 같은 키 아래 값 변경(D7) ② 키 추가·삭제 ③ trust 키 추가와 F14 분류 유지 ④ 가짜 홈(`/Users/<가짜>` 키가 든 JSON·TOML)을 before→after→diff 로 굴린 뒤 산출물·사이드카 누출 0건, 그리고 치환 **전** 같은 fixture 는 검출되는지 음성 대조(V9) ⑤ `summary` 계수 ⑥ TOML 인용 키 6형(큰따옴표·작은따옴표·escaped quote·`\u002f`·`key = value` 두 형, V1) ⑦ 점 뒤에 경로형 파트가 오는 JSON 키 3형(V4) ⑧ 다른 스냅샷의 사이드카 → exit 3, 대조군 → exit 0(V3) ⑨ `~` 로 시작하는 hooks 엔트리(V12) ⑩ 사이드카 디렉터리 mode 0700(V13) ⑪ 공백이 든 **완전한 경로**가 `describePath` 를 지나 토큰 하나가 되는지, 같은 입력에 `text` 를 쓰면 이름이 남는지(V15) ⑫ `foregroundExecutable()` 기록이 `redact.executable` 을 지나면 경로가 0 이고 `pid`·`name`·`shellPid` 는 남는지(V16) ⑬ 같은 기록의 `comm` 이 경로일 때 — 공백 든 절대경로·`npm exec …` 명령줄·공백 **뒤에** 표식이 오는 경로 — 통째로 토큰이 되고, 진짜 이름(`claude`)은 그대로 남는지(V19) ⑭ 관문 실패 메시지 세 형태(`:67` 불일치·`:52` foreground 없음·JSON 없는 폴백)가 `redact.diagnostic` 을 지나면 경로가 0 이고 원인 문장과 `pid`·`name`·`--model`·`shellPid` 는 남는지, 같은 입력에 `text` 를 쓰면 표식이 남는지(V25). **②~⑩ 은 수집기를 자식 프로세스로 실행한 산출물 검증이고, ①·⑪~⑭ 은 함수 직접 호출이다** (리뷰 V27 — 이 자리에 "① 을 뺀 전부가 자식 프로세스로 실행한다" 고 적혀 있었으나 ⑪~⑭ 은 fixture 를 함수에 직접 넣는다). ⑥~⑨ fixture 는 경로형 키 안에 표식(`TOPSECRET`)을 심고 **표식이 어느 산출물에도 없음**을 단언한다 — 반쯤 치환된 디렉터리 이름은 경로 모양이 남지 않아 누출 검사로는 보이지 않는다.

`leak-check.mjs`는 01-criteria 의 누출 검사 2중 검사를 그대로 돌린다 — ① `/Users/`·`/private/`·`/tmp/`·`/Volumes/`·`/home/`·`~/` grep ② JSON 문자열(키와 키 경로 값 모두)의 경로형 세그먼트. 적중은 파일·줄·패턴만 보고하고 적중한 **문자열 자체는 출력하지 않는다** — 이 출력이 그대로 원자료로 커밋되기 때문이다. 같은 이유로 파일 경로는 스캔 루트 기준 상대경로로 내고 스캔 루트 자체도 치환한다 (리뷰 V7: 절대경로 인자로 돌리면 출력 자신이 누출이었다). **갈래 ② 는 `.json` 전용**이라 `.md` 산출물은 grep 만 받는다 (V10 — 지금 두 관문의 markdown 은 `summary` 계수만 인라인하고 키 경로를 싣지 않는다). 읽을 수 없는 것은 통과가 아니다: 파싱 안 되는 `.json` 과 NUL 든 `.json` 은 `prong: "unreadable"` 적중으로 세고, 훑은 파일이 0개인 실행도 **exit 1** 이다 (V6). `.json` 이 아닌 바이너리만 조용히 건너뛴다. 스캔 루트는 **경로 하나라 통째로 토큰**이다 — 공백이 든 루트(`…/root TOPSECRET`)에 `redact.text` 를 쓰면 가운데 이름이 자기 출력에 남았다 (V15). 치환되는 것은 **루트뿐이고, 루트 아래 이름**(`hitsByFile` 의 키·`firstHits[].file`)**은 상대경로 원문으로 나온다** (V22) — 커밋된 raw 트리가 대상이라 그 이름들은 이미 git 안에 있어서 무해하지만, 그래서 **이 검사기는 그 트리 밖(홈 디렉터리 등)에 돌리는 용도가 아니다**. `selftest` 가 대조 **다섯**을 돌린다: V6·V7·V15 에 더해, 제품 CLI 를 자식 프로세스로 공백·표식 든 루트에 실제 실행해 출력의 `targets` 가 토큰 하나임을 보는 V23 대조 — 라운드 2 의 V15 대조는 selftest 안의 호출만 봐서 제품 경로 회귀를 놓쳤다.

### 경로를 기록하는 규칙 (`l394/redact.mjs`)

- **완전한 경로 한 개는 `token`** — 경로 전체가 `<p:digest>` 하나가 되고 아무것도 남지 않는다. `describePath(파일)` 이 이 형태로 `{ name, path }` 를 낸다(`name` 은 파일 자기 이름이라 개인 정보가 아니다). 두 네이티브 관문의 `providerPath`, markdown 의 `install` 줄, `pathResolution`(줄마다 경로 하나 → 줄 단위), `leak-check.mjs` 의 `targets` 가 전부 이쪽이다.
- **경계를 모르는 텍스트만 `text`** — 프로세스 argv 잔여나 screen 발췌처럼 어디까지가 경로인지 알 수 없는 문자열에만 쓴다. 공백이 든 경로에서 가운데 이름(`Work TOPSECRET Files`)이 남는 손실이 있고, 그것이 `token` 을 기본으로 삼는 이유다 (리뷰 V15).
- **`foregroundExecutable()` 기록은 `redact.executable`** 로 기록 전에 치환한다 — `expected`·`observed[].executable`·`observed[].realpath`·`match` 의 같은 필드는 토큰, `observed[].argv` 원소는 경로형이면 토큰(그 argv 는 진짜 배열이라 원소 하나가 곧 완전한 경로다), **`comm` 도 같은 규칙**이다 — 경로형이면 통째 토큰, 아니면 `text`. `pid`·`name`·`shellPid` 만 그대로 남고, `name` 은 버전 디렉터리 이름이라 설치 동일성 확인에 쓰인다. 관문 단언은 치환 **전** 값으로 이미 끝나므로 의미가 변하지 않는다 (리뷰 V16).
- **`comm` 은 이름이 아니다** — macOS 의 `ps -o comm=` 은 argv[0] 을 낸다. 절대경로로 띄운 프로세스는 **호출 경로 전체**가, 래퍼로 띄운 프로세스는 명령줄(`npm exec …/mcp@latest`)이 거기 실린다. 경로형이면 통째 토큰이다 — 부분 `text` 로는 공백 뒤 이름이 남는다 (리뷰 V19; 애초에 "accounting name 이라 경로가 아니다" 라는 전제로 남겨 둔 필드였다). `/` 가 든 명령줄(`npm exec @scope/pkg@latest`)도 경로형으로 보고 통째 토큰한다 — 과치환이며 의도다 (리뷰 V28).
- **실패 메시지는 `diagnostic`** — `foregroundExecutable()` 의 단언 메시지는 치환 전 값으로 만들어지고, 관문이 실패하면 `lib.mjs` 가 그것을 `run.json` 의 `checks[].error` 로 적는다. `native-checks.mjs`·`lib.mjs` 는 이 작업에서 동결이라, 두 관문의 **호출부**에서 감싼다 (리뷰 V21). 감싸는 것은 `text` 가 아니라 `diagnostic` 이다 — 이 메시지는 `<원인 문장>: <JSON>` 형태라, 호출부가 이미 쥔 설치 realpath 를 `paths` 로 넘겨 **통째로** 치환하고 JSON 꼬리를 파싱해 **모든 문자열**을 같은 규칙(경로형이면 토큰)으로 바꾼다. 숫자·불리언·null·키 이름은 그대로라 `pid`·`shellPid`·`name: "claude"` 가 무엇이 실패했는지 계속 말한다. 라운드 3 은 여기에 `text` 를 썼고, 공백 든 설치 경로의 가운데 이름이 남았다 — 그 낱말에는 `/` 도 홈 접두사도 없어서 누출 검사 두 갈래 모두 보지 못한다 (리뷰 V25). **폴백의 한계**: 파싱할 JSON 꼬리가 없으면 `text` 로 떨어지므로, 호출부가 `paths` 로 이름 대지 않은 공백 든 경로는 가운데 이름을 남길 수 있다. 스택 프레임 경로는 이 레포 자신의 스크립트 위치라 범위 밖이다.
- **LIFE-409 N13 의 argv 는 digest 하나뿐이다** — `ps -o args=` 는 인자 경계가 사라진 한 줄이어서, 부분 치환으로도(V2) 이름을 잘라 내는 규칙으로도(V14) 디렉터리 이름이 되돌아왔다. 프로세스는 `pid`·`startedAt` 로 식별한다.

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
- **관리 밖 pane 갈래 (LIFE-597).** handshake가 `"unmanaged_prompt": 1`을 싣는다(`guard_version`은 1 그대로 — 봉투에 선택 칸 하나가 늘었을 뿐이다). `agent.prompt` 봉투에 `unmanaged_agent: "<종류>"`(폰 경로만)가 있고 pane에 관리 결속(`managed_agent`)이 없으면, 술어의 `interactive_ready` 대신 **감지 종류 = 그 종류**와 **감지 상태·종류가 마지막으로 바뀐 뒤 `AGENT_START_SETTLE_DELAY`(3 s) 이상**을 본다. 바뀐 시각은 상류 상태 전이 지점(`src/app/actions.rs` — `state_change_seq` 를 올리는 곳, 종류만 바뀐 경우 포함)에서 `TerminalState.corral_agent_changed_at`에 적는다. 그 밖(idle|done·launch_pending·seq·입력 울타리·전경 프로세스)은 관리 pane과 같다. 칸이 없으면(CLI·orchestration) 또는 관리 pane(Pending·Blocked·Active)이면 지금 술어 그대로다. 그 칸으로 거절하면 오류에 `unready`(`not_interactive_ready`·`unmanaged_kind_mismatch`·`unmanaged_settling`)가 실린다 — 칸 없는 요청의 오류 모양은 그대로다. `agent.get`은 `corral_state_quiet_ms`(마지막 변화 뒤 경과)를 싣는다. 상류 `interactive_ready` 상태 기계는 바꾸지 않는다. 이 칸을 모르는 guard는 칸을 무시하고 `interactive_ready`를 요구하므로 쓰지 않는다 — 앱은 handshake로 미리 알고 `guard_outdated`로 끝낸다(`app/src/main/mobile/SURFACE.md` §3 「쓰기」). 시험: `corral_terminal_takes_an_unmanaged_pane_only_when_asked`.
- **`server.agent_manifests`는 target 없는 읽기 전용 갈래다.** corral이 어떤 detect 매니페스트가 실제로 활성인지 guard 봉투 안에서 확인한다. pane을 겨냥하지 않으므로 비교할 세대가 없다.
- **detect patch (LIFE-394).** codex·grok의 `trust_directory` 규칙을 "지금 살아 있는 chooser"까지 좁히고 두 매니페스트 `version`을 `2026.09.21.3`으로 올린다(LIFE-603 K1 에서 codex-cli 0.162.1 의 새 신뢰 화면 「Folder access · Trust this folder?」 갈래를 codex 규칙의 `any` 에 더하며 두 버전을 함께 `2026.10.15.1` 로, K1b 에서 그 갈래를 문구 대신 「`Folder access` 제목 전체 줄 + 연속 번호 선택지 두 행」 부류로 넓혀 `2026.10.15.2` 로 — 옛 0.155.1 갈래는 그대로). 인용문과 live 다이얼로그를 가르는 것은 선택지 줄쌍과, 그 **뒤에** 오는 composer/footer **전체 행**을 잡는 `not` 게이트다 — 임의 위치의 부분 문자열이 아니다(cwd에 마커가 들어간 실제 chooser와, chooser 위에 남은 옛 footer 한 줄이 반례였다). corral은 이 버전을 기대값으로 들고 있고, guard가 그 provider의 활성 매니페스트를 기대 버전·`bundled`·그림자 없음으로 답하지 않으면 **제출 자체를 하지 않는다**(`detect_manifest_unverified`). claude 매니페스트는 손대지 않지만 같은 게이트를 지난다 — 기대값은 스톡 bundled 버전 `2026.09.04.1`이다.
- guard 빌드가 실제로 무엇을 활성 매니페스트로 보는지는 `corral terminal show --terminal HANDLE --json`의 `agent.evidence.detectManifest`, 또는 guard 봉투로 직접 부른 `server.agent_manifests`로 확인한다.
- GUI focus는 renderer의 worktree/tab 준비 및 실제 선택된 pane의 DOM 키보드 focus와 main의 선택이 일치한다는 ACK 뒤 성공한다. wait의 ready는 transport, send의 성공은 backend 수락이다. 프로그램 소비·agent ready·작업 완료는 별도 계약이다.

`node app/scripts/l393/negative.mjs`는 timeout 전파를 검증하기 위해 **의도적으로 exit 1** 한다. 성공으로 감추면 안 된다.
