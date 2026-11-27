# corral

AI 코딩 에이전트(Claude Code·Codex·Grok) 세션과 일감을 한 화면에 모아 보는 macOS 데스크톱 워크스페이스.
A macOS desktop workspace that gathers AI coding agent sessions (Claude Code, Codex, Grok) and their tasks in one place.

## 무엇인가

- **바닥 레이어는 [herdr](https://github.com/herdrdev/herdr)** — 터미널(PTY) 소유·세션 영속·에이전트 상태 감지·git worktree 를 herdr 가 맡고, corral 은 그 위의 GUI(Electron + React)다.
- 여러 worktree 에 흩어진 에이전트 pane 을 한 창에서 보고, 어느 에이전트가 일하는 중·입력을 기다리는 중·끝났는지 상태로 구분한다.
- `corral` CLI 로 pane 을 만들고 에이전트에게 일을 맡기고 완료 보고를 받는다(조율 세션이 작업 세션을 감독하는 흐름).
- 같은 Tailscale 망의 Android 폰에서 세션 목록을 보고 에이전트 질문에 답하는 모바일 앱(`mobile/`)이 있다.

## 상태

개인 프로젝트이고 작성자 한 사람의 환경에 맞춰 만든다. 지원 범위는 **Apple Silicon(arm64) macOS** 뿐이고, 앱 서명은 ad-hoc 이며 자동 업데이트는 없다.
기능·저장 형식은 예고 없이 바뀔 수 있다.

## 받아서 쓰기

출고마다 [Releases](https://github.com/byun618/corral/releases) 에 dmg·Android APK 와 파일마다 체크섬 파일(`<파일>.sha256`)을 올린다.

1. 최신 Release 에서 `corral-X.Y.Z-arm64.dmg` 와 `corral-X.Y.Z-arm64.dmg.sha256` 을 같은 폴더에 받는다.
   `gh` 를 쓰면 `gh release download --repo byun618/corral --pattern 'corral-*-arm64.dmg*'`.
2. 받은 폴더에서 체크섬을 확인한다 — `OK` 가 나와야 한다:
   ```sh
   shasum -a 256 -c corral-*-arm64.dmg.sha256
   ```
3. dmg 를 열고 `corral.app` 을 `/Applications` 로 끌어 놓는다.
4. **브라우저로 받았다면 첫 실행을 macOS 가 막는다** — 앱이 ad-hoc 서명이고 공증을 받지 않아서다(「확인되지 않은 개발자」 류 경고).
   브라우저는 받은 파일에 다운로드 표시(quarantine)를 달고, macOS 는 그 표시가 있는 앱을 처음 열 때 검사한다.
   `gh release download` 로 받은 파일에는 이 표시가 붙지 않는다 — 그래도 막히면 아래대로 한다.
   macOS 15 이상은 Control-클릭 → 열기 우회가 없다. 한 번 열어 보고 막히면 **시스템 설정 → 개인정보 보호 및 보안** 맨 아래의
   **그래도 열기** 를 누른 뒤 다시 연다(차단 직후 한동안만 보인다).
   그 버튼이 없으면 터미널에서 다운로드 표시(quarantine)를 지운 뒤 연다:
   ```sh
   xattr -dr com.apple.quarantine /Applications/corral.app
   ```
5. 앱 메뉴 **corral ▸ Install 'corral' Command in PATH…** 로 `corral` CLI 를 연결한다(`~/.local/bin/corral` 심링크 하나 — 자세한 것은 [`app/INSTALL.md`](app/INSTALL.md) 「설치」).

- **herdr 는 앱에 들어 있다** — 따로 설치하지 않는다(동봉 herdr 의 빌드 입력은 [`app/backend/`](app/backend/)).
- 지원 범위: **Apple Silicon(arm64) macOS** 만 · 서명 ad-hoc · 공증 없음 · **자동 업데이트 없음** — 새 버전은 Releases 에서 다시 받아 덮어 설치한다.
- **Android APK**(`corral-mobile-X.Y.Z.apk`)는 같은 Tailscale 망에 있는 **자기 맥의 corral 과 짝지어 쓰는 앱**이다 — 맥 없이 혼자 도는 앱이 아니다.
  체크섬은 같은 방식(`shasum -a 256 -c corral-mobile-*.apk.sha256`), 준비물·첫 설치는 [`mobile/README.md`](mobile/README.md).

이 레포의 AI 작업 흐름(`AGENTS.md`·`.agents/`)은 [paddock](https://github.com/byun618/paddock) 으로 깐 것이다. 일감마다의 작업 산출물(분석·판정·원자료)은 별도의 비공개 레포에 두므로,
문서에 나오는 `corral-specs/` 경로는 이 레포에 없다.

## 설치·빌드

- 직접 빌드하려면 — 빌드와 설치 절차: [`app/INSTALL.md`](app/INSTALL.md) — 동봉 herdr 빌드 → `npm run package:mac` → dmg 설치 → CLI 를 PATH 에 연결.
- 모바일 앱: [`mobile/README.md`](mobile/README.md).
- 동봉 herdr 의 빌드 입력(상류 commit·패치): [`app/backend/`](app/backend/).

## 레포 구성

| 경로 | 내용 |
| --- | --- |
| `app/` | 데스크톱 앱(Electron main·renderer)·`corral` CLI·동봉 herdr 패치 |
| `mobile/` | Android 앱(Expo) |
| `scripts/` | 출고·PR 보조 스크립트 |
| `docs/adr/` | 설계 결정 기록 |
| `AGENTS.md`·`.agents/` | 이 레포에서 일하는 AI 에이전트용 작업 지침 |

코드·주석·문서는 대부분 한국어다. 커밋·주석의 `LIFE-NNN` 은 작성자의 개인 일감 번호다.

## 라이선스

[MIT](LICENSE).

앱에 동봉되는 herdr 는 Apache License 2.0 이다. 설치된 앱의 `corral.app/Contents/Resources/backend/` 에 상류 라이선스 원문(`LICENSE-herdr`)과 수정 사실 고지(`NOTICE-herdr.md`)가 들어 있고, 수정 내용은 [`app/backend/*.patch`](app/backend/) 다.

이슈·기여 안내는 [CONTRIBUTING.md](CONTRIBUTING.md).
