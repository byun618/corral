# corral — 이 프로젝트의 규칙

paddock 고정 문서에 없는 이 프로젝트 규칙. 옛 AGENTS.md·validation.md 에서 원문 그대로 옮겼다(2026-11-24 adopt).
**코디는 분석 전에 `.agents/corral-coordinate.md` 를 읽는다**(코디만 쓰는 규칙). corral 도구 동작·설치본 관문은 `.agents/harness/corral-notes.md`.

## 검증

- **레이아웃을 옮기는 변경의 GUI 관문은 통과 회차도 캡처를 눈으로 본다** — 찾은 결함은 판정 항목으로 올리고 그 회차를 실패로 남긴다. 캡처가 없는 관문(창 없는 serve·CLI·문서 일감)과 화면을 바꾸지 않는 변경은 대상이 아니다. (LIFE-682·811)
- **사람 손·눈 확인 회차는 읽기 전용 기록기와 대조한 뒤 센다** — 맡기기 전에 화면 상태(탭·포커스·대상 행·기록 파일 시각)를 읽기만 하는 기록기를 켜 두고, 보고가 기록과 어긋나면 그 회차를 무효로 적고 다시 받는다. 기록기를 못 켜는 도구는 시각을 박아 묻고, 체감만 보는 칸(타이핑 끊김 등)은 기록을 보조로만 쓴다. (LIFE-781·808)
- **프로세스를 끝내거나 살았는지 판정할 때 명령줄 패턴(`pgrep -f`·`pkill`)을 쓰지 않는다** — 띄울 때 받은 PID 로 하고 그 PID 가 정말 대상인지 확인한다(zsh 에서 함수를 `&` 로 띄우면 `$!` 는 서브셸이다). 내가 띄우지 않은 프로세스는 정확한 패턴(끝 고정·인자 허용)으로 PID 를 한 번 얻고 그 뒤엔 PID 로 본다. 이름으로 잔존을 훑는 것은 PID 확인의 보조로만 쓴다. (LIFE-575·813)

## 브랜치·출고

- **main 반영은 PR 머지로만** — 출고 때 scripts/release.sh 가 고른 PR 을 release 브랜치에 순서대로 모으고(검사 없이 순서 merge, 충돌이면 멈춤)
  release → main PR 하나를 merge commit 으로 머지한다 — 원래 PR 은 기본 브랜치에서 간접 머지로 MERGED 를 가정하고 확인 안 되면 exit 13(C14 실측 전, squash·rebase 머지는 레포 설정으로 꺼 둠).
  PR CI(.github/workflows/pr-ci.yml — 맥미니 self-hosted 러너, LIFE-575)는 참고 신호다 — release.sh 는 보지 않고, release→main PR 의 CI 는 머지 뒤에 와서 통합 확인을 대신하지 않는다. main 직접 push·웹 UI 머지 금지 — main 에 직접 올라가는 것은 release.sh 의 태그뿐이다.
  ruleset 「main 보호」(main 삭제·force push 금지, PR 필수(승인 0·merge commit 만), 우회 없음 — LIFE-718)는 레포가 private 인 동안 서버에서 효력이 없다(공개 뒤 효력 — LIFE-729). 그때까지는 규약이다. required check 도 private 동안 걸 수 없어 없다
- **release 브랜치 release/vX.Y.Z** (예외, 단명 원칙 안): 출고 1회 수명·한 번에 하나. main 에서 자르고(.claude/worktrees/release-vX.Y.Z)
  PR 을 모아 통합 확인 뒤 main 머지, 출고 확인 뒤 삭제(접으면 삭제·PR 은 열린 채). 자른 뒤엔 출고를 막는 수정만 — 수정은 일감 브랜치에서 고쳐 다시 모은다(예외는 release 스킬 §1)
- 출고 통합 확인은 release worktree 에서 한다. 그 밖의 통합 확인은 throwaway: integration/<이름>-YYYYMMDD 에 합쳐 테스트 후 삭제. 유지 금지

## 산출물·세션

- corral-specs 루트 공용 파일(00-project.md·app-screens.md·design-tokens*.css·reference/ 등)은 바꾼 세션(본체 또는 그 일감의 코디)이 그 파일만 지정해 커밋한다
- 보조: Claude 세션 간 SendMessage (claude↔claude 한정)
- grok 은 AGENTS.md 와 .claude/rules/ 를 자동 로드한다 — .grok/ 폴더 불필요. codex 는 AGENTS.md 만 읽는다 — rules 는 .codex/agents 포인터 경유
