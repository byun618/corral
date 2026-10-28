---
status: superseded by ADR-0006
date: 2026-10-28
decision-makers: 사용자(게이트 ⓪ 승인), 작업 코디네이터(제안)
---

# 묶음은 체크포인트 시작 때 띄운 묶음 코디가 분해부터 마무리까지 소유한다

## Context and Problem Statement

서로 의존하는 작업 묶음(feature 브랜치)의 시작·조율·마무리 주체가 정해져 있지 않았다. 규칙은 「묶음이 끝나면 마지막 자식의 코디가 묶음 확인·판정·feature → main PR」이었고, 체크포인트 자체를 시작하는 절차가 없어 본체가 자식을 먼저 띄우면 묶음 단위로 판단하는 세션이 없었다(LIFE-564·LIFE-706 에서 같은 누락 두 번, 정상 사례 LIFE-572). 출고 뒤 로컬 feature 브랜치·feature worktree 정리 담당도 없었다.

## Decision Drivers

* 「마지막 자식」이 누구인지 미리 모른다 — 묶음 중간에 자식이 붙는다(LIFE-564).
* 묶음 통합 확인·판정은 자식 하나의 범위를 넘는다.
* 자식 코디는 정리(`task-finish --into`) 뒤 세션이 없다 — 출고 중 수정을 받을 자리가 필요하다.
* 본체 세션은 매 세션 지도만 싣고 묶음 문맥을 쥐지 않는다.

## Considered Options

* 현행 유지 — 마지막 자식 코디가 마무리, 묶음 코디는 (있으면) 감독만
* 묶음 코디가 분해·자식 시작·조율·마무리 전부를 소유, 체크포인트 시작 때 feature 브랜치·worktree 와 함께 띄운다
* 본체가 묶음 마무리

## Decision Outcome

Chosen option: "묶음 코디가 전부 소유", because 묶음 단위 판단(분해 승인·통합 확인·출고 승인)을 쥔 세션이 하나로 고정되고, 「마지막 자식」 판별 문제가 사라지며, feature worktree 에 남은 묶음 코디가 출고 중 수정을 이어 받을 수 있다.

### Consequences

* Good, because 본체가 자식을 먼저 띄웠어도 체크포인트 시작 경로가 묶음 코디를 띄워 그 자식을 인계받는다 — 누락이 절차에서 막힌다.
* Good, because 자식 코디의 일은 작업 하나로 줄고(PR 원고 없음, feature 로 반영 직전 알림), 묶음 PR 원고·판정은 한 곳에서 나온다.
* Bad, because 묶음마다 세션 하나와 feature worktree 하나가 출고까지 산다 — 정리 단계(release 정리 절)가 하나 늘었다.
* Bad, because 묶음 코디 ↔ codex 자식 사이 통로가 비어 사람이 전달하는 방향이 있다.

### Confirmation

새 독자 리허설로 시나리오(체크포인트 시작·이미 시작된 자식·자식 하나/0·마무리·출고 중 수정·정리)를 매 수정마다 채점하고, 지도와 스킬의 어긋남은 리뷰·리허설 공통 항목으로 본다(LIFE-719).

## Pros and Cons of the Options

### 현행 유지

* Good, because 세션 수가 적다.
* Bad, because 마지막 자식을 미리 모르고, 자식 코디는 정리 뒤 세션이 없어 출고 중 수정 자리가 없다.

### 묶음 코디가 전부 소유

* Good, because 위 Consequences.
* Bad, because 위 Consequences.

### 본체가 묶음 마무리

* Good, because 새 역할이 필요 없다.
* Bad, because 본체는 묶음 문맥이 없고 동시에 여러 일감을 받는다 — 통합 확인·판정을 다시 모아야 한다.

## More Information

LIFE-564·LIFE-572·LIFE-706(사례), LIFE-719(절차 신설 — task-start 체크포인트 시작, task-coordinate references/bundle.md). 다시 볼 조건: 묶음 코디 세션 수명이 체크포인트 만료일을 자주 넘기거나, 자식이 하나뿐인 묶음이 대부분이 될 때.
