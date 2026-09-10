---
name: task-coordinate
description: corral 작업 코디네이터 절차 — 분석→기준→경쟁 구현→3자 리뷰→판정→승인 게이트→머지·정리 전 과정. 작업 worktree 의 코디네이터 세션이 킥오프 직후 읽는다. LIFE-342 첫 주행(2026-09-10)으로 검증, 어긋남 12건 반영.
---

# task-coordinate — 코디네이터 절차 (작업 worktree 세션에서 실행)

전제: task-start 가 만든 작업 worktree(`.claude/worktrees/LIFE-NNN-<슬러그>/`, 작업 브랜치 체크아웃) 안이다.
원칙은 AGENTS.md, 완료 조건은 `.agents/rules/validation.md`. 문서 산출물은 전부 작업 브랜치에 커밋한다.

## LA 상태 전이 (life-assistant `issue_transition`, forward-only)

분석 시작 → "분석 중" / 경쟁 구현 시작 → "개발 중" / 리뷰 시작 → "검증 중" / main 머지 후 → "완료"

## 1. 분석 — 4박자 (외부 서치가 수 분 걸리므로 순차가 아니라 겹친다)

1. **일감 본문 확보**: `issue_by_seq` 로 LIFE-N 상세를 읽는다. `specs/LIFE-NNN-<슬러그>/` 생성
2. **외부 서치 먼저 띄운다**: Claude WebSearch 로 개요를 먼저 깔고, grok 은 Orca 터미널 대화형으로
   병렬 위임 (grok-search 스킬 절차). grok 결과는 WebSearch 와 대조해 귀속 표기 — grok 단독 금지
3. **서치 대기 중 기준 초안** 작성 (§2)
4. **서치 취합 → 기준 확정**: 서치 결과가 기준을 바꿀 수 있다. 기준 freeze 는 *구현 시작 시점*이다
- **선행 문서의 사실 주장을 대조표로 검증한다** — 일감 본문·00-project.md 의 전제가 틀렸을 수 있다
  (LIFE-342 에서 5건 중 2건 오류 발견). 산출물: `00-analysis.md` (+ 외부 서치 원문 `00-analysis-grok.md`)
- 절차가 이 스킬과 어긋나면 `00-analysis.md` 의 "절차 어긋남" 섹션에 누적 기록한다 (스킬 개정 재료)

## 2. 판정 기준 — `01-criteria.md`

- 항목별 통과선 + **필수 관문**: ① 실제 실행 + 재현 가능한 원자료 ② 추측 판정 금지 (실행 없는 칸 = 항목 무효)
  ③ **통과선을 낮춰 통과시킨 흔적이 없을 것** (LIFE-342 탈락 사유가 이것이었다)
- 기준 없이 구현 시작 금지

## 3. 킥오프 문서 — `02-kickoff.md` (양 구현자에게 동일하게 주어지는 지시)

- **물류만 정한다. 설계는 지시하지 않는다** — 구조·라이브러리·계측 방법은 구현자 몫이고 그게 채점 대상
- 정체 표: 브랜치 / worktree / 격리 리소스(예: herdr 세션명) / 원자료 경로 / 결과 파일
- **격리 규칙**: 사용자가 실제 쓰는 리소스(default 세션·소켓 등)를 건드리지 않는다.
  외부 도구 실측은 전용 격리 인스턴스에서. 상대 브랜치 보지 않기, 작업 브랜치에 커밋하지 않기
- 원자료 규칙: 로그·스냅샷·타이밍 원본을 `specs/LIFE-NNN-*/raw/<도구>/` 에 커밋.
  판정표 "근거" 칸이 가리킬 실물이 없으면 그 항목은 무효
- **완료 신호**: 전부 커밋 + `raw/<도구>/DONE.md` (한 줄 요약 + 미완 목록).
  "커밋되지 않은 결과는 없는 것이다"

## 4. 경쟁 구현 — worktree 2개 + 워커 터미널 2개

```bash
git worktree add ../LIFE-NNN-<슬러그>-claude -b LIFE-NNN-<슬러그>-claude LIFE-NNN-<슬러그>
git worktree add ../LIFE-NNN-<슬러그>-codex  -b LIFE-NNN-<슬러그>-codex  LIFE-NNN-<슬러그>

orca terminal create --worktree path:<워커 worktree 절대경로> --title "impl: LIFE-NNN <도구>" \
  --command "claude|codex" --json          # ⚠ --focus 금지 — 코디네이터 포커스를 뺏는다. 무포커스로도 탭은 보인다
orca terminal send --terminal <handle> --text \
  "specs/LIFE-NNN-*/00-analysis.md → 01-criteria.md → 02-kickoff.md 순서로 읽고 구현해." --enter
```

- 경쟁 브랜치가 살아 있는 동안 작업 브랜치 rebase 금지
- **완료 감지는 화면이 아니라 git 으로**:
  ```bash
  # zsh 함정: <rev>:<path> 를 변수와 붙이지 않는다 (:s 가 히스토리 수식어로 파싱돼 오탐)
  git ls-tree -r --name-only "$BRANCH" -- "specs/LIFE-NNN-*/raw/<도구>/DONE.md"   # 출력 있으면 완료
  ```
  완료 신호는 "참이 되기 어려운 조건"으로 짠다 — 실패가 우연히 참이 되는 모양 금지

## 5. 3자 리뷰

- 검토 전 `.agents/agents/reviewer.md` 필독. claude 리뷰어는 **코디네이터와 별도 세션** (구현 지휘 기억 오염 방지)
- `git diff LIFE-NNN-<슬러그>..LIFE-NNN-<슬러그>-<도구>` 로 검토 (체크아웃 불필요)
- 결과: `review-<도구>.md`, 코디네이터가 작업 브랜치에 커밋

## 6. 취합·판정 — `verdict.md`

- **패자 raw/ 를 먼저 작업 브랜치로 회수한다** — 브랜치 삭제 전에. 안 하면 판정 재검증 불가
- 양 브랜치 HEAD 를 태그로 고정: `LIFE-NNN-claude-final` / `LIFE-NNN-codex-final` (리뷰가 줄 번호로 인용하므로)
- 기각·탈락엔 사유 기록, 자기 구현분 지적 기각은 특히 상세히
- 수렴: 높음+중간 0건 → 낮음 모아 1회 수정 후 종료. 수정 상한 3회

## 7. ⛔ 사용자 승인 게이트

판정 결과를 사용자에게 보고하고 **멈춘다**. main 머지·정리는 승인 후에만.
worktree 는 승인 전까지 삭제하지 않는다 — 사용자가 패널에서 직접 확인할 수 있게. 조용한 완료 금지.

## 8. (승인 후) 머지 → 정리

```bash
git merge LIFE-NNN-<슬러그>-<승자>                      # 승자 → 작업 브랜치
git -C <본체경로> merge LIFE-NNN-<슬러그>               # main 머지 (본체는 clean 전제)
git -C <본체경로> worktree remove .claude/worktrees/LIFE-NNN-<슬러그>-claude
git -C <본체경로> worktree remove .claude/worktrees/LIFE-NNN-<슬러그>-codex
git -C <본체경로> branch -D LIFE-NNN-<슬러그>-<패자> && git -C <본체경로> branch -d LIFE-NNN-<슬러그>-<승자> LIFE-NNN-<슬러그>
```

- LA → "완료" 전이. 태그는 지우지 않는다
- **자기 자신(작업 worktree) 제거는 main 세션에 맡긴다** — 세션이 앉아 있는 worktree 를 스스로 지우는
  동작은 미검증(D3). 사용자 보고에 "작업 worktree 제거 부탁" 을 포함시킨다
