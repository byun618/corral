---
status: accepted
date: 2026-10-28
decision-makers: 사용자(v0.3.16 출고 회고 채택), 본체 세션(제안)
---

# 묶음 코디는 분해부터 묶음 PR 까지 소유하고, PR 직후 feature worktree 를 정리한다

## Context and Problem Statement

ADR-0005 는 묶음(feature 브랜치)을 체크포인트 시작 때 띄운 묶음 코디가 분해부터 마무리까지 소유한다고 정했고, 그 이유 하나로 「feature worktree 에 남은 묶음 코디가 출고 중 수정을 이어 받는다」를, 결과로 「묶음마다 세션 하나와 feature worktree 하나가 출고까지 산다」를 들었다. LIFE-724 가 묶음 정리 시점을 일반 작업과 같게 바꿨다 — 묶음 PR 을 연 직후 묶음 코디가 `task-finish.sh feature/LIFE-MMM-<슬러그>` 로 feature worktree·로컬 feature 브랜치를 정리하고, 출고 뒤 정리는 안전망 한 줄만 남는다. 0005 의 결정(묶음 코디 소유)은 그대로지만 그 이유·결과 문장이 사실과 어긋나 accepted 본문을 고칠 수 없으므로 이 ADR 이 대체한다.

## Decision Drivers

* 0005 의 동인은 그대로다 — 「마지막 자식」을 미리 모른다, 묶음 통합 확인·판정은 자식 하나의 범위를 넘는다, 본체는 묶음 문맥을 쥐지 않는다.
* 출고 승인 뒤 feature worktree 가 남으면 일반 작업과 달리 정리가 안 되고 손 정리에 기댄다(LIFE-706 에서 실제로 남았다).
* 출고 중 수정은 드물다 — 그때만 feature worktree 를 다시 열고 묶음 코디를 새로 띄우면 된다.

## Considered Options

* 0005 그대로 — 묶음 코디와 feature worktree 가 출고까지 산다, 출고 뒤 본체가 손으로 정리
* 묶음 코디가 묶음 PR 직후 스크립트로 정리, 출고 중 수정은 재기동

## Decision Outcome

Chosen option: "묶음 PR 직후 정리", because 묶음 단위 판단을 쥔 세션이 하나로 고정된다는 0005 의 이점은 PR 까지면 다 쓰이고, 정리가 일반 작업과 같은 자리(출고 승인 = PR 생성 직후)·같은 스크립트로 모여 남는 worktree 가 없어진다.

### Consequences

* Good, because 본체가 자식을 먼저 띄웠어도 체크포인트 시작 경로가 묶음 코디를 띄워 그 자식을 인계받는다(0005 와 같음).
* Good, because 묶음 PR 직후 feature worktree·로컬 feature 브랜치가 정리된다 — 출고 뒤 손 정리가 없고 release 마무리에는 안전망 한 줄만 남는다.
* Bad, because 출고 중 수정이 묶음 PR 에 필요하면 본체가 feature worktree 를 다시 열고 묶음 코디를 재기동해야 한다(task-coordinate references/bundle.md 6.5).
* Bad, because 정리 스크립트의 자식 판별이 첫 고유 커밋 전에 `push -u`·`--no-track` 으로 딴 자식을 못 센다 — 그 경우 묶음 코디가 `git worktree list` 로 직접 본다.
* Bad, because 묶음 코디 ↔ codex 자식 사이 통로가 비어 사람이 전달하는 방향이 있다(0005 와 같음).

### Confirmation

`scripts/task-finish-test.sh`(일회용 clone·가짜 원격, 56 케이스)가 묶음 경로의 정리·멈춤·멱등을 고정한다. 지우는 분기의 실재료 첫 사용은 다음 묶음의 handoff 에 출력 원문으로 남긴다(LIFE-724).

## Pros and Cons of the Options

### 0005 그대로

* Good, because 출고 중 수정을 같은 세션이 바로 받는다.
* Bad, because 출고 뒤 정리가 손 명령이고 담당이 흐려 남는다(LIFE-706).

### 묶음 PR 직후 정리

* Good, because 위 Consequences.
* Bad, because 위 Consequences.

## More Information

대체: ADR-0005. LIFE-724(정리 시점 변경 — `scripts/task-finish.sh`·`task-pr.sh`·bundle.md 6·release §7 4번), LIFE-719(묶음 절차 신설), LIFE-706(사례). 다시 볼 조건: 출고 중 수정 때문에 묶음 코디 재기동이 자주 생길 때.
