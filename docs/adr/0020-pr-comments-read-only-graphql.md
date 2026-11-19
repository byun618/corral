---
status: accepted
date: 2026-11-19
decision-makers: 코디(게이트 ⓪ 위임 결정), 사용자(게이트 ① 채택)
---

# PR 리뷰 코멘트는 gh 의 읽기 전용 GraphQL query 하나로, 보기가 보일 때만 읽는다

## Context and Problem Statement

앱은 `gh` 로 PR 상태만 읽었고, 리뷰 코멘트는 GitHub 웹에서 봐야 했다(LIFE-811). 코멘트는 세 출처(리뷰 본문·줄 코멘트 스레드·일반 코멘트)에 흩어져 있고, 해소·outdated·숨김 상태는 REST 로는 여러 호출을 합쳐야 나온다. 앱 안에서 이것을 어떤 호출로, 언제, 얼마나 읽을 것인가.

## Decision Drivers

* 앱은 GitHub 에 쓰지 않는다 — 답글·해소·머지는 범위 밖이고, 실수로라도 쓰는 경로가 없어야 한다.
* 보이지 않는 화면이 gh 를 부르지 않는다(LIFE-624 의 갱신 원칙) — 상시 폴링은 알림 일감(LIFE-514) 몫.
* 기존 `PrStatus` 의 gh 고르기(Finder PATH)·캐시·동시 상한·오류 분류를 다시 만들지 않는다.
* 「없다」(PR 없음·코멘트 0건)와 「못 본다」(gh 없음·미인증·실패)를 화면에서 가른다.

## Considered Options

* `gh api graphql` query 하나(세 출처 + 해소·outdated·숨김을 한 번에)
* `gh pr view --json comments,reviews` + REST 리뷰 코멘트 호출
* 주기 폴링으로 미리 읽어 두기

## Decision Outcome

Chosen option: "`gh api graphql` query 하나", because 세 출처와 스레드 상태를 한 번(1점)에 받고, 인자 모양을 `api graphql --hostname github.com -f owner -f name -F n -f query` 로 고정해 mutation·`-X`·`--method` 가 없음을 리터럴로 단언할 수 있다. 조회 대상은 지금 트리의 worktree 경로 → 브랜치 → PR URL 에서만 풀고, 보기가 보일 때·대상(경로 + 브랜치)이 바뀔 때·새로고침 단추에서만 읽는다. 목록마다 최근 100건·스레드당 답글 50, 넘치면 「N건 더 — GitHub 에서 보기」.

### Consequences

* Good, because 쓰기 경로가 구조적으로 없고, 시험이 인자 배열 전체를 리터럴로 고정한다.
* Good, because 기존 `PrStatus` 의 캐시·동시 상한을 같이 써서 gh 호출 수가 PR 칩과 합쳐 관리된다.
* Bad, because 100건을 넘는 PR 은 앱에서 다 볼 수 없다 — 페이지 넘김은 넣지 않았다.
* Bad, because query 응답 모양이 GitHub 스키마에 묶인다 — 모르는 모양은 「못 읽음」 으로 닫혀(fail-closed) 화면이 비고, 고치려면 앱 갱신이 필요하다.
* Bad, because 큰 PR 응답(실측 200 KB 대)을 받으려고 코멘트 query 만 출력 상한을 8 MiB 로 따로 둔다.

### Confirmation

`app/src/main/pr-comments.test.ts` 의 인자 리터럴 단언과 변이 양성 대조(`mutation(`·`-X POST` 를 넣으면 그 사유로 실패). 이 영역을 바꾸는 일감은 실제 gh 실행의 인자 기록에서 쓰기 인자 0 을 다시 본다.

## Pros and Cons of the Options

### `gh pr view --json` + REST

* Good, because `gh` 의 고수준 명령이라 query 문자열을 들고 다니지 않는다.
* Bad, because 스레드 해소·outdated 를 한 번에 주지 않아 호출이 늘고, REST 경로는 `--method` 를 바꿔 쓰기로 넘어가기 쉽다.

### 주기 폴링

* Good, because 열자마자 최신이 보인다.
* Bad, because 보이지 않는 화면이 gh·rate limit 을 쓴다 — LIFE-624 원칙과 어긋나고 LIFE-514 와 겹친다.

## More Information

LIFE-811(이 결정) · LIFE-624(PR 상태 조회·갱신 원칙) · LIFE-514(CI checks·알림 — 같은 gh 경로를 쓸 때 이 ADR 의 쓰기 금지·보일 때만 원칙을 따른다). 다시 볼 조건: 앱에서 답글·해소 같은 쓰기를 넣기로 할 때, 또는 100건 상한이 실사용에서 모자랄 때.
