---
status: accepted
date: 2026-10-28
decision-makers: 사용자(레포 소유자)
---

# 일감 전용 관문 스크립트는 작업 폴더에 두고, 코드 레포에는 되풀이하는 시험·도구만 하는 일 이름으로 둔다

## Context and Problem Statement

일감마다 판정용 관문 스크립트를 코드 레포 `app/scripts/l<번호>/` 에 커밋해 왔다. 공개 전 시점에 90폴더·1250파일이 쌓였고, 외부에는 번호 의미가 없으며, 대부분은 그 일감 판정에만 쓰였다(LIFE-717). 작업 산출물을 레포 밖에 두기로 한 결정(ADR-0002)이 스크립트에는 아직 적용되지 않았다. 정리 뒤에도 다시 쌓이지 않게 하려면 앞으로 관문 스크립트를 어디에 두어야 하는가.

## Decision Drivers

* 공개 레포에 일감 단위 하네스가 쌓이지 않을 것
* 과거 판정을 다시 돌릴 수 있을 것(재현성)
* 워커가 앱 소스·의존성을 쓰는 스크립트를 무리 없이 쓸 수 있을 것
* 절차 단계를 늘리지 않을 것

## Considered Options

* 작업 폴더 `scripts/` 가 원본 — 레포에 커밋하지 않고, worktree 경로를 인자로 받는다
* 구현 브랜치에 지금처럼 쓰고, 게이트 ② 정리 때 작업 폴더로 옮겨 레포에서 지운다
* 관례는 그대로 두고, 공개 전 1회만 정리한다

## Decision Outcome

Chosen option: "작업 폴더 `scripts/` 가 원본", because 원본이 한 곳이고, 공개 레포 이력에 새로 쌓이지 않으며, 절차에 단계를 더하지 않는다.

### Consequences

* Good, because 레포에는 `npm test`·규칙·문서 절차가 실제로 부르는 시험·도구만 남는다(검사 대상 옆, 또는 `app/scripts/<하는 일>/`, 경로에 일감 번호 없음)
* Good, because 옛 하네스도 같은 자리(`LIFE-<번호>-*/scripts/<원래 폴더명>/`)에 있어 한 곳에서 찾는다. 돌리는 커밋은 색인에 있다
* Bad, because 관문 스크립트가 앱 소스·의존성을 상대 import 로 쓸 수 없다 — worktree 절대경로 기준 `pathToFileURL` import, `createRequire`, `node --import tsx` 로 돌린다
* Bad, because 옮긴 옛 스크립트는 작업 폴더에서 바로 돌지 않는다 — 그 시점 커밋의 worktree 에서 돌린다

### Confirmation

`.agents/skills/task-coordinate/references/implementation.md` §1 의 관례 줄과 `.agents/agents/reviewer.md` 의 리뷰 대상 줄. 코드 리뷰가 `app/scripts/` 아래 일감 번호 경로가 새로 생기는지 본다.

## Pros and Cons of the Options

### 작업 폴더 `scripts/` 가 원본

* Good, because 원본이 하나다
* Bad, because 스크립트 쓰는 법이 조금 바뀐다(절대경로 기준 import)

### 브랜치에서 쓰고 게이트 ② 에 옮김

* Good, because 워커가 지금처럼 상대 import 를 쓴다
* Bad, because 정리 단계가 늘고, 머지된 이력에는 계속 쌓인다

### 관례 유지, 1회 정리

* Good, because 바꿀 것이 없다
* Bad, because 다음 일감부터 다시 쌓인다
