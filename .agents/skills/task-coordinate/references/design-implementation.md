# 설계·구현 워커 실행 절차

task-coordinate §4에서 기동 전에 읽는다. 먼저 `orca skills get orchestration`의 설치판 계약을 확인한다.

## 1. 준비와 산출물 소유권

- 작업 코디네이터는 00-start의 실제 모델/effort를 유지한다. 워커는 `opus` / `high`, native advisor `fable`.
  시작 화면의 실제 해소 모델과 advisor 활성화를 기록한다. alias는 버전 고정이 아니므로 요청값과 관측값을 구분한다.
- `03-design.md`와 제품/구현 raw는 워커가 구현 브랜치에 커밋한다. 분석·기준·킥오프·리뷰·
  `04-design-verdict.md`·최종 verdict는 코디네이터가 작업 브랜치에 커밋한다.
- 리뷰어는 고정 commit의 설계/코드와 원자료를 읽는다. 결과는 킥오프에서 지정한 별도 임시 출력 경로에 쓴다.
  코디네이터가 `specs/LIFE-NNN-*/review-design-codex.md` 또는 `review-<도구>.md` 및 raw로 회수·커밋한다.
  제품 checkout에서 리뷰어가 git commit/add하거나 구현자 파일을 수정하지 않는다.
- 워커에게 작업 브랜치 최신 기준은 `git show <작업브랜치>:specs/...`로 읽도록 지시한다.
  코디네이터도 설계는 `git show <설계commit>:specs/.../03-design.md`로 읽는다. 리뷰를 위해 제품을 먼저 머지하지 않는다.
- native advisor는 서버에서 워커의 대화를 받아 상담한다. 별도 구현자·독립 리뷰어로 세지 않는다.
  호출 시점과 횟수는 모델이 정한다. 어려운 설계 판단에서 상담하도록 지시하되 “1회 상한”이나 별도 advisor effort를
  지원한다고 쓰지 않는다. 실제 상담 여부·실패/미사용은 워커 보고와 transcript로 확인한다.

## 2. Opus + advisor 기동

설치 Orca worker-start에는 advisor 옵션이 없다. 이 조합에 한해 **custom terminal create →
worker-start --terminal**을 허용한다. 완료 감지는 계속 orchestration이다. --advisor를 worker-start에 붙이지 않는다.

1. 킥오프 승인 후 작업 브랜치 HEAD에서 구현 브랜치와 형제 worktree를 만든다. 기존 것이면 재사용 여부부터 확인한다.
   현재 corral task-start와 같은 git worktree 경로다. repo setup hook이 새로 생겼다면 먼저 정책대로 실행·준비 확인한다.
   custom 경로로 wait-for-setup 정책을 건너뛰지 않는다.

```bash
# 본체 절대경로를 REPO_ROOT에, 현재 작업 브랜치를 TASK_BRANCH에 지정한 뒤 실행
git -C "$REPO_ROOT" worktree add "$REPO_ROOT/.claude/worktrees/${TASK_BRANCH}-claude" \
  -b "${TASK_BRANCH}-claude" "$TASK_BRANCH"
orca terminal create --worktree "path:$REPO_ROOT/.claude/worktrees/${TASK_BRANCH}-claude" \
  --title "${TASK_BRANCH} · opus + advisor" \
  --command 'claude --model opus --effort high --advisor fable' --json
```

2. 반환 handle을 기록한다. timeout이면 terminal list/show로 해당 worktree의 생성 여부부터 확인해 중복 기동을 막는다.
   `terminal wait --for tui-idle --timeout-ms 60000`와 `terminal read`로 trust/login/권한 대기와 실제 입력 준비를 구분한다.
   advisor on 알림과 모델을 확인하며 필요하면 `/advisor` picker를 **조회 후 취소**한다. 전역 설정을 저장하지 않는다.
   사용량/접근 차단이나 advisor 비활성은 코디네이터에게 보고하고 자동 대체하지 않는다.
3. Run은 기존 것을 우선 사용하고 없을 때만 생성한다. 설계 Task에 범위·산출물·제품 구현 금지·완료 후 대기를 명시한다.

```bash
orca orchestration run-create --objective "LIFE-NNN 설계·구현" --json
orca orchestration task-create --spec "기준/킥오프를 읽고 설계만 수행. 03-design.md와 실험 근거를 구현 브랜치에 커밋. 제품 구현 없이 worker_done 후 대기." --json
orca orchestration worker-start --task <design_task> --terminal <opus_handle> \
  --worktree path:<구현_worktree_절대경로> --json
```

명시 Run 선택이 필요한 문맥은 `--run <run_id>`를 사용한다. 재사용 --terminal에는 --model/--effort를 함께 줄 수 없다.
이 터미널은 코디네이터가 만든 **기존 terminal을 빌려 감독하는 형태**다. 생성 handle/worktree/agent 정체와
종료 책임을 02-kickoff에 기록한다. worker-release가 실제 프로세스를 닫았다고 가정하지 않는다.

## 3. 설계 완료 → 보존 → 독립 설계 리뷰

정확한 Task/Dispatch의 succeeded worker_done과 설계 commit을 확인한다. 실패면 원인·잔여 리소스를 처리한다.
사용자가 요청한 “같은 워커가 이어서 구현”을 근거로 설계 워커를 보존한다. 이 요청은 00-start/02-kickoff에 남긴다.

```bash
orca orchestration worker-retain --dispatch <design_dispatch> --json
orca orchestration task-create --spec "독립 설계 리뷰. reviewer.md의 설계 모드. 고정 설계 commit·기준·기존 코드를 대조하고 지적/근거/미확인 기록. 제품 수정 금지." --json
orca orchestration worker-start --task <design_review_task> \
  --worktree path:<구현_worktree_절대경로> --agent codex \
  --model gpt-6-astra --effort high --json
```

실제 Task spec에는 위 요약과 함께 정확한 commit·기준 경로·보고서 임시 경로를 채운다.
배치 처리와 retain 결정을 마친 뒤 delivery를 ACK한다. 워커는 리뷰 중 제품/설계를 변경하지 않는다.
리뷰 완료 후 리뷰 terminal은 release한다. 코드 리뷰 때 이 세션을 재사용하지 않는다.

보완은 새 design-fix Task를 같은 Opus terminal에 전달한다. 수정 설계 commit으로 다시 리뷰하고,
`04-design-verdict.md`에 지적별 채택/기각·근거와 통과 대상 commit을 고정한다. 이전 commit 리뷰를 새 설계 통과로 세지 않는다.

## 4. 통과 후 같은 워커 구현

```bash
orca orchestration task-create --spec "설계 판정의 고정 commit을 읽고 구현·검증. 승인 범위/기준 유지. 핵심 설계 변경은 ask. 제품·raw 커밋 후 worker_done 보고." --json
orca orchestration worker-start --task <implementation_task> --terminal <opus_handle> \
  --worktree path:<구현_worktree_절대경로> --json
```

새 응답의 Task/Dispatch를 저장하고 워커가 새 preamble을 받았는지 확인한다. 이전 설계 Dispatch로 구현 완료를 보고하지 않는다.
retain은 보존 의사 기록이며 새 Task 배정 자체가 아니다. 재사용 실패/세션 종료/사용자 takeover면 상태를 확인하고
새 세션에는 설계·판정·진행 증거를 인계한다. 새로 기동했다면 동일 세션으로 재개했다고 쓰지 않는다.

구현 완료 후 수정 가능성을 위해 동일 워커를 유지하는 요청도 기록하고 retain한다. 코드 리뷰는 새 Astra xhigh와
별도 Grok 세션에서 고정 구현 commit을 본다. 리뷰 완료 후 수정 Task는 위와 같은 재사용 경로다.
핵심 설계 변경의 재검토는 설계 리뷰 2회 상한에 누적하고 코드 수정은 기존 최대 3회에 누적한다. 미수렴 시 사용자 보고.

## 5. 완료·취소 후 정리

- 끝난 모든 Dispatch의 release 결과를 확인한다. failed 완료도 정리 대상이다.
- custom으로 만든 terminal은 borrowed/pre-existing 사유로 retained일 수 있다. 이 경우
  원자료를 회수한 뒤 terminal show/worker-show로 기록된 handle·worktree·agent 정체, 활성 Dispatch 없음,
  사용자 takeover 없음과 이번 작업의 전용 터미널임을 확인한 경우에만 `terminal close --terminal <handle>`로 정리한다.
  불확실하면 보존하고 차단 사유를 보고한다. release_pending/unknown을 이 절차로 우회하지 않는다.
- 재사용된 옛 Dispatch의 release로 현재 워커가 정리됐다고 가정하지 않는다. 최종 Dispatch와 실제 소유권을 확인한다.
- 사용자 확인용 worktree는 출고 승인까지 유지한다. terminal 유지와 worktree 유지의 수명은 다르다.
- 역할별 사용량은 도구가 제공하는 값만 기록한다. 제공되지 않는 토큰·비용·절감률을 추정해 실측으로 보고하지 않는다.
