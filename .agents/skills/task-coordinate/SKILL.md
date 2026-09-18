---
name: task-coordinate
description: corral 작업 코디네이터 절차 — 분석→기준→경쟁 구현→3자 리뷰→판정→승인 게이트→머지·정리 전 과정. 작업 worktree 의 코디네이터 세션이 킥오프 직후 읽는다. LIFE-342 첫 주행(2026-09-10)으로 검증, 어긋남 13건 반영(LIFE-357 — design-brief/design-intake 삽입 지점 명시). 2026-09-18: 워커 기동·완료 감지를 저수준 `orca terminal` 조합에서 `orca orchestration`(worker-start/check --wait)로 전면 교체 — 완료 감지 폴링 실패(LIFE-345) 근본 해결.
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
- **UI 비중이 큰 일감이면 여기서 `design-brief`/`design-intake` 스킬 삽입 여부를 검토한다** — 비주얼
  디테일(간격·톤·인터랙션 느낌)이 판정 기준에 안 잡히는 일감은 목업 없이 구현자 재량에 맡기면
  재작업 위험이 있다 (LIFE-357 판단 뒤집음, 2026-09-13). 넣기로 하면 순서는 `specs/app-screens.md`
  (화면 인벤토리, 없으면 먼저) → `/design-brief` → 외부 Claude Design → `/design-intake` →
  그 결과를 반영해 `01-criteria.md`/`02-kickoff.md` 작성·freeze. 안 넣기로 하면 그 판단 사유를
  `00-analysis.md` 에 한 줄 남긴다(추측 판정 금지 원칙과 같은 결의 — 판단 없이 생략하지 않는다)

## 2. 판정 기준 — `01-criteria.md`

- 항목별 통과선 + **필수 관문**: ① 실제 실행 + 재현 가능한 원자료 ② 추측 판정 금지 (실행 없는 칸 = 항목 무효)
  ③ **통과선을 낮춰 통과시킨 흔적이 없을 것** (LIFE-342 탈락 사유가 이것이었다)
- 기준 없이 구현 시작 금지

## 3. 킥오프 문서 — `02-kickoff.md` (양 구현자에게 동일하게 주어지는 지시)

- **물류만 정한다. 설계는 지시하지 않는다** — 구조·라이브러리·계측 방법은 구현자 몫이고 그게 채점 대상
- 정체 표: 브랜치 / worktree / 격리 리소스(예: herdr 세션명) / 원자료 경로 / 결과 파일
- **격리 규칙**: 사용자가 실제 쓰는 리소스(default 세션·소켓 등)를 건드리지 않는다.
  외부 도구 실측은 전용 격리 인스턴스에서. 상대 브랜치 보지 않기, 작업 브랜치에 커밋하지 않기
- **격리 인스턴스 기동에 "헤드리스는 안 된다" 고 단정하지 않는다.** 정확히는 *TTY 가 없으면* 안 되는
  것이고, `script(1)` 같은 PTY 래퍼로 붙는 경로가 있다. LIFE-344 에서 herdr 세션 기동이
  Orca 탭 경로 61.5초 · PTY 경로 53ms 로 갈렸다 — 재기동 시간이 통과선에 들어가는 항목이 있으면
  이 차이가 판정을 뒤집는다. (**각각 1회 측정**이라 수치는 자릿수로만 쓴다)
- 원자료 규칙: 로그·스냅샷·타이밍 원본을 `specs/LIFE-NNN-*/raw/<도구>/` 에 커밋.
  판정표 "근거" 칸이 가리킬 실물이 없으면 그 항목은 무효
- **결과 문서**: 전부 커밋 + `raw/<도구>/DONE.md` (한 줄 요약 + 미완 목록) — 이건 감사 추적용
  기록이지 프로세스 완료 감지 신호가 아니다. 완료 감지는 §4 의 orchestration `worker_done` 메시지로
  한다. "커밋되지 않은 결과는 없는 것이다"

## 4. 구현 — 기본 경쟁(claude ∥ codex), 단독은 예외 (2026-09-18 전환)

기본은 claude·codex 워커 2개를 동시에 붙인다. claude 단독은 분석 단계에서 "설계 접근이 갈릴 여지가
거의 없는 단순 작업"으로 판단해 일감에 명시했을 때만. 워커 모델·effort 는 분석에서 정해
02-kickoff.md 정체 표에 기록한다 — 둘 다 `orchestration worker-start --model <m> --effort <e>`로
동일하게 지정한다(모델은 구독 목록 한정).

**기본 페어링은 플래그십 대 플래그십** (2026-09-18, GPT-6 Astra 출시 계기로 명시): codex 쪽에
Astra(`model = "gpt-6-astra"`, Codex 신규 최상위 모델)를 쓴다면 claude 쪽도 Opus 가 아니라
**Fable**(Anthropic 신규 최상위 "Mythos급" 모델, `claude-fable-5-1` — FrontierBench 최고점,
Opus 는 그 아래 등급으로 재배치됨)로 맞춘다. effort 도 양쪽 동일 등급(예: 둘 다 high)으로 —
한쪽만 급을 낮추면 판정이 모델 격차 때문인지 구현 품질 때문인지 갈리지 않는다. 비용·속도 등
다른 이유로 급을 다르게 갈 때는 그 사유를 02-kickoff.md 정체 표에 남긴다.

**워커 기동·완료 감지는 Orca `orchestration` 계층으로 한다** (2026-09-18 전환, 저수준
`terminal create/send/read` 조합 폐기). 먼저 `orca skills get orchestration`으로 스킬 본문을 읽는다.
이유: 저수준 조합은 완료 감지를 git 파일 존재(`DONE.md`)로 대체 판단해야 했고 이게 두 번 헛불렀다
(`specs/LIFE-345-terminal-view/verdict.md` — ① 자리표시자 든 초안을 완료로 오판 ② 워커가 계속
도는데 파일만 보고 완료로 오판, 사용자가 잡음). `orchestration`은 워커가 보내는 구조화된
`worker_done` 메시지로 이 문제를 근본에서 없앤다. 워크트리 배치 경로는 그대로
`.claude/worktrees/<이름>`이다(Orca 기본값 — life-assistant·home-coffing 두 레포에서 실측 확인,
`orca.yaml` 오버라이드 없이도 이 경로를 씀).

```bash
orca orchestration run-create --objective "LIFE-NNN <슬러그>" --json
orca orchestration task-create --spec "specs/LIFE-NNN-*/00-analysis.md → 01-criteria.md → 02-kickoff.md 순서로 읽고 구현해." --json
# → task_claude 발급. codex 도 동일 spec 으로 한 번 더 task-create → task_codex (단독 예외면 생략)

orca orchestration worker-start --task <task_claude> --worktree new-child \
  --name LIFE-NNN-<슬러그>-claude --agent claude --model <m> --effort <e> --json
orca orchestration worker-start --task <task_codex> --worktree new-child \
  --name LIFE-NNN-<슬러그>-codex --agent codex --model <m> --effort <e> --json
```

- 브랜치·worktree 이름은 `--name`으로 기존 컨벤션(`LIFE-NNN-<슬러그>-<도구>`) 그대로 지정
- 경쟁 브랜치가 살아 있는 동안 작업 브랜치 rebase 금지
- **완료 대기는 블로킹으로 건다 — 폴링하지 않는다**:
  ```bash
  orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
  ```
  타임아웃이나 `{count:0}`은 실패가 아니라 체크포인트다 — 긴 구현은 15~60분 걸리는 게 정상이니
  받은 배치를 처리하고 `check --ack <delivery_id> --wait ...`로 이어서 다시 건다. 유효한
  `worker_done`이 오면 그 태스크는 자동으로 완료 처리된다(`task-update`로 수동 완료 처리 금지)
- **워커가 막혀서 `question`을 보내면** `orca orchestration reply --id <msg_id> --body <답> --json`으로
  답하고 계속 대기한다 — "질문 대기 화면을 코디네이터가 키 입력으로 풀어주던" 임시방편(LIFE-356)의
  정식 대체
- **완료된 워커는 정리한다**: `orca orchestration worker-release --dispatch <dispatch_id> --json`.
  수정 라운드로 같은 워커에 바로 이어 맡길 거면 release 하지 말고
  `orca orchestration worker-start --task <다음_task_id> --terminal <handle> --json`로 재사용한다

## 5. 3자 리뷰

- 검토 전 `.agents/agents/reviewer.md` 필독. claude 리뷰어는 **코디네이터와 별도 세션** (구현 지휘 기억 오염 방지)
- **claude·codex 리뷰어도 §4 와 같은 방식으로 띄운다** — 같은 Run 에 `orchestration worker-start`,
  완료 대기는 `check --wait --types worker_done,escalation,question`. grok 리뷰어는 예외 —
  grok-search 스킬의 기존 Orca 대화형 경로 그대로 쓴다(orchestration `--agent` 대상이 아니라
  검색 위임 스킬 소관)
- `git diff LIFE-NNN-<슬러그>..LIFE-NNN-<슬러그>-<도구>` 로 검토 (체크아웃 불필요)
- **리뷰어 터미널은 구현 worktree 에서 돌려도 된다** (LIFE-356, 사용자 승인 2026-09-13) —
  원자료 재검산·독립 재실행(하네스 재투입)이 체크아웃 상태를 요구할 때 이쪽이 싸다.
  판정문·기준서는 `git show <작업브랜치>:specs/...` 로 읽는다. 리뷰 실행 흔적은 리뷰어가
  스스로 정리(구현자 원자료 불변, git status clean)하고 코디네이터가 취합 전 확인한다
- 결과: `review-<도구>.md`, 코디네이터가 작업 브랜치에 커밋

## 6. 취합·판정 — `verdict.md`

- **패자 raw/ 를 먼저 작업 브랜치로 회수한다** — 브랜치 삭제 전에. 안 하면 판정 재검증 불가
- 양 브랜치 HEAD 를 태그로 고정: `LIFE-NNN-claude-final` / `LIFE-NNN-codex-final` (리뷰가 줄 번호로 인용하므로)
- 기각·탈락엔 사유 기록, 자기 구현분 지적 기각은 특히 상세히
- 수렴: 높음+중간 0건 → 낮음 모아 1회 수정 후 종료. 수정 상한 3회

## 7. ⛔ 승인 게이트 ① — 채택

판정 결과를 사용자에게 보고하고 **멈춘다**. 이 시점엔 머지 0건 — 승자 변경·추가 수정 요구가 가능하다.
조용한 완료 금지.

## 8. (채택 승인 후) 작업 브랜치 머지 → 사용자 확인 → ⛔ 승인 게이트 ② — 출고

```bash
git merge LIFE-NNN-<슬러그>-<승자>                      # 승자 → 작업 브랜치
```

- 머지 후 사용자에게 알린다: **작업 worktree 에서 통합 결과를 직접 실행·확인해 달라**
  (실행 방법을 한 줄로 같이 준다). 문제가 나오면 수정 라운드 → 재확인
- **게이트 ① 사용자 수정 라운드** (LIFE-353 fix3 · LIFE-356 G1~G6 전례): 확인 중 나온 지시·결함은
  범위를 문서로 박고(04-gate1-fix.md 류) 워커가 구현 브랜치에 이어 커밋(rN 태그) → 코디네이터가
  diff 정독·게이트 재실행·스모크 원자료 검증 후 verdict 에 판정 부록 append → 작업 브랜치 머지.
  풀 3자 리뷰는 안 돌린다 (범위가 UI/문구 수준일 때 — 가드·기준 경로를 건드리면 재리뷰 판단)
- 수정 라운드 워커도 §4 패턴 그대로: 같은 워커에 이어 맡기면
  `orchestration worker-start --task <fix_task_id> --terminal <handle>`로 재사용, 완료 대기·질문
  응답은 `check --wait`/`reply`로 처리한다(codex 류 승인 프롬프트 정지도 이제 `question` 메시지로
  들어오므로 화면 감시가 따로 필요 없다 — LIFE-356 verdict §5 임시방편의 정식 대체)
- 확인이 끝나 사용자가 **출고 승인**을 주면:
  1. LA → "완료" 전이
  2. 사용자에게 마무리 안내 한 줄: **"본체 위치에서 `scripts/task-finish.sh LIFE-NNN-<슬러그>` 실행"**
     — main 머지·push·worktree 3개·브랜치 정리를 스크립트가 멱등하게 수행한다 (태그는 유지)
- 코디네이터는 자기 worktree 밖(main 머지·정리)을 직접 건드리지 않는다 — 판단이 필요 없는
  마무리는 세션이 아니라 스크립트의 일이다. 이 세션은 안내 후 종료해도 된다
