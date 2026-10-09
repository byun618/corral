# corral — 공통 지침

herdr 기반 AI 워크스페이스 (LIFE-337). 세션·일감을 한 울타리에 모으는 미션 컨트롤.
herdr = 바닥 레이어(PTY·영속·에이전트 상태·worktree), 그 위 Electron + React GUI.

프로젝트 방향·체크포인트는 specs/00-project.md 를 읽는다.

## 산출물 규칙

- 작업 하나 = specs/LIFE-NNN-<슬러그>/ 폴더. 단계 산출물은 번호 파일 (00-analysis.md, 01-criteria.md, …)
- specs/ 파일이 진실의 원천. 세션 간 조율은 파일로 한다 — 세션 컨텍스트는 휘발됨
- **아티팩트(계획 문서·목업 설명)는 진실의 원천이 아니다.** 일감의 근거는 specs/ 에서만 끌어온다 —
  아티팩트가 스파이크 판정과 어긋난 채 계획 근거로 쓰이고 있던 전례가 있다 (LIFE-344 → 00-project.md 정정)
- 완료 선언 전에 .agents/rules/validation.md 의 완료 조건을 확인한다

## 작업 플로우 (분석 → 단독 구현 → 리뷰 → 판정 → PR → 출고)

여기는 지도다 — **규칙 본문은 그 규칙을 실행하는 스킬에 두고 여기에 다시 적지 않는다.**
스킬은 **능력 이름**으로만 말하고 명령은 .agents/harness/ 의 도구별 매핑에 있다 —
어느 매핑을 열지는 .agents/harness/capabilities.md 의 「매핑 선택」 한 곳에서 정한다.

| 단계 | 누가 | 산출물 (specs/LIFE-NNN-<슬러그>/) | 절차 |
| --- | --- | --- | --- |
| 0 시작 — 작업 브랜치·worktree·코디 기동 | 본체 | 00-start.md | task-start |
| 1 분석 — 일감 스냅샷·외부 서치 대조 | 코디 | 00-analysis.md | task-coordinate §1 |
| 2 판정 기준 — 구현 전에 박는다 | 코디 | 01-criteria.md | §2 |
| 3 킥오프 → **게이트 ⓪** | 코디 | 02-kickoff.md | §3 |
| 4 구현 — 단독 워커, 설계 단계 없음(경쟁은 옵션) | 워커 | 구현 브랜치 LIFE-NNN-<슬러그>-claude | §4 |
| 5 코드 리뷰 — 별도 세션, 재리뷰도 새 세션 | 리뷰어 | raw/review/, reviews.md | §5 |
| 6 판정 → **게이트 ①** | 코디 | verdict.md | §6·§7 |
| 7 사용자 확인 → **게이트 ②** = PR 생성·정리 | 코디 | handoff-main.md, pr.md | §8 |
| 8 출고 — PR 머지·태그·릴리즈 노트·dmg | 본체 | GitHub Release | release |

- 스킬 파일: .agents/skills/task-start · task-coordinate · release (각 SKILL.md). 역할별 모델·effort·리뷰어 구성은 task-start/defaults.md
- **네이티브 실행 관문** (워커·리뷰어 공통): 사용자의 네이티브 설치 경로에서 최소 1회 실행한 원자료가 있어야
  통과로 센다. 격리 인스턴스·fixture 실행만으로는 세지 않는다
- 판정 규칙(다수결 기각 금지·수렴 조건·수정 상한·테스트 계층·경량/전체 경로)은 task-coordinate §2·§3·§5·§6

## 상태 전이·보고 (진행: 코디네이터 / 출고: 본체 세션)

- 플로우 단계마다 LA 상태를 전이한다 (life-assistant issue_transition, forward-only):
  0 작업 시작 → "진행 중" / 1 분석 → "분석 중" / 4 구현 시작 → "개발 중" /
  5 코드 리뷰 → "검증 중"(PR 열린 동안 유지) / 8 출고 머지 후 → "완료"
- **사용자 승인 게이트 (자율 진행 금지 지점)** — 3단: ⓪ 킥오프 승인(구현 워커 기동 전 —
  문제 정의·범위·판정 기준 보고) ① 채택 승인(채택안 → 작업 브랜치 머지 전)
  ② 출고 승인(PR 생성 전). 게이트 사이 구간은 자율 진행하되 게이트에서 멈추고 보고한다.
  worktree 는 출고 승인 전까지 유지 — 사용자가 직접 실행·확인할 수 있는 상태. PR 을 연 뒤 정리한다(브랜치는 원격에 남는다)
- 작업이 끝나거나 막히면 반드시 사용자에게 보고 — 조용한 완료 금지
- 출고 승인 후에는 코디네이터가 PR 을 열고 정리까지 하며, LA 는 "검증 중" 에 둔다. 출고(release.sh) 머지 뒤
  본체 세션이 머지된 PR 의 일감마다 LA 를 완료한다. 인계 문서는 PR 생성 전에 커밋한다 — 상세는 task-coordinate §8.

## 브랜치 규약

- 작업 브랜치 LIFE-NNN-<슬러그> 는 main(독립 작업) 또는 feature 브랜치(묶음 자식)에서 분기, 작업 하나의 수명만 갖는다 —
  PR 을 열면 로컬은 정리하고 원격만 남긴다. 출고 머지(또는 feature 로 merge) 후 원격도 삭제 (단명 원칙 유지)
- **main 반영은 PR 머지로만** — 출고 때 scripts/release.sh 가 고른 순서대로 merge commit 으로 머지한다(검사 없이 순서 머지,
  충돌이면 멈춤. squash·rebase 머지는 레포 설정으로 꺼 둠). PR CI 는 아직 없다 — 후속 LIFE-575. main 직접 push·웹 UI 머지 금지 — 버전 올림 커밋·태그만 release.sh 가 올린다.
  Free 플랜 private 레포라 브랜치 보호가 없다(403) — 서버 강제 없이 규약과 스크립트 가드로 막는다
- **묶음 브랜치 feature/LIFE-NNN-<슬러그>** (NNN = 체크포인트): 서로 의존하는 작업 묶음만. 자식 작업 브랜치는 feature 에서
  따고 feature 로 로컬 merge, 묶음이 끝나면 feature → main PR 하나. main 이 움직이면 main 을 feature 로 merge(rebase 금지 —
  살아 있는 worktree). 독립 작업은 main 에서 따고 main 대상 PR. 그 외 체크포인트·프로젝트 단위 통합 브랜치는 금지
- 슬러그는 일감 타이틀에서 자동 파생(케밥케이스 1~3단어), 생성 후 불변 (매핑은 키로만)
- worktree 는 전부 .claude/worktrees/ 아래 형제 폴더 — 중첩 금지. 구현 브랜치 생존 중 작업 브랜치 rebase 금지
- 통합 확인은 throwaway: integration/<이름>-YYYYMMDD 에 합쳐 테스트 후 삭제. 유지 금지
- feature·예외적 장기 통합 브랜치는 만료일 명시(첫 자식 작업 00-start.md), 넘기면 쪼개서 main 에

## 도구 역할

- 코디네이터·판정 = 작업마다 claude 또는 codex 선택. 명시한 선택을 우선하고 신규 작업의
  미지정 기본값은 claude. 시작 시 `specs/LIFE-NNN-*/00-start.md`에 기록하고 재개 시 그대로 따른다.
  기동·전제 점검·선택 충돌 처리는 task-start 스킬을 따른다.
- **역할별 모델·effort 의 원본은 .agents/skills/task-start/defaults.md 한 곳이다.**
- claude (Claude Code) = 코디네이터·판정, 구현, 코드 리뷰. native advisor 상담
- codex = Astra 구현(경쟁 시) / 별도 Astra 코드 리뷰
- grok = 외부 서치·사실 검증 + 보완 코드 리뷰 (느림 수 분, 무료 쿼터 주의 — 검색 1회 소진 가능)
- **effort·모델은 세션 기동 시 반드시 명시한다.** 환경 기본이 medium 이라 플래그가 없으면
  조용히 내려간다. 기동 후 세션 중간에 바꾸지 않는다 — 프롬프트 캐시가 깨져 그 턴의 입력
  비용이 수십 배로 뛴다 (Fable 5.1 은 10만 토큰 접두사에서 약 50배)
- **advisor 는 Claude 내장 상담 도구다. 독립 리뷰를 대신하지 않는다** — 현재 기본 해제(defaults.md)
- 코디네이터 선택은 워커·리뷰어 기본 구성을 바꾸지 않는다. 같은 도구여도 세션과 역할은 구분한다.
- **제어 도구(pane·배달·완료 감지)는 절차와 분리한다.** 절차는 능력 이름으로 쓰고 명령은 매핑에 둔다 —
  목표는 "어디서나 같은 보장" 이 아니라 **"어디서나 돌고, 못 하는 것은 판정표에서 공백"** 이다
  (.agents/harness/capabilities.md)

## 세션 간 통신

- 영속 산출물: specs/ 파일 (진실의 원천)
- 제어 채널: 『감독 워커 기동』·『완료 감지』·『질의응답』 — 워커 기동·완료 감지·질의응답을 구조화된
  메시지로 처리한다. 완료는 워커의 종료 보고로만 본다 (파일·화면·프로세스 종료가 아니다).
  **명령과 보장 수준은 선택한 매핑(.agents/harness/<도구>.md)에서 읽는다** — 능력이 공백인 도구에서는
  그 판정 칸이 공백이다. 절차 쪽 상세는 task-coordinate SKILL.md §4
- 보조: Claude 세션 간 SendMessage (claude↔claude 한정)

## 어디를 고치나 (증상 → 파일)

| 증상 | 고치는 파일 |
| --- | --- |
| 프로젝트가 뭔지 매번 설명하게 된다 | AGENTS.md · specs/00-project.md |
| 문체·용어·문서 형식이 매번 다르다 | .agents/rules/writing.md |
| 코드 스타일·파일 이름이 제각각이다 | .agents/rules/coding.md |
| "다 됐습니다"인데 안 되어 있다 | .agents/rules/validation.md |
| 리뷰 품질·형식이 도구마다 흔들린다 | .agents/agents/reviewer.md |
| 도구가 바뀌면 절차 문서를 다시 쓰게 된다 | .agents/harness/capabilities.md (능력 이름·보장 어휘) |
| 명령·플래그가 실제와 다르거나 빠져 있다 | .agents/harness/<도구>.md (corral·orca·bare 매핑) |
| 같은 다단계 절차를 매번 다시 설명한다 | .agents/skills/<이름>/SKILL.md 신설 |
| 무엇을 만들어야 하는지가 흔들린다 | 해당 작업의 01-criteria.md |

## 원본 관리

- 규칙·에이전트·스킬 원본은 .agents/ 에만 둔다. .claude/ 의 rules·skills·agents 는 심링크 — 원본 저장 금지
- .agents/agents/ 의 역할 파일은 각 터미널 세션이 시작 시 읽는 지침서다 (서브에이전트 아님)
- grok 은 AGENTS.md 와 .claude/rules/ 를 자동 로드한다 — .grok/ 폴더 불필요
- .agents/agents/ 를 고치면 .codex/agents/*.toml 포인터가 깨지지 않았는지 확인
- rules 스텁(writing.md·coding.md)은 같은 실수 두 번째에 한 줄씩. 글로벌 스타일과 중복 금지
- 스킬의 로컬 상태(config.json, state/)는 .gitignore — config.example.json 만 커밋
- 이 파일이 200줄을 넘으면 이미 너무 길다 — 긴 절차는 스킬로 빼고 포인터만
