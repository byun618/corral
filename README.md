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

## 설치·빌드

- 빌드와 설치 절차: [`app/INSTALL.md`](app/INSTALL.md) — 동봉 herdr 빌드 → `npm run package:mac` → dmg 설치 → CLI 를 PATH 에 연결.
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
