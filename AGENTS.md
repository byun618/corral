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

## 작업 플로우 (분석 → 단독 구현 → 3자 리뷰 → 판정)

실행 절차(명령 수준)는 스킬을 따른다 — 시작: .agents/skills/task-start/SKILL.md (main 세션),
진행: .agents/skills/task-coordinate/SKILL.md (코디네이터 세션). 아래는 원칙 요약.

0. 작업 시작: main 에서 작업 브랜치 LIFE-NNN-<슬러그> 분기, 전용 worktree 로 체크아웃
   (.claude/worktrees/LIFE-NNN-<슬러그>/) — 본체는 항상 main 에 둔다.
   specs/LIFE-NNN-<슬러그>/ 생성. 분석·기준·리뷰·판정 문서는 모두 작업 브랜치에 커밋한다
1. 분석: 코디네이터가 일감을 읽고 "모르는 것 목록" 작성 → grok에 외부 서치 위임
   (corral terminal create --agent grok → wait --for agent-ready → prompt --wait accepted → terminal read,
   코디네이터의 웹 검색과 대조. 전역 grok-search 스킬에서는 리서치 규칙만 가져온다) → specs/LIFE-NNN-*/00-analysis.md
2. 판정 기준 선행: 구현 시작 전 specs/LIFE-NNN-*/01-criteria.md 에 채택 기준을 박는다
   (테스트 통과·단순성·엣지케이스 등). 기준 없이 구현 시작 금지
   - **네이티브 실행 관문**: 사용자의 네이티브 설치 경로에서 최소 1회 실행한 원자료가 있어야
     통과로 센다. 격리 인스턴스·fixture 실행만으로는 세지 않는다 (LIFE-394 결함이 이 경로로 샜다)
   - **⓪ 킥오프 승인**: 킥오프 문서까지 커밋한 뒤 문제 정의·범위·판정 기준·구현 방식을
     사용자에게 보고하고 승인 후에만 워커를 기동한다 (task-coordinate 게이트 ⓪)
3. 구현: 기본은 **단독 워커** (2026-09-22). **설계는 별도 단계가 아니라 워커가 흡수한다** —
   워커가 접근을 정하고 바로 구현한다. 설계 문서·독립 설계 리뷰는 폐지 (LIFE-394 에서
   설계 리뷰만 4라운드, 매 라운드 새 높음 지적이 나왔고 기각은 0이었다. 대조군 LIFE-393 은
   설계 단계 없이 리뷰 1라운드로 끝났다)
   - 구현 브랜치: 작업 브랜치에서 LIFE-NNN-<슬러그>-claude 분기, 전용 worktree
   - **경쟁 구현은 옵션**이다. 코디네이터 추천 또는 사용자 요구로 발동하며 발동 근거를
     킥오프에 명시한다 — ① 접근이 갈리고 문서로 우열이 안 날 때 ② 되돌리기 비싼 변경
     ③ 터미널·에이전트 제어 계층 ④ Claude 주간 쿼터가 임계에 근접했을 때
     (Codex 는 별도 구독이라 Claude 풀을 쓰지 않는다 — 경쟁은 Claude 쿼터를 늘리지 않는다)
   - worktree는 전부 .claude/worktrees/ 아래 형제 폴더 — 중첩 금지. 구현 브랜치 생존 중 작업 브랜치 rebase 금지
   - 사용자 지정 예외와 기존 작업은 해당 킥오프를 따른다. 신규 기본은 단독 구현이다
4. 3자 리뷰: **codex·claude·grok 모두 리뷰**. 서로, 그리고 코디네이터·구현자와 별도 세션이다.
   .agents/agents/reviewer.md 를 읽고 specs/LIFE-NNN-*/review-<도구>.md 에 기록한다
   - **재리뷰는 반드시 새 세션으로 한다.** 같은 세션 반복은 검출력이 오르지 않는다
   - 자기 구현분도 리뷰한다. 단 자기 구현 브랜치 리뷰는 경쟁 승자 판정 근거로 쓰지 않는다
5. 취합·판정: 코디네이터가 지적 취합 → 채택 판정 → specs/LIFE-NNN-*/verdict.md
   - **단일 리뷰어 지적을 다수결로 기각하지 않는다. 전원 침묵을 통과 근거로 쓰지 않는다**
     (LIFE-394 에서 3자가 모두 놓친 높음 결함을 사용자 확인이 잡았다)
   - codex 의 "구조를 버리고 다시 쓰라" 류 지적은 코디네이터가 독립 재현한 뒤 채택한다
   - 기각·탈락에는 반드시 사유 기록. 자기 구현분 지적을 기각할 때는 사유를 특히 상세히
   - 종료 조건: 높음+중간 지적 0건 → 낮음 모아 1회 수정 후 종료. 수정 상한 3회
6. 마무리 — 승인 게이트 2단:
   - **① 채택 승인**: 수렴하면 머지 없이 판정 결과 보고 → 승인 후 채택안 → 작업 브랜치 머지
     (머지 전이라 채택안 변경·추가 수정 요구 가능)
   - 사용자 직접 확인: 작업 worktree 에서 통합 결과를 실제로 굴려본다. 문제 발견 시 수정 라운드
   - **② 출고 승인**: 확인이 끝나면 승인 → 인계 문서 커밋 → 본체 세션이 main 머지·정리·반영 확인 → LA 완료

## 상태 전이·보고 (진행: 코디네이터 / 출고: 본체 마무리 세션)

- 플로우 단계마다 LA 상태를 전이한다 (life-assistant issue_transition, forward-only):
  0 작업 시작 → "진행 중" / 1 분석 → "분석 중" / 3 구현 시작 → "개발 중" /
  4 코드 리뷰 → "검증 중" / 6 main 머지 후 → "완료"
- **사용자 승인 게이트 (자율 진행 금지 지점)** — 3단: ⓪ 킥오프 승인(구현 워커 기동 전 —
  문제 정의·범위·판정 기준 보고) ① 채택 승인(채택안 → 작업 브랜치 머지 전)
  ② 출고 승인(main 머지·정리 전). 게이트 사이 구간은 자율 진행하되 게이트에서 멈추고 보고한다.
  worktree 는 출고 승인 전까지 유지 — 사용자가 직접 실행·확인할 수 있는 상태
- 작업이 끝나거나 막히면 반드시 사용자에게 보고 — 조용한 완료 금지
- 출고 승인 후에는 본체 마무리 세션이 스크립트 성공·main 반영을 확인하고 LA를 완료한다.
  작업 worktree 삭제 전에 인계 내용을 커밋한다 — 상세는 task-coordinate §8.

## 브랜치 규약

- 작업 브랜치 LIFE-NNN-<슬러그> 는 main 에서 분기, 작업 하나의 수명만 갖는다 —
  main 머지 후 즉시 삭제 (단명이라 트렁크 기반의 짧은 수명 원칙 유지)
- 체크포인트·프로젝트 단위 통합 브랜치는 금지 — LA 묶음 개념만
- 슬러그는 일감 타이틀에서 자동 파생(케밥케이스 1~3단어), 생성 후 불변 (매핑은 키로만)
- 통합 확인은 throwaway: integration/<이름>-YYYYMMDD 에 합쳐 테스트 후 삭제. 유지 금지
- 예외적 장기 통합 브랜치는 만료일 명시, 넘기면 쪼개서 main 에

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
- **advisor 는 Claude 내장 상담 도구다. 독립 리뷰를 대신하지 않는다** — advisor 조언 자체는
  지적이 아니다. 지적은 diff 에서 재현 가능해야 등록하고, verdict 에서 advisor 동의를
  교차 확인 근거로 세지 않는다. 격차가 있을 때만 발동한다 (LIFE-394 실측: Fable 코디 0회,
  Opus 워커 23회). Fable 사용량 천장이 가까우면 리뷰어 advisor 부터 해제한다
- 코디네이터 선택은 워커·리뷰어 기본 구성을 바꾸지 않는다. 코드 리뷰 3자는 서로,
  그리고 코디네이터·구현자와 별도 세션이다. 같은 도구여도 세션과 역할은 구분한다.

## 세션 간 통신

- 영속 산출물: specs/ 파일 (진실의 원천)
- 제어 채널: corral `orchestration`(worker-start/check --block/ask·reply) — 워커 기동·완료 감지·질의응답을
  구조화된 메시지로 처리. `worker-start` 가 `--advisor` 를 직접 받으므로 예외 경로는 없다.
  완료 감지는 계속 worker_done/check/ACK다. 상세는 task-coordinate SKILL.md §4
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
