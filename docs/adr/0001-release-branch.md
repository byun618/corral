---
status: accepted
date: 2026-10-27
decision-makers: 사용자(레포 소유자)
---

# 출고는 release 브랜치에 PR 을 모아 통합 확인한 뒤 main 에 머지한다

## Context and Problem Statement

출고 때마다 열린 PR 을 main 에 하나씩 머지하고 태그를 찍어 왔다. 여러 PR 을 함께 내보낼 때 합친 상태를 확인할 자리가 없고, main 에 확인 안 된 조합이 먼저 올라갔다(LIFE-703).

## Decision Drivers

* 합친 결과를 출고 전에 한 곳에서 실행·확인한다
* main 반영은 PR 머지로만, 직접 push 는 태그뿐
* 1인 레포 — 장기 브랜치(develop)를 유지할 여력이 없다
* 브랜치 보호가 없는 Free 플랜 private 레포라 규약·스크립트 가드로 막아야 한다

## Considered Options

* Git Flow(release → main + develop)
* Trunk-based(release 용 브랜치는 되돌려 합치지 않고 cherry-pick)
* 모바일 release train(main 에서 주기적으로 자르기·동결·feature flag)
* Git Flow 에서 develop 을 뺀 release 브랜치(출고 1회 수명)

## Decision Outcome

Chosen option: "develop 을 뺀 release 브랜치", because 합친 결과의 확인 자리를 주면서 장기 브랜치를 늘리지 않는다.

### Consequences

* Good, because 출고 집합이 release 브랜치 기록(`Release-PR:` 줄)으로 고정되고 ship 이 다시 고르지 않는다
* Good, because 회고 커밋(learnings·ADR 채택)을 실을 자리가 생긴다(LIFE-704)
* Bad, because 원래 PR 의 MERGED 는 기본 브랜치 간접 머지를 가정한다 — 확인 안 되면 exit 13
* Bad, because 출고 중 수정은 일감 브랜치에서 고쳐 다시 모아야 한다(동결)

### Confirmation

`app/scripts/l703/release-test.sh`·`mutate.sh`(가드 변이 쌍)·`app/scripts/l704/retro-test.sh`, release 스킬 순서.

## Pros and Cons of the Options

### Trunk-based

* Good, because 브랜치가 가장 적다
* Bad, because cherry-pick 출고는 합친 상태 확인 자리가 없다

### 모바일 release train

* Good, because 주기가 예측된다
* Bad, because 1인 레포에 주기·flag 운영 비용이 크다

## More Information

LIFE-703(결정·구현), LIFE-704(회고 자리). 다시 볼 조건: PR CI(LIFE-575)가 생겨 통합 확인을 CI 가 대신할 때.
