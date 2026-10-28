# corral — 공통 지침

herdr 기반 AI 워크스페이스 (LIFE-337). 세션·일감을 한 울타리에 모으는 미션 컨트롤.
herdr = 바닥 레이어(PTY·영속·에이전트 상태·worktree), 그 위 Electron + React GUI.

프로젝트 방향·체크포인트는 corral-specs/00-project.md 를 읽는다.

## 산출물 규칙

- **작업 산출물은 별도 private 레포 corral-specs 에 둔다** — 본체 checkout 옆 폴더(`<본체>/../corral-specs`.
  이하 `corral-specs/`). 브랜치는 main 하나, worktree 를 만들지 않는다. 이 코드 레포에는
  공개해도 되는 것만 둔다 — 원자료·작업 문서를 커밋하지 않는다 (LIFE-705, 2026-10-26 분리)
- 작업 하나 = corral-specs/LIFE-NNN-<슬러그>/ 폴더. 단계 산출물은 번호 파일 (00-analysis.md, 01-criteria.md, …)
- **쓰기와 커밋** — 본체·코디·워커·리뷰어 모두 그 폴더에 **절대경로로 직접** 쓴다(worktree 안 상대경로 금지).
  커밋은 그 일감의 코디(00-start 는 시작한 세션 — 본체, 묶음 자식은 묶음 코디)만, 게이트 시점에(묶음 코디는 분해·알림·출고 중 수정 기록 때도 — task-coordinate references/bundle.md 2·4·6), **자기 폴더만** 한다:
  `git -C <corral-specs> add -- LIFE-NNN-<슬러그>/ && git -C <corral-specs> commit -m "…" -- LIFE-NNN-<슬러그>/ && git -C <corral-specs> push`.
  여러 일감이 한 working copy 를 같이 쓰므로 남의 폴더를 add 하지 않고, `index.lock` 이면 잠시 뒤 다시 한다. 워커·리뷰어는 커밋하지 않는다.
  루트 공용 파일(00-project.md·app-screens.md·design-tokens*.css·reference/ 등)은 바꾼 세션(본체 또는 그 일감의 코디)이 그 파일만 지정해 커밋한다
- corral-specs 파일이 진실의 원천. 세션 간 조율은 파일로 한다 — 세션 컨텍스트는 휘발됨
- **아티팩트(계획 문서·목업 설명)는 진실의 원천이 아니다.** 일감의 근거는 corral-specs 에서만 끌어온다 —
  아티팩트가 스파이크 판정과 어긋난 채 계획 근거로 쓰이고 있던 전례가 있다 (LIFE-344 → 00-project.md 정정)
- 완료 조건·판정표 형식·**네이티브 실행 관문**(워커·리뷰어 공통)의 원본은 .agents/rules/validation.md —
  완료 선언 전에 확인한다

## 작업 플로우 (분석 → 단독 구현 → 리뷰 → 판정 → PR → 출고)

여기는 지도다 — **규칙 본문은 그 규칙을 실행하는 스킬에 두고 여기에 다시 적지 않는다.**
스킬은 **능력 이름**으로만 말하고 명령은 .agents/harness/ 의 도구별 매핑에 있다 —
어느 매핑을 열지는 .agents/harness/capabilities.md 의 「매핑 선택」 한 곳에서 정한다.

| 단계 | 누가 | 산출물 (corral-specs/LIFE-NNN-<슬러그>/) | 절차 |
| --- | --- | --- | --- |
| 0 시작 — 작업 브랜치·worktree·코디 기동(체크포인트는 작업 브랜치 대신 feature) | 본체 (묶음 자식은 묶음 코디) | 00-start.md | task-start |
| 1 분석 — 일감 스냅샷·외부 서치 대조 | 코디 | 00-analysis.md | task-coordinate §1 |
| 2 판정 기준 — 구현 전에 박는다 | 코디 | 01-criteria.md | §2 |
| 3 킥오프 → **게이트 ⓪** | 코디 | 02-kickoff.md | §3 |
| 4 구현 — 단독 워커, 설계 단계 없음(경쟁은 옵션) | 워커 | 구현 브랜치 LIFE-NNN-<슬러그>-claude | §4 |
| 5 코드 리뷰 — 별도 세션, 재리뷰도 새 세션 | 리뷰어 | raw/review/, reviews.md | §5 |
| 6 판정 → **게이트 ①** | 코디 | verdict.md | §6·§7 |
| 7 사용자 확인 → **게이트 ②** = 기록·PR 생성·정리 | 코디 | devlog.md, learnings-proposal.md, adr-draft-*.md, handoff-main.md, pr.md(묶음 자식은 없음) | §8 |
| 8 출고 — release/vX.Y.Z 자르기·PR 모으기·통합 확인·회고 → main 머지·태그·릴리즈 노트·dmg·APK(폰 설치) | 본체 | GitHub Release, corral-specs/retro/vX.Y.Z.md | release |

- 스킬 파일: .agents/skills/task-start · task-coordinate · release (각 SKILL.md). 역할별 모델·effort·리뷰어 구성은 .agents/defaults.md
- 판정 규칙(다수결 기각 금지·수렴 조건·수정 상한·테스트 계층·경량/전체 경로)은 task-coordinate §2·§3·§5·§6
- **사용자 승인 게이트 3단 (자율 진행 금지 지점)**: ⓪ 킥오프(구현 워커 기동 전) ① 채택(작업 브랜치 머지 전)
  ② 출고(PR 생성 전). 게이트 사이는 자율 진행하되 게이트에서 멈추고 보고한다 — 보고할 내용은 task-coordinate 의 각 게이트 절. 묶음 코디의 게이트(분해 승인 ⓪·출고 승인)는 task-coordinate references/bundle.md 2·6.
  worktree 는 출고 승인 전까지 유지 — 사용자가 직접 실행·확인할 수 있는 상태. feature worktree 는 release 머지(출고)까지(task-coordinate references/bundle.md)
- 작업이 끝나거나 막히면 반드시 사용자에게 보고 — 조용한 완료 금지
- LA 상태는 코디(진행)·본체(출고)가 forward-only 로 전이한다 — 시점은 각 스킬의 해당 절 첫 줄

## 브랜치 규약

- 작업 브랜치 LIFE-NNN-<슬러그> 는 main(독립 작업) 또는 feature 브랜치(묶음 자식)에서 분기, 작업 하나의 수명만 갖는다 —
  PR 을 열면 로컬은 정리하고 원격만 남긴다. 출고 머지(또는 feature 로 merge) 후 원격도 삭제 (단명 원칙 유지)
- **main 반영은 PR 머지로만** — 출고 때 scripts/release.sh 가 고른 PR 을 release 브랜치에 순서대로 모으고(검사 없이 순서 merge, 충돌이면 멈춤)
  release → main PR 하나를 merge commit 으로 머지한다 — 원래 PR 은 기본 브랜치에서 간접 머지로 MERGED 를 가정하고 확인 안 되면 exit 13(C14 실측 전, squash·rebase 머지는 레포 설정으로 꺼 둠).
  PR CI 는 아직 없다 — 후속 LIFE-575. main 직접 push·웹 UI 머지 금지 — main 에 직접 올라가는 것은 release.sh 의 태그뿐이다.
  공개 레포 ruleset 「main 보호」가 서버에서 막는다 — main 삭제·force push 금지, PR 필수(승인 0·merge commit 만), 우회 없음(LIFE-718). required check 는 PR CI 전이라 없다
- **묶음 브랜치 feature/LIFE-NNN-<슬러그>** (NNN = 체크포인트): 서로 의존하는 작업 묶음만(체크포인트 시작 — task-coordinate references/bundle.md 2). 자식 작업 브랜치는 feature 에서
  따고 feature 로 로컬 merge, 묶음이 끝나면 feature → main PR 하나. main 이 움직이면 main 을 feature 로 merge(rebase 금지 —
  살아 있는 worktree). 독립 작업은 main 에서 따고 main 대상 PR. 그 외 체크포인트·프로젝트 단위 통합 브랜치는 금지
- 슬러그는 일감 타이틀에서 자동 파생(케밥케이스 1~3단어), 생성 후 불변 (매핑은 키로만)
- worktree 는 전부 .claude/worktrees/ 아래 형제 폴더 — 중첩 금지. 구현 브랜치 생존 중 작업 브랜치 rebase 금지
- **release 브랜치 release/vX.Y.Z** (예외, 단명 원칙 안): 출고 1회 수명·한 번에 하나. main 에서 자르고(.claude/worktrees/release-vX.Y.Z)
  PR 을 모아 통합 확인 뒤 main 머지, 출고 확인 뒤 삭제(접으면 삭제·PR 은 열린 채). 자른 뒤엔 출고를 막는 수정만 — 수정은 일감 브랜치에서 고쳐 다시 모은다(예외는 release 스킬 §1)
- 출고 통합 확인은 release worktree 에서 한다. 그 밖의 통합 확인은 throwaway: integration/<이름>-YYYYMMDD 에 합쳐 테스트 후 삭제. 유지 금지
- feature·예외적 장기 통합 브랜치는 만료일 명시(체크포인트 폴더 00-start.md), 넘기면 쪼개서 main 에

## 도구 역할

- 코디네이터·판정 = 작업마다 claude 또는 codex. 선택 규칙·기동·전제 점검은 task-start, **역할별 모델·effort·리뷰어 구성의
  원본은 .agents/defaults.md 한 곳이다.** 같은 도구여도 세션과 역할은 구분한다.
- claude (Claude Code) = 코디네이터·판정, 구현, 코드 리뷰. native advisor 상담
- codex = 경쟁 구현(Codex 측) / 별도 코드 리뷰 ① — 지정 모델·쓸 수 없을 때의 전환은 .agents/defaults.md 「Codex 사용 불가 시 자동 전환」
- grok = 외부 서치·사실 검증 + 보완 코드 리뷰 (느림 수 분, 무료 쿼터 주의 — 검색 1회 소진 가능)
- **effort·모델은 세션 기동 시 반드시 명시한다.** 환경 기본이 medium 이라 플래그가 없으면
  조용히 내려간다. 기동 후 세션 중간에 바꾸지 않는다 — 프롬프트 캐시가 깨져 그 턴의 입력
  비용이 수십 배로 뛴다 (Fable 5.1 은 10만 토큰 접두사에서 약 50배)
- **advisor 는 Claude 내장 상담 도구다. 독립 리뷰를 대신하지 않는다** — 현재 기본 해제(.agents/defaults.md)
- **제어 도구(pane·배달·완료 감지)는 절차와 분리한다.** 절차는 능력 이름으로 쓰고 명령은 매핑에 둔다 —
  목표는 "어디서나 같은 보장" 이 아니라 **"어디서나 돌고, 못 하는 것은 판정표에서 공백"** 이다
  (.agents/harness/capabilities.md)

## 세션 간 통신

- 영속 산출물: corral-specs 파일 (진실의 원천)
- 제어 채널: 『감독 워커 기동』·『완료 감지』·『질의응답』. 완료는 워커의 종료 보고로만 본다 (파일·화면·프로세스 종료가 아니다).
  명령과 보장 수준은 선택한 매핑(.agents/harness/<도구>.md) — 능력이 공백인 도구에서는 그 판정 칸이 공백이다. 절차는 task-coordinate §4
- 보조: Claude 세션 간 SendMessage (claude↔claude 한정)

## 어디를 고치나 (증상 → 파일)

| 증상 | 고치는 파일 |
| --- | --- |
| 프로젝트가 뭔지 매번 설명하게 된다 | AGENTS.md · corral-specs/00-project.md |
| 문체·용어·문서 형식이 매번 다르다 | .agents/rules/writing.md |
| 코드 스타일·파일 이름이 제각각이다 | .agents/rules/coding.md |
| "다 됐습니다"인데 안 되어 있다 | .agents/rules/validation.md |
| 리뷰 품질·형식이 도구마다 흔들린다 | .agents/agents/reviewer.md |
| 도구가 바뀌면 절차 문서를 다시 쓰게 된다 | .agents/harness/capabilities.md (능력 이름·보장 어휘) |
| 명령·플래그가 실제와 다르거나 빠져 있다 | .agents/harness/<도구>.md (corral·orca·bare 매핑) |
| 같은 다단계 절차를 매번 다시 설명한다 | .agents/skills/<이름>/SKILL.md 신설 |
| 무엇을 만들어야 하는지가 흔들린다 | 해당 작업의 01-criteria.md |
| 같은 배움을 일감마다 다시 겪는다 | .agents/learnings/<영역>.md (형식·승격은 그 폴더 README) |
| 왜 그렇게 정했는지 매번 다시 묻는다 | docs/adr/ (번호·상태는 그 폴더 README) |

## 원본 관리

- 규칙·에이전트·스킬 원본은 .agents/ 에만 둔다. .claude/ 의 rules·skills·agents 는 심링크 — 원본 저장 금지
- .agents/agents/ 의 역할 파일은 각 터미널 세션이 시작 시 읽는 지침서다 (서브에이전트 아님)
- grok 은 AGENTS.md 와 .claude/rules/ 를 자동 로드한다 — .grok/ 폴더 불필요. codex 는 AGENTS.md 만 읽는다 — rules 는 .codex/agents 포인터 경유
- .agents/agents/ 를 고치면 .codex/agents/*.toml 포인터가 깨지지 않았는지 확인
- rules 스텁(writing.md·coding.md)은 같은 실수 두 번째에 한 줄씩 — 첫 번째는 .agents/learnings/ 에. 글로벌 스타일과 중복 금지
- 스킬의 로컬 상태(config.json, state/)는 .gitignore — config.example.json 만 커밋
- 시크릿 점검: corral·corral-specs 둘 다 gitleaks pre-commit 훅(`.githooks/`). 클론마다 한 번 `git config core.hooksPath .githooks`
- **이 파일은 매 세션·매 호출에 실린다** — 매 세션 필요한 사실만 두고, 다단계 절차·한 역할만 쓰는 규칙은 스킬로 뺀다.
  200줄을 넘으면 이미 너무 길다
