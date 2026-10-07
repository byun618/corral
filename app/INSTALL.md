# corral 설치본 (로컬 빌드, LIFE-555)

arm64 macOS 전용. 서명은 ad-hoc(T4 전 재결정)이고 자동 업데이트·brew cask 는 아직 없다.

## 빌드

```sh
cd app
npm ci
npm run package:mac      # typecheck → electron-vite build → CLI 번들 → electron-builder
```

산출물은 `app/dist/`(git 무시)에 나온다 — `corral-<version>-arm64.dmg`·`corral-<version>-arm64-mac.zip`, 풀린 번들은 `dist/mac-arm64/corral.app`.
bundle id `io.github.byun618.corral`, 앱·실행 파일 이름 `corral`.

## 설치

1. dmg 를 열고 `corral.app` 을 `/Applications` 로 끌어 놓는다.
2. CLI 를 PATH 에 건다 (한 줄):

   ```sh
   mkdir -p ~/.local/bin && ln -sf /Applications/corral.app/Contents/Resources/bin/corral ~/.local/bin/corral
   ```

   `~/.local/bin` 이 PATH 에 있어야 한다. CLI 는 앱 내장 Node 로 돌아서 셸의 node 버전·유무와 무관하다.
3. 확인: `command -v corral` 이 `~/.local/bin/corral` 이고 `corral --version` 이 앱 버전과 같다.

**주의 — `npm link` 된 레포 CLI 가 가릴 수 있다.** 레포 `app/` 을 `npm link` 해 둔 node 버전(예: nvm node v22)의 bin 이
PATH 에서 `~/.local/bin` 보다 앞이면, 그 node 를 쓰는 셸에서는 `corral` 이 레포 CLI 로 해소된다(00-analysis G2).
`command -v corral` 로 어느 쪽이 잡히는지 확인하고, 설치본을 쓰려면 `npm unlink -g corral` 하거나 PATH 순서를 바꾼다.

## 동작

- `corral open` — 설치본 CLI 는 같은 번들의 앱(`/Applications/corral.app/Contents/MacOS/corral`)을 띄운다. 레포·`node_modules` 를 보지 않는다.
  레포 빌드 CLI(`node app/cli/corral.mjs open`)는 종전대로 레포 Electron 을 띄운다.
- userData 는 기존 레포 실행과 같은 `~/Library/Application Support/corral` — 이주 없음.
- 에이전트 세션(Claude Code 등) 안에서 `corral open` 해도 세션 마커(`CLAUDECODE`·`CLAUDE_CODE_*` …)는 앱·herdr 서버로 넘어가지 않는다.
- herdr 는 앱에 들어 있지 않다 — `brew install herdr` 로 설치한 사용자 herdr `default` 세션에 붙는다.

## 지우기

```sh
rm ~/.local/bin/corral
rm -rf /Applications/corral.app
```

userData(`~/Library/Application Support/corral`)는 남는다.
