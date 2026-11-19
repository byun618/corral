---
status: accepted
date: 2026-11-19
decision-makers: 코디네이터(게이트 ⓪ 위임) · 사용자(게이트 ① 채택·범위 수용)
---

# 터미널 검색은 herdr 서버측 검색으로 하고, 범위는 herdr 스크롤백이다

## Context and Problem Statement

렌더러 xterm 은 scrollback 0 으로 뷰포트만 그리고 스크롤백은 herdr 가 쥔다. 그래서 xterm search addon 으로는 화면 밖을 찾을 수 없다. 터미널 화면 내 검색(LIFE-812)을 어디서 하고 무엇을 범위로 할지 정해야 했다.

## Decision Drivers

* 스크롤백의 진실은 herdr 에 있다 — 렌더러에 사본을 두면 크기·동기화 비용이 든다.
* herdr `pane.read` 의 최근 행 읽기는 서버에서 1000행으로 잘린다.
* 출력이 흐르는 중에도 결과 좌표가 어긋나지 않아야 한다.
* 자체 터미널 데몬(LIFE-674)을 기다리지 않는다.

## Considered Options

* herdr `pane.copy_search`(서버측, 스크롤백 전체) + `pane.scroll` 이동 + 렌더러 강조층
* `pane.read` 로 최근 1000행을 받아 렌더러에서 검색
* 렌더러 xterm 에 스크롤백을 두고 search addon 사용

## Decision Outcome

Chosen option: "herdr `pane.copy_search` + `pane.scroll` + 렌더러 강조층", because 스크롤백 전체를 서버 한 곳에서 찾고, `content_revision` 으로 낡은 결과를 거절해 흐르는 출력에서도 좌표가 어긋나지 않는다.

### Consequences

* Good, because 1000행 상한 없이 스크롤백 전체를 찾고, 렌더러에 사본이 없다.
* Good, because 결과 개수·현재 위치가 서버에서 정확히 온다(일치 창 ≤1024, 총계는 정확).
* Bad, because 글자 그대로·smart-case 만 된다 — 정규식·단어 단위·대소문자 토글은 herdr 가 지원할 때까지 없다.
* Bad, because 초당 150행 이상 쉬지 않고 흐르는 pane 에서는 revision 이 계속 바뀌어 「출력이 계속 바뀌어 찾지 못했습니다」로 끝난다.
* Bad, because 에이전트 TUI pane(Claude Code 등)은 herdr 스크롤백을 남기지 않아 보이는 화면만 찾는다 — herdr 가 아니라 TUI 의 그리기 방식이라 LIFE-674 로도 풀리지 않는다. 사용자가 이 범위를 받았다(게이트 ①).
* alt-screen pane(`less` 등)은 그 화면만 찾는다.

### Confirmation

LIFE-812 판정 기준 C1(서버측 검색)·C7(흐르는 pane)과 G0 실호출 관문. herdr 버전을 올릴 때 `pane.copy_search` 광고·인자를 endpoint `assertMethod` 가 확인한다.

## Pros and Cons of the Options

### `pane.read` 최근 행 + 렌더러 검색

* Good, because herdr 쪽 계약이 단순하다.
* Bad, because 서버가 1000행으로 잘라 그 밖을 못 찾는다.

### 렌더러 xterm 스크롤백 + search addon

* Good, because addon 이 강조·이동을 다 준다.
* Bad, because 스크롤백 사본을 렌더러에 두고 herdr 와 맞춰야 한다 — 지금 구조(뷰포트만 그림)를 뒤집는다.

## More Information

LIFE-812(구현·판정), LIFE-674(자체 터미널 데몬 — 이 결정으로 착수 근거가 생기지 않았다). 다시 볼 조건: herdr 가 정규식 검색이나 revision 없는 검색을 제공할 때, 또는 에이전트 TUI 가 스크롤백을 남기게 될 때.
