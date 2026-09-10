# corral — 공통 지침

herdr 기반 AI 워크스페이스 (LIFE-337). 세션·일감을 한 울타리에 모으는 미션 컨트롤.
herdr = 바닥 레이어(PTY·영속·에이전트 상태·worktree), 그 위 Electron + React GUI.

프로젝트 방향·스텝은 specs/00-project.md 를 읽는다.

## 산출물 규칙

- 작업 하나 = specs/LIFE-NNN-<슬러그>/ 폴더. 단계 산출물은 번호 파일 (00-analysis.md, 01-criteria.md, …)
- specs/ 파일이 진실의 원천. 세션 간 조율은 파일로 한다 — 세션 컨텍스트는 휘발됨
- 완료 선언 전에 .agents/rules/validation.md 의 완료 조건을 확인한다

## 작업 플로우 (분석 → 경쟁 구현 → 3자 리뷰 → 판정)

0. 작업 시작: main 에서 작업 브랜치 LIFE-NNN-<슬러그> 분기, 전용 worktree 로 체크아웃
   (.claude/worktrees/LIFE-NNN-<슬러그>/) — 본체는 항상 main 에 둔다.
   specs/LIFE-NNN-<슬러그>/ 생성. 분석·기준·리뷰·판정 문서는 모두 작업 브랜치에 커밋한다
1. 분석: claude가 일감을 읽고 "모르는 것 목록" 작성 → grok에 외부 서치 위임
   (Orca 터미널 대화형, Claude WebSearch 먼저 깔고 대조) → specs/LIFE-NNN-*/00-analysis.md
2. 판정 기준 선행: 구현 시작 전 specs/LIFE-NNN-*/01-criteria.md 에 채택 기준을 박는다
   (테스트 통과·단순성·엣지케이스 등). 기준 없이 구현 시작 금지
3. 경쟁 구현: claude 와 codex 가 같은 스펙을 각자 브랜치에서 구현
   - 작업 브랜치에서 분기: LIFE-NNN-<슬러그>-claude, LIFE-NNN-<슬러그>-codex (각자 전용 worktree)
   - worktree 는 전부 .claude/worktrees/ 아래 형제 폴더 — worktree 폴더 안에 worktree 중첩 금지
   - 대시(-claude)인 이유: git ref 제약으로 LIFE-NNN-<슬러그> 와 LIFE-NNN-<슬러그>/claude 는 공존 불가
   - 경쟁 브랜치가 살아 있는 동안 작업 브랜치 rebase 금지 (merge-base 붕괴)
4. 3자 리뷰: claude·codex·grok 모두 리뷰. 검토 전 .agents/agents/reviewer.md 를 읽는다
   → specs/LIFE-NNN-*/review-<도구>.md
5. 취합·판정: claude 가 지적 취합 → 채택 판정 → specs/LIFE-NNN-*/verdict.md
   - 기각·탈락에는 반드시 사유 기록. 자기 구현분 지적을 기각할 때는 사유를 특히 상세히
   - 종료 조건: 높음+중간 지적 0건 → 낮음 모아 1회 수정 후 종료. 수정 상한 3회
6. 마무리: 수렴 후 승자 브랜치 → 작업 브랜치 머지 → **사용자에게 판정 결과 보고 후 승인 대기**
   → 승인 후에만 본체(main)에서 작업 브랜치 머지 + 브랜치·worktree 정리

## 상태 전이·보고 (코디네이터 책임)

- 플로우 단계마다 LA 상태를 전이한다 (life-assistant issue_transition, forward-only):
  0 작업 시작 → "진행 중" / 1 분석 → "분석 중" / 3 경쟁 구현 → "개발 중" /
  4 리뷰 → "검증 중" / 6 main 머지 후 → "완료"
- **사용자 승인 게이트 (자율 진행 금지 지점)**: ① main 머지 ② 브랜치·worktree 삭제(정리).
  판정(verdict)까지는 자율 진행하되, 거기서 멈추고 보고한다 — 정리 전이라 사용자가
  worktree·산출물을 직접 확인할 수 있는 상태를 유지
- 작업이 끝나거나 막히면 반드시 사용자에게 보고 — 조용한 완료 금지

## 브랜치 규약

- 작업 브랜치 LIFE-NNN-<슬러그> 는 main 에서 분기, 작업 하나의 수명만 갖는다 —
  main 머지 후 즉시 삭제 (단명이라 트렁크 기반의 짧은 수명 원칙 유지)
- 체크포인트·프로젝트 단위 통합 브랜치는 금지 — LA 묶음 개념만
- 슬러그는 일감 타이틀에서 자동 파생(케밥케이스 2~3단어), 생성 후 불변 (매핑은 키로만)
- 통합 확인은 throwaway: integration/<이름>-YYYYMMDD 에 합쳐 테스트 후 삭제. 유지 금지
- 예외적 장기 통합 브랜치는 만료일 명시, 넘기면 쪼개서 main 에

## 도구 역할

- claude (Claude Code) = 코디네이터·판정 + 구현자 A
- codex = 구현자 B + 코드 검토
- grok = 외부 서치·사실 검증 (느림 수 분, 무료 쿼터 주의 — 검색 1회 소진 가능)

## 세션 간 통신

- 영속 산출물: specs/ 파일 (진실의 원천)
- 제어 채널: orca terminal create/send/read/wait — 워커 터미널 생성·지시 주입·완료 감지.
  워커는 백그라운드가 아니라 Orca 탭으로 열어 진행이 보이게 한다
- 보조: Claude 세션 간 SendMessage (claude↔claude 한정)

## 어디를 고치나 (증상 → 파일)

| 증상 | 고치는 파일 |
| --- | --- |
| 프로젝트가 뭔지 매번 설명하게 된다 | AGENTS.md · specs/00-project.md |
| 문체·용어·문서 형식이 매번 다르다 | .agents/rules/writing.md |
| 코드 스타일·파일 이름이 제각각이다 | .agents/rules/coding.md |
| "다 됐습니다"인데 안 되어 있다 | .agents/rules/validation.md |
| 리뷰 품질·형식이 도구마다 흔들린다 | .agents/agents/reviewer.md |
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
