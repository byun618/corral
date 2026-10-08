# corral 설치본 (로컬 빌드, LIFE-555 · LIFE-556)

arm64 macOS 전용. 서명은 ad-hoc(T4 전 재결정)이고 자동 업데이트·brew cask 는 아직 없다.
**herdr 를 따로 설치할 필요가 없다** — 앱 안에 corral 전용 herdr(release 패치 빌드)가 들어 있다(LIFE-556).

## 빌드

```sh
cd app
npm ci
# 1) 동봉 herdr release 빌드 — 격리 build root 에 툴체인·소스·바이너리가 생긴다(레포·홈에 깔지 않는다)
export CORRAL_BACKEND_BUILD_ROOT="$(mktemp -d /tmp/corral-herdr-release-XXXXXX)"
CORRAL_BACKEND_PROFILE=release sh scripts/build-terminal-backend.sh
# 2) 앱 패키징 — typecheck → electron-vite build → CLI 번들 → 동봉 herdr 검증·배치(scripts/bundle-herdr.mjs) → electron-builder
npm run package:mac
```

`package:mac` 은 `CORRAL_BACKEND_BUILD_ROOT` 의 release 영수증이 지금 `backend/source.json`(패치 목록·sha256)과 맞지 않으면 멈춘다.

산출물은 `app/dist/`(git 무시)에 나온다 — `corral-<version>-arm64.dmg`·`corral-<version>-arm64-mac.zip`, 풀린 번들은 `dist/mac-arm64/corral.app`.
bundle id `io.github.byun618.corral`, 앱·실행 파일 이름 `corral`.

## 설치

1. dmg 를 열고 `corral.app` 을 `/Applications` 로 끌어 놓는다.
2. 앱을 열고 메뉴 **corral ▸ Install 'corral' Command in PATH…** 를 한 번 실행한다 — `~/.local/bin/corral` 에 앱 shim
   (`Contents/Resources/bin/corral`) 심링크 하나를 만든다. 손으로 `ln -s` 하지 않아도 된다.
   - 셸 설정 파일(`~/.zshrc` 등)은 고치지 않는다. `~/.local/bin` 이 로그인 셸 PATH 에 없으면 추가할 한 줄을 대화상자로 알려 준다.
   - 그 자리에 이미 다른 `corral`(다른 대상 심링크·일반 파일)이 있으면 지금 있는 것을 보여 주고 **확인해야만** 바꾼다.
   - PATH 앞쪽의 다른 `corral` 이 가리면 그 경로를 알려 준다.
   - 되돌리기: **corral ▸ Uninstall 'corral' Command…** — 이 앱을 가리키는 심링크일 때만 지운다.
   CLI 는 앱 내장 Node 로 돌아서 셸의 node 버전·유무와 무관하다.
3. 확인: **새 터미널**에서 `command -v corral` 이 `~/.local/bin/corral` 이고 `corral --version` 이 앱 버전과 같다.

**주의 — `npm link` 된 레포 CLI 가 가릴 수 있다.** 레포 `app/` 을 `npm link` 해 둔 node 버전(예: nvm node v22)의 bin 이
PATH 에서 `~/.local/bin` 보다 앞이면, 그 node 를 쓰는 셸에서는 `corral` 이 레포 CLI 로 해소된다(00-analysis G2).
`command -v corral` 로 어느 쪽이 잡히는지 확인하고, 설치본을 쓰려면 `npm unlink -g corral` 하거나 PATH 순서를 바꾼다.

## 동작

- `corral open` — 설치본 CLI 는 같은 번들의 앱(`/Applications/corral.app/Contents/MacOS/corral`)을 띄운다. 레포·`node_modules` 를 보지 않는다.
  레포 빌드 CLI(`node app/cli/corral.mjs open`)는 종전대로 레포 Electron 을 띄운다.
- userData 는 기존 레포 실행과 같은 `~/Library/Application Support/corral` — 이주 없음.
- 에이전트 세션(Claude Code 등) 안에서 `corral open` 해도 세션 마커(`CLAUDECODE`·`CLAUDE_CODE_*` …)는 앱·herdr 서버로 넘어가지 않는다.
- **herdr 는 앱에 들어 있다** (`Contents/Resources/backend/herdr`, LIFE-556). 앱이 그 바이너리로 herdr 서버를 스스로 띄우고 GUI 와 CLI 의
  `terminal`·`orchestration` 이 같은 서버(그 `default` 세션)를 쓴다 — `CORRAL_BACKEND_SOCKET`·`CORRAL_SESSION`·`profile.json` 을 손댈 필요가 없다.
  명시 바인딩(env·`profile.json` 의 `backend`)이 있으면 종전대로 그것이 먼저다.
  설치본은 그 `default` 세션 하나에 고정된다 — 동봉 herdr 에 다른 이름 세션이 돌고 있어도 GUI·CLI 는 그쪽으로 옮겨 가지 않는다.
  - 설정·상태·세션·소켓 폴더는 `~/.config/corral-herdr`·`~/.local/state/corral-herdr` 다 — 따로 설치한 herdr(`~/.config/herdr`)와 나뉜다.
  - herdr 가 만드는 git worktree 의 기본 위치는 `~/.corral-herdr/worktrees` 다 — 따로 설치한 herdr 의 `~/.herdr/worktrees` 와 나뉜다.
  - 동봉 herdr 는 PATH 에 `herdr` 로 올라가지 않고(shim 폴더 `bin/` 과 다른 `backend/` 에 있다), 스스로 업데이트하지 않는다(앱을 새로 설치해 올린다).
  - 앱을 닫아도 herdr 서버는 남는다(터미널 영속). 앱이 꺼진 상태에서 CLI `terminal`·`orchestration` 은 런타임이 없어 동작하지 않는다.
- **전환 안내 (brew herdr 를 쓰던 경우)**: 설치본은 따로 설치한 herdr 의 `default` 세션에 더 붙지 않는다 — 거기 열려 있던 터미널은
  넘어오지 않으니 한 번 다시 연다. brew herdr 는 corral 에 더 필요 없으므로 지워도 된다(`brew uninstall herdr`). 그 서버가 돌고 있으면 먼저 `herdr server stop`.
- **Apache-2.0 고지**: 동봉 herdr 의 라이선스 사본과 상류·수정 사실 고지는 `/Applications/corral.app/Contents/Resources/backend/` 의
  `LICENSE-herdr`·`NOTICE-herdr.md` 에 있다. 의존 crate 고지는 공개 배포(LIFE-446 T3)에서 다룬다.

## 지우기

메뉴 **Uninstall 'corral' Command…** 로 심링크를 지운 뒤 앱을 지운다. 동봉 herdr 서버가 남아 있으면 앱을 지우기 전에 끈다.

```sh
/Applications/corral.app/Contents/Resources/backend/herdr server stop   # 동봉 서버 (pane 프로세스가 끝난다)
rm -rf /Applications/corral.app
```

userData(`~/Library/Application Support/corral`)와 동봉 herdr 폴더(`~/.config/corral-herdr`·`~/.local/state/corral-herdr`), herdr 로 만든 worktree(`~/.corral-herdr/worktrees` — 사용자 작업 트리)는 남는다.
