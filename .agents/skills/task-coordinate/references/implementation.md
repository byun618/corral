# 구현 워커 실행 절차

task-coordinate §4에서 기동 전에 읽는다. 먼저 `corral agent-context --json`으로 플래그를 확인하고
계약 산문은 `app/cli/README.md`를 읽는다. 설치판 스킬 문서에 해당하는 것은 corral에 없다.

## 1. 준비와 산출물 소유권

- 작업의 모든 역할 모델/effort는 00-start의 기록을 따른다. 아래 명령은 기본 `opus` / `high`,
  native advisor `fable` 예시다. 명시 변경이 있으면 해당 CLI가 실제 지원하는 옵션으로 반영한다.
  실제 해소 모델·advisor 활성화는 `terminal show`(provider 프로세스·argv)와 `terminal read`(배너)로 기록한다 —
  dispatch 스냅샷은 기동 시점 관측이라 갱신되지 않는다. alias는 버전 고정이 아니니 요청값과 관측값을 구분한다.
- 제품/구현 raw는 워커가 구현 브랜치에 커밋한다. 분석·기준·킥오프·리뷰·최종 verdict는
  코디네이터가 작업 브랜치에 커밋한다. **별도 설계 문서는 만들지 않는다.**
- 리뷰어는 고정 commit의 코드·원자료를 읽고 결과를 킥오프가 지정한 임시 경로에 쓴다. 코디네이터가
  `specs/LIFE-NNN-*/review-<도구>.md` 와 raw로 회수·커밋한다. 리뷰어는 git commit/add도, 구현자 파일 수정도 안 한다.
- 워커에게 작업 브랜치 기준·판정은 `git show <고정한_작업_commit>:specs/...`로 읽도록 지시한다.
  리뷰를 위해 제품을 먼저 머지하지 않는다.
- native advisor는 서버에서 워커의 대화를 받아 상담한다. 별도 구현자·독립 리뷰어로 세지 않고, 호출 시점·
  횟수는 모델이 정한다. 어려운 판단에서 상담하도록 지시하되 "1회 상한"이나 별도 advisor effort를 지원한다고 쓰지 않는다. 실제 상담 여부·
  실패/미사용은 워커 보고와 transcript로 확인한다. **advisor 조언 자체는 리뷰 지적이 아니다.**

## 2. 구현 워커(Opus + advisor) 기동 준비

corral `worker-start`가 `--advisor`를 직접 받고, pane 생성·`wait --for agent-ready`·preamble 주입까지
한 번에 묶는다. **별도 terminal create → worker-start --terminal 2단 경로를 쓰지 않는다.**

1. 킥오프 승인 후 작업 브랜치 HEAD에서 구현 브랜치와 형제 worktree를 만든다. 기존 것이면 재사용 여부부터 확인한다.
   corral task-start와 같은 git worktree 경로이고, corral에 repo setup/archive hook은 아직 없다(LIFE-412 전)
   — 기다릴 setup 단계가 없다는 뜻이며 준비 확인은 worktree 생성 결과로 한다.

```bash
# 본체 절대경로를 REPO_ROOT에, 현재 작업 브랜치를 TASK_BRANCH에 지정한 뒤 실행
git -C "$REPO_ROOT" worktree add "$REPO_ROOT/.claude/worktrees/${TASK_BRANCH}-claude" \
  -b "${TASK_BRANCH}-claude" "$TASK_BRANCH"
```

2. Run은 기존 것을 우선 사용하고 없을 때만 `corral orchestration run-create --objective "LIFE-NNN 구현" --json`
   으로 만든다. Run은 프로필 단위로 묶이므로 명시 선택이 필요한 문맥은 `--run <run_id>`를 쓴다
   (바인딩은 바뀌지 않는다). 구현 Task 발급은 §3이다.

worker-start가 만든 pane은 그 attempt가 **소유**하고, 사람이 `terminal create`로 만든 pane은 처음부터
`borrowed`라 corral이 닫지 않는다. 생성 handle/worktree/agent 정체와 종료 책임을 02-kickoff에 기록한다.
worker-release가 실제 프로세스를 닫았다고 가정하지 않는다.

## 3. 구현 Task 발급

```bash
corral orchestration task-create --spec "고정한 기준 commit을 읽고 구현·검증. 승인 범위/기준 유지. 네이티브 설치 경로에서 최소 1회 실행한 원자료 필수. 범위·기준 변경이 필요하면 ask. 제품·raw 커밋 후 worker_done 보고." --json
corral orchestration worker-start --task <implementation_task> \
  --agent claude --model claude-opus-5 --effort high --advisor fable \
  --worktree path:<구현 worktree 절대경로> --timeout-ms 120000 --json
```

`--terminal <handle>`(pane 재사용)과 `--agent … --worktree path:<절대경로>`(새로 기동)는 **하나만** 쓴다 —
재사용 pane은 기동 때의 agent를 그대로 쓰므로 `--model`·`--effort`·`--advisor`·`--worktree`가 거절된다.
요약이 아니라 `stages`·`launch`(`created`/`reused`/`resumed`)를 읽고 기록한다. 실패한 단계는 앞 단계를
되돌리지 않고 `residualResources`에 남긴다. **`--retry-of`류 플래그는 없다** — 복구는 2단이다:
`terminal read`로 화면을 보고 차단 화면(승인·업데이트)이면 `terminal send`로 정리한 뒤(trust는 사람 몫)
같은 Task에 `worker-start --task <t> --terminal <handle>`을 다시 부른다. 주입이 확정되지 않은
attempt(`dispatch_input_unconfirmed` = `promptRequestId: null`)는 같은 Dispatch로 재개되고(`launch: resumed`), 이미 주입된
attempt가 열려 있으면 `dispatch_active`로 거절된다. `reused`는 열린 attempt가 없어 **시작 가능한** Task에
기존 pane을 배정한 새 attempt다. `dispatch_input_unprovable`은 재개로 수렴하지 않으니 사람이 pane을 읽고
`worker-stop`으로 끝낸다. 새 Task/Dispatch와 `worker.promptRequestId`를 저장한다.
retain은 보존 의사 기록이며 새 Task 배정이 아니다. 재사용 실패·세션 종료·사용자 takeover면 상태를 확인하고
새 세션에 진행 증거를 인계한다 — 새로 기동했다면 동일 세션으로 재개했다고 쓰지 않는다.

구현 완료 후 수정 가능성을 위해 동일 워커를 유지하는 요청도 기록하고 retain한다.
**코드 리뷰는 3자 각각 새 세션**에서 고정 구현 commit을 본다 — Astra xhigh, 별도 Claude Opus high,
별도 Grok. 리뷰 완료 후 수정 Task는 위와 같은 재사용 경로이고, **재리뷰는 새 리뷰 세션으로 기동한다.**
코드 수정은 최대 3회에 누적한다. 미수렴 시 사용자 보고.
진행 중 구현 Task에서 승인 범위·기준을 바꿔야 하면 워커는 근거를 커밋하고 ask로 대기한다.
아직 실행 중인 구현 Dispatch 위에 같은 terminal의 새 Dispatch를 겹쳐 기동하지 않는다.

경쟁 구현이면 Codex 측은 **모델·effort를 명령에 명시한다**:
`worker-start --agent codex --model gpt-6-astra --effort high --worktree path:<절대경로>`. 없으면 세션 기본을 탄다.
Codex 워커는 Claude보다 느리고 타임아웃이 잦으므로 대기 예산을 넉넉히 잡는다.

## 4. 완료·취소 후 정리

- 끝난 모든 Dispatch의 release 결과를 확인한다. failed 완료도 정리 대상이다.
- 사람이 만든 pane은 `borrowed` 사유로 retained다. 원자료를 회수한 뒤 terminal show/worker-show로 기록된
  handle·worktree·agent 정체, 활성 Dispatch 없음, 사용자 takeover 없음, 이번 작업 전용임을 확인한 경우에만
  `terminal close --terminal <handle>`로 정리한다. 불확실하면 보존하고 차단 사유를 보고한다. `release.state:
  unknown`을 두 번째 close로 우회하지 않는다.
- 재사용된 옛 Dispatch의 release로 현재 워커가 정리됐다고 가정하지 않는다. 최종 Dispatch와 실제 소유권을 확인한다.
- 사용자 확인용 worktree는 출고 승인까지 유지한다. terminal 유지와 worktree 유지의 수명은 다르다.
- 역할별 사용량은 도구가 제공하는 값만 기록한다. 제공되지 않는 토큰·비용·절감률을 추정해 실측으로 보고하지 않는다.
