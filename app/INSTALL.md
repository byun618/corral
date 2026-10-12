# corral 설치본 (로컬 빌드, LIFE-555 · LIFE-556)

arm64 macOS 전용. 서명은 ad-hoc 이고 자동 업데이트·brew cask·릴리스 채널은 없다(LIFE-446 T3·T4 취소, 2026-10-08) — 다른 Mac 에는 dmg 를 건네 설치한다.
받은 Mac 에서 첫 실행이 막히면 **시스템 설정 ▸ 개인정보 보호 및 보안** 에서 「그래도 열기」를 한 번 누른다.
**herdr 를 따로 설치할 필요가 없다** — 앱 안에 corral 전용 herdr(release 패치 빌드)가 들어 있다(LIFE-556).

## 출고 (LIFE-574 · APK LIFE-599)

**main = 출고된 상태 = 설치본.** 설치본 버전 = 태그 `vX.Y.Z` = `app/package.json` 버전이다(`corral --version` 으로 태그를 특정한다).
모바일도 같다 — 폰 APK 의 versionName = 태그 버전(`mobile/app.config.ts` 가 `app/package.json` 을 읽는다).
**작업 브랜치에서 만든 dmg·APK 는 머지 전 확인용 dev 빌드이고, 정식본은 dmg·APK 모두 출고 태그에서 만든다** — 작업 관문에서 폰에 깐 브랜치 APK 는 출고 때 태그 APK 로 덮인다.
출고 대기열은 열린 PR 이고(게이트 ② 출고 승인 = PR 생성, `scripts/task-pr.sh`), 출고는 사용자가 끊는다 — "PR 이거이거 머지하고 빌드하자".
본체 세션이 본체 checkout 에서 `release` 스킬(`.agents/skills/release/SKILL.md`)대로 실행한다 — 릴리즈 노트 작성이 그 스킬 몫이다.

```sh
gh pr list                                                  # 출고 대기열
scripts/release.sh --prs "12 15" --dry-run                  # 사전 점검만 — 대상 PR·순서·head·다음 버전·태그·dmg·APK 계획 출력, 머지·push 0건
scripts/release.sh --prs "12 15" --notes <릴리즈 노트 파일>  # 고른 순서대로. --bump minor|major 또는 --version X.Y.Z (기본 patch)
```

`release.sh` 가 하는 일 — **검사 없이 순서 머지다.** PR CI 는 아직 없다(후속 일감 LIFE-575, 맥미니 self-hosted 러너) — 검증 근거는 각 PR 의 판정문(리뷰·관문)이다.
⓪ 머지 전에 고른 PR 전부를 보고(중복 번호는 한 번만) 닫힘·draft·포크·base 불일치가 하나라도 있으면 아무것도 머지하지 않는다(exit 2).
이때 각 PR 의 head SHA 를 고정하고, dmg 를 만들 거면 node 를 본다(v24 기준, v22 는 경고, 그 밖은 거절). APK 를 만들 거면 그 전제도 본다 —
JDK 17 이상(`JAVA_HOME` 의 java, 없으면 PATH 의 `java -version` — `/usr/libexec/java_home` 은 sdkman JDK 를 못 찾아 보지 않는다) · `ANDROID_HOME` 의 build-tools(apksigner·aapt2) ·
`eas whoami` 로그인 · 작업 폴더 자리(아래). 하나라도 빠지면 머지 0건으로 거절한다(exit 2 — `--skip-apk` 로 APK 를 빼고 출고할 수는 있다) ① PR 마다 GitHub 머지 가능 판정을 보고,
앞 PR 머지로 충돌이 생겼으면 그 자리에서 멈춘다 — 그 PR 과 뒤 PR 은 머지하지 않는다(exit 3). 그 작업 브랜치에 main 을 **merge**(rebase 아님)해 풀고 push 한 뒤
남은 PR 로 다시(아래 「충돌이 나면」) ② `gh pr merge --merge --match-head-commit <⓪ 에서 고정한 SHA>` — 그 뒤 head 가 바뀌면 GitHub 가 거절한다(exit 6) ③ 머지 커밋 부모 2개 확인,
원격 작업 브랜치 삭제. 다 머지하면 ④ 버전 올림 커밋 `release: vX.Y.Z` + 주석 태그를 main 에 push 하고 `--notes` 로 GitHub Release 를 만든다(실패 exit 9 —
메시지의 `gh release create` 만 다시) ⑤ 그 태그 위 깨끗한 임시 worktree(`.claude/worktrees/_release-*`)에서
`scripts/release-dmg.sh` 로 아래 「빌드」를 돌려 dmg 를 `app/dist/release/vX.Y.Z/` 에 둔다(`--skip-build` 면 생략) ⑥ 같은 worktree 에서
`scripts/release-apk.sh` 로 모바일 APK(`preview` 프로필 로컬 빌드 — EAS 쿼터 소모 없음, 서명 = EAS 원격 자격증명)를 만들어 `app/dist/release/vX.Y.Z/corral-mobile-X.Y.Z.apk` 에 둔다
(**매 출고 기본**, `--skip-apk` 면 생략). `--skip-build` 는 dmg 만, `--skip-apk` 는 APK 만 뺀다 — 둘 다 빼려면 둘 다 준다.
이미 머지된 PR 은 건너뛰므로 중간에 멈추면 같은 명령을 다시 돌린다. 버전 커밋·태그 push 가 실패하면(exit 7 — main 이 그새 움직임 등) 로컬 태그를 지우고 멈추므로
같은 명령 재실행이 버전 커밋·태그만 다시 만든다. dmg 가 실패하면(exit 8) 머지·태그는 끝난 상태다 — 메시지가 알려 주는 `release-dmg.sh` 명령으로 dmg 만 다시 만들고,
APK 는 아직이므로 메시지의 「APK 는 아직이다 — dmg 뒤 APK」 명령도 돌린다. APK 가 실패하면(**exit 10**) 머지·태그·dmg 는 끝난 상태다 — 메시지의 「APK 만 다시」 아래 줄을 그대로 붙여 넣는다.
안내의 명령은 설명과 다른 줄에 홀로 있고 경로가 단일 따옴표로 인용돼 있어(한글·공백 경로도 화면 그대로 복사해 돈다) 어느 cwd 에서도 돈다.
exit 9(GitHub Release 실패) 안내도 같은 모양으로 노트·dmg·APK 명령을 낸다 — 노트 명령도 `(cd <레포> && gh release create …)` 라 어느 cwd 에서나 돈다.
「출고할 것 없음」은 base 끝 `release: <태그>` 제목의 태그가 이번 접두이고 원격 태그가 base 끝과 같은 커밋일 때만 dmg·APK 명령을 낸다 —
아니거나 확인할 수 없으면 태그를 고르지 않고, `git ls-remote --tags origin` 으로 직접 확인한 태그를 `TAG='…'` 에 넣어 치는 명령만 보인다:
```sh
<본체>/scripts/release-apk.sh --from-tag vX.Y.Z --tag-prefix v --out <본체>/app/dist/release/vX.Y.Z
```
`--from-tag` 는 원격에서 그 태그를 정확히 fetch 하고(로컬 태그가 없어도 된다) 매번 새 임시 worktree(`.claude/worktrees/_apk-<태그>-<시각>-<pid>`)에서 빌드한 뒤 그 worktree 만 지운다(다른 worktree 등록은 건드리지 않고, 못 지우면 남은 경로를 알린다) —
앞선 시도가 남긴 worktree 와 겹치지 않는다. 산출물 자리에 이미 APK 가 있으면 지우지 않고 그 아래 `retry-<시각>/` 에 새로 만든다. 같은 명령을 몇 번 다시 돌려도 된다.

**충돌이 나면 (exit 3)** — 앞 PR 이 머지돼 뒤 PR 이 main 과 충돌한다. 작업 worktree 는 PR 을 연 뒤 정리됐으므로(D4) 본체 세션이 다시 만들어 푼다.
```sh
git fetch origin
git worktree add .claude/worktrees/LIFE-NNN-<슬러그> -B LIFE-NNN-<슬러그> origin/LIFE-NNN-<슬러그>   # 원격 작업 브랜치로 다시 만든다
cd .claude/worktrees/LIFE-NNN-<슬러그> && git merge origin/main                                    # rebase 금지 — 리뷰 근거 커밋 보존
# 충돌을 풀고 커밋 → 확인이 필요하면 app/ 에서 npm run typecheck·npm test
git push origin LIFE-NNN-<슬러그>                                                                    # PR head 갱신(fast-forward)
cd - && scripts/release.sh --prs "<멈춘 PR> <뒤 PR …>" --notes <파일>                                # 이미 머지된 PR 은 넣어도 건너뛴다
scripts/task-finish.sh LIFE-NNN-<슬러그>                                                             # 다시 만든 worktree 정리
```
이미 일부 머지된 상태에서 재실행해도 안전하다 — 머지된 PR 은 건너뛰고, 버전 커밋·태그는 아직 만들지 않았다(멈춘 PR 에서 끝났으므로). 해소가 기능을 바꿀 만큼 크면
그 PR 을 이번 출고에서 빼고(`--prs` 에서 제외) 나머지만 출고한 뒤 그 작업의 코디에게 돌려보낸다. LA 는 `검증 중` 그대로다.

끝나면 본체 세션이: 머지된 PR 의 일감마다 LA `완료` 전이(출고 머지 뒤 — D2, 설치를 기다리지 않는다) → dmg 를 아래 「설치」대로 설치 →
`corral --version` 이 새 버전인지 확인 → 폰에 APK 를 덮어 설치(아래 「폰 APK 설치」) → 남은 로컬 정리가 있으면 `scripts/task-finish.sh <LIFE-NNN-슬러그>`.

**폰 APK 설치** — `scripts/release-apk-install.sh --serial <폰 시리얼> --apk app/dist/release/vX.Y.Z/corral-mobile-X.Y.Z.apk`.
① 시리얼이 필수다(기본값 없음 — 폰·에뮬레이터가 같이 붙어 있어도 엉뚱한 기기에 깔지 않는다. 시리얼은 `adb devices -l`)
② 설치 **전에** 기기 설치본(`pm path` → `adb pull`)과 새 APK 를 `apksigner verify` 로 확인해 양쪽 모두 서명자 정확히 1개이고 SHA-256 이 같을 때만 넘어간다 — **다르거나 복수 서명·verify 실패면 설치하지 않고 멈춘다**
③ 같을 때만 `adb install -r`(데이터·페어링 유지) ④ `dumpsys` 로 versionName·`lastUpdateTime` 이 바뀌었는지 보고 APK sha256 을 출력한다 — 출고 보고에 넣는다.
설치본을 지우고 새로 까는 길은 없다 — 지우면 페어링 토큰·기록이 사라진다. 서명이 다르거나 설치본이 없으면(첫 설치) 멈추고 사용자에게 보고한다(첫 설치는 `mobile/README.md` §3).

- **머지는 `release.sh` 로만 한다.** 브랜치 보호(required check)는 Free 플랜 private 레포에서 쓸 수 없어(403) 서버가 막지 않는다 —
  웹 UI 머지·main 직접 push 를 하지 않는 것은 규약이다. squash·rebase 머지는 레포 설정에서 꺼 두었다(merge commit 만).
- 태그 밖에서 dmg 를 만들어야 하면(개발 빌드) 「빌드」를 손으로 돌린다 — 그 dmg 는 출고본이 아니다. 출고 dmg 는 `release-dmg.sh` 가 HEAD = 태그·깨끗한 트리·
  태그 버전 = package.json 버전을 확인할 때만 만든다(`--check-only` 로 가드만 본다).
- 리허설: `--base throwaway/<이름> --tag-prefix rehearsal-<이름>-v` 로 main·`v*` 태그를 건드리지 않고 돌린다. **둘은 짝으로만 받는다** — 한쪽만 주면
  push 전에 거절한다(실 출고는 둘 다 기본값 `main`·`v`).
- `release-dmg.sh` 는 태그가 원격(origin)에도 같은 커밋으로 있을 때만 빌드한다. `release-apk.sh` 도 같은 가드(깨끗한 트리 · HEAD = 태그 · 태그 버전 = `app/package.json` ·
  원격 태그 같은 커밋)를 `npm ci`·`eas` 보다 먼저 보고, 빌드 뒤 APK 의 패키지·versionName(= 태그 버전)·서명(EAS 원격 자격증명 `483a15fa…1a617a`)을 확인한다. `--check-only` 는 가드·전제만,
  `--preflight` 는 전제만 본다(`release.sh` 가 머지 전에 부른다).
- APK 작업 폴더는 **셸 TMPDIR 에 맡기지 않는다** — macOS `/tmp`(→ `/private/tmp` 심링크) 아래에서 CMake·ninja 가 경로를 섞어 실패한 적이 있다(LIFE-594, reanimated #9151).
  `release-apk.sh` 는 사용자 임시 폴더(`getconf DARWIN_USER_TEMP_DIR`, 바꾸려면 `CORRAL_APK_WORK_BASE`)에 실경로 작업 폴더를 만들어 `EAS_LOCAL_BUILD_WORKINGDIR`·`TMPDIR` 로 준다 —
  셸이 vitest 관행대로 `TMPDIR=/tmp/…` 를 물려줘도 빌드는 그것을 쓰지 않는다. 자리가 없거나 쓸 수 없거나 경로에 공백이 있으면 빌드 전에 거절한다. 작업 폴더(`corral-apk-XXXXXX`)를 만들지 못하면 `npm ci`·`eas` 전에 멈춘다.
  EAS 의 작업 폴더 자동 정리는 끄고(`EAS_LOCAL_BUILD_SKIP_CLEANUP=1`) 성공했을 때만 이번에 만든 그 폴더를 지운다 — 빌드·확인이 실패하면 작업 폴더를 남기고 경로를 알려 준다.
- `JAVA_HOME`·`ANDROID_HOME`·`CORRAL_APK_WORK_BASE` 는 절대경로여야 한다 — 상대경로면 사전 점검에서 거절한다(머지 전 exit 2). 사전 점검(본체 cwd)과 태그 worktree 빌드가 같은 곳을 봐야 해서다.
- 서명 확인은 `apksigner verify` 성공 + 서명자 정확히 1개 + SHA-256 일치일 때만 통과한다(출고 정책 = EAS 단일 키) — 빌드 뒤 확인과 폰 설치 전 대조 모두 같다.
- PR CI 는 아직 없다 — 후속 일감 LIFE-575. 574 구현 r0 의 ubuntu workflow 초안은 구현 브랜치 커밋 `ffb08b9` 에 남아 있다(계정 결제 잠금으로 한 번도 돌지 못했다).
- 574 출고 전후 과도기(565·566·564 와 첫 출고 순서)는 `specs/LIFE-574-pr-release/transition.md`.

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
  `LICENSE-herdr`·`NOTICE-herdr.md` 에 있다. 의존 crate 고지는 공개 배포를 다시 열 때 다룬다(LIFE-446 T3 취소).

## 지우기

메뉴 **Uninstall 'corral' Command…** 로 심링크를 지운 뒤 앱을 지운다. 동봉 herdr 서버가 남아 있으면 앱을 지우기 전에 끈다.

```sh
/Applications/corral.app/Contents/Resources/backend/herdr server stop   # 동봉 서버 (pane 프로세스가 끝난다)
rm -rf /Applications/corral.app
```

userData(`~/Library/Application Support/corral`)와 동봉 herdr 폴더(`~/.config/corral-herdr`·`~/.local/state/corral-herdr`), herdr 로 만든 worktree(`~/.corral-herdr/worktrees` — 사용자 작업 트리)는 남는다.
