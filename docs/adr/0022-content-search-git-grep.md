---
status: accepted
date: 2026-11-20
decision-makers: 코디네이터(게이트 ⓪ 위임) · 사용자(출고 회고 채택)
---

# 내용 전체 검색은 동봉 ripgrep 대신 git grep 으로 하고, 강조 위치는 줄 원문에서 정한다

## Context and Problem Statement

활성 worktree 의 파일 내용을 찾는 ⌘⇧F 검색(LIFE-803)에 백엔드가 필요했다. 설치본에는 ripgrep 이 없고, 파일 목록은 이미 `git ls-files` 를 쓴다. 강조(한 줄 안 일치 위치)를 어디서 얻을지도 정해야 했다.

## Decision Drivers

* 설치본에 새 바이너리를 싣는 비용(동봉·영수증·서명·아키텍처)
* ⌘P 와 같은 파일 집합(추적 + 미추적, ignore·바이너리 제외)
* 잘못된 자리 강조 금지 — 모르면 칠하지 않는다
* 설치본 프로세스 env 에 로캘이 없다(C 로캘)

## Considered Options

* ripgrep 동봉(`--json` 의 일치별 바이트 오프셋)
* git grep — 위치를 `-o --column` 으로
* git grep — 줄·첫 열만 git 에서, 줄 안 위치는 원문 훑기

## Decision Outcome

Chosen option: "git grep — 줄·첫 열만 git 에서, 줄 안 위치는 원문 훑기", because git 은 이미 필수 의존이라 동봉 비용이 0 이고 범위가 ⌘P 와 같으며, `-o --column` 의 열은 둘째 일치부터 실제 시작이 아니고 윈도 시작에서 앞 문맥을 못 봐 가짜 일치를 내기 때문이다(git 2.50.1 실측).

### Consequences

* Good, because 새 바이너리·의존성 0, 이 레포 규모에서 수십~수백 ms.
* Good, because 리터럴·단어 단위 강조는 git 열 공식에 의존하지 않아 git 버전이 바뀌어도 위치가 틀리지 않는다.
* Bad, because 정규식 모드는 한 줄의 첫 일치만 강조한다(둘째 이후는 「모름」·「N+」).
* Bad, because git 자식 env 에 UTF-8 로캘을 명시해야 한다(설치본 env 에 없음).
* Bad, because 대소문자 무시 검색은 후보 글을 얻으려 git 을 두 번 띄운다.

## More Information

LIFE-803 00-analysis §3 스파이크, 리뷰 r1 R1-01·R1-05, r2 R2-01·R2-03.
