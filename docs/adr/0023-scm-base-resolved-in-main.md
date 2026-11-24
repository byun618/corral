---
status: accepted
date: 2026-11-24
decision-makers: 코디네이터(게이트 ⓪ 사용자 승인) · 사용자(출고 회고 채택)
---

# 소스 제어 base 대비 비교는 main 이 base 를 풀고, 렌더러는 닫힌 side 값만 보낸다

## Context and Problem Statement

소스 제어 보기에 「base 대비」 비교(merge-base ↔ 작업 트리)를 더했다(LIFE-830). 지금까지 읽기 IPC 는 「렌더러는 ref 를 고를 수 없다」 를 보안 경계로 두었다(argv 고정, side 두 값). base 를 어디서 정하고 그 경계를 어떻게 지키나, base 를 무엇으로 정하나를 정해야 했다.

## Decision Drivers

* 렌더러가 git argv 에 문자열을 실을 길을 열지 않는다(옵션 주입·임의 ref 읽기)
* 에이전트가 커밋까지 끝낸 worktree 를 「부모 대비」 로 리뷰하는 흐름 — 계보가 이미 레지스트리에 있다
* git config·레지스트리에 쓰지 않는다(보기만으로 사용자 상태가 바뀌면 안 된다)
* 새 폴링 없이 기존 탐색기 갱신 신호만

## Considered Options

* 렌더러가 base ref 를 골라 보낸다(base 고르기 UI)
* main 이 정해진 순서로 base 를 풀고, 렌더러는 닫힌 side(`head|index|base`)와 모드 켜기만 보낸다
* PR base·upstream·fork-point 를 base 로 쓴다

## Decision Outcome

Chosen option: "main 이 정해진 순서로 base 를 풀고, 렌더러는 닫힌 side 만", because 경계 규칙(렌더러 문자열이 argv 에 들어가지 않음)을 그대로 지키면서 계보 기반 리뷰 흐름을 덮는다. 순서는 ① 같은 레포의 부모 worktree 브랜치(분리면 그 커밋) ② `repo.baseRef` ③ `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`, 커밋으로 풀리는 첫 것. 비교 목록은 merge-base ↔ 작업 트리 + 추적 안 함 한 목록.

### Consequences

* Good, because argv 는 고정 문자열 + hex oid + 레지스트리·기본 브랜치에서 읽은 ref 이름(`--end-of-options` 뒤, `^{commit}` 검증)뿐이고 시험이 고정한다. `--no-optional-locks` 로 쓰기 0.
* Good, because base 모드가 아닐 때 git 추가 0, 렌더러 reload·크래시에서 모드가 풀린다.
* Bad, because 사용자가 임의 base 를 고를 수 없다 — 바꾸려면 `corral worktree set --parent-worktree` 나 `corral repo set-base-ref` 로 레지스트리를 고쳐야 한다.
* Bad, because 다른 레포의 worktree 를 부모로 적어 두면 ① 을 건너뛴다(같은 이름 브랜치 오인을 막으려는 것).

### Confirmation

`scm-base.test.ts`(argv 고정·옵션 모양 ref·다른 레포 부모) · `explorer-hub.base.test.ts`(모드 아닐 때 git 0·reload 해제·두 push 순서).

## Pros and Cons of the Options

### 렌더러가 base ref 를 골라 보낸다

* Good, because 임의 비교가 된다
* Bad, because 읽기 IPC 경계를 문자열 검증으로 옮겨야 하고, 게이트 ⓪ 에서 고르기 UI 는 「넣지 않음」 으로 정했다

### PR base·upstream·fork-point

* Good, because PR 이 있으면 리뷰 대상과 정확히 맞는다
* Bad, because 네트워크·reflog 에 기대고 PR 전 worktree 에서 비고, fork-point 는 reflog 만료로 흔들린다

## More Information

LIFE-830(구현), LIFE-829(쓰기 단추 — base 모드에서 숨김, `ScmApi.compare` 를 읽는다), LIFE-832(줄 메모 — 이 base diff 위). 다시 볼 조건: base 고르기 UI 요구가 생기면.
