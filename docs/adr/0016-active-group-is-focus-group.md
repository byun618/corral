---
status: accepted
date: 2026-11-17
decision-makers: 사용자(게이트 ⓪·①), 작업 코디네이터
---

# 활성 영역은 포커스 영역이다 — 영역 간 포커스 이동은 한 길로, 늦은 적용은 목적지 감시로 막는다

## Context and Problem Statement

탭 영역(분할된 탭 그룹)이 여럿일 때 「활성 영역」(⌘W·안 읽음·herdr seen 이 따르는 상태)과 실제 키보드 포커스가 따로 움직였다. 파일 탭 클릭·worktree 복귀·⌃Tab 등은 활성 영역만 바꾸거나 포커스만 옮겨, ⌘W 가 보고 있지 않은 영역의 탭을 닫는 일이 생길 수 있었다(LIFE-824). 영역을 넘는 키(⌘⌥방향·⌃`·이전/다음 탭)를 들이면서 이 둘을 어떻게 묶을지 정해야 했다.

## Decision Drivers

* ⌘W·안 읽음·herdr seen 등 활성 영역 소비자가 사용자가 보는 곳과 어긋나면 안 된다
* 포커스 대상이 비동기로 붙는다(Monaco 편집기·파일 로딩·herdr pane 이웃 조회) — 늦게 붙은 대상이 그 사이 사용자 이동을 덮으면 안 된다
* 렌더러만으로 풀고 preload·IPC·배치 저장 형식을 바꾸지 않는다

## Considered Options

* 활성 영역과 포커스를 독립 상태로 두고 소비자마다 둘 중 하나를 고른다(base 상태)
* 활성 영역을 DOM `focusin` 에서 파생한다
* 모든 사용자 포커스 이동을 한 함수(`focusGroupTab`)로 모아 활성 영역과 포커스를 함께 옮기고, 늦은 적용은 포커스 순번 + 목적지 감시로 버린다

## Decision Outcome

Chosen option: "한 함수로 모으고 순번 + 목적지 감시", because 활성 영역을 어떤 소비자가 읽어도 포커스와 같고, 비동기 대기 뒤 적용을 한 자리에서 막을 수 있기 때문이다.

### Consequences

* Good, because 영역을 넘는 키·탭 클릭·worktree 복귀·⌃Tab·팔레트 뒤 ⌘W 가 늘 포커스 영역을 닫는다
* Good, because 순번을 안 올리는 프로그램 이동(CLI 요청 이동·닫기 따라가기)도 목적지 감시가 받는다 — 경로를 하나씩 막지 않는다
* Bad, because 한 함수를 거치지 않는 base 경로(비활성 영역 탭 우클릭 → 활성만 이동)는 여전히 어긋난다 — LIFE-825·백로그
* Bad, because ⌘⌥방향은 줄 상한 2 로 아주 빠른 연타의 셋째부터 버린다(경합 방지의 대가)

### Confirmation

App 시험(`App.group-focus.test.mjs` — 경로별 포커스 영역 = 활성 영역, 늦은 편집기 포커스 거절) · 순수 함수 시험(`group-focus.l824.test.ts`) · 격리 GUI 관측에서 각 진입 경로 뒤 `document.activeElement` 영역 = `activeGroupId` · 새 포커스 경로를 넣는 리뷰에서 `focusGroupTab` 경유 여부를 본다.

## Pros and Cons of the Options

### 독립 상태(base)

* Good, because 변경이 없다
* Bad, because 소비자마다 어긋남을 따로 다뤄야 하고 ⌘W 가 보이지 않는 영역을 닫을 수 있다

### `focusin` 파생

* Good, because 어떤 경로든 포커스만 옮기면 활성 영역이 따라온다
* Bad, because 포커스가 창 밖·body 로 빠질 때(대화 상자·⌘W 직후) 활성 영역이 흔들리고, 비동기 포커스 대상이 늦게 붙으면 활성 영역까지 덮는다

### 한 함수 + 순번 + 목적지 감시

* Good, because 활성 영역 변경과 포커스가 한 자리에서 같이 일어나 시험·리뷰 대상이 하나다
* Bad, because 새 포커스 경로가 그 함수를 거치지 않으면 다시 어긋난다 — 리뷰에서 지켜야 한다

## More Information

LIFE-824(이 결정) · LIFE-825(영역 최대화·닫기 뒤 활성 이동 — 이 표지·영역 MRU 를 쓴다) · LIFE-823(옆으로 열기 이웃 고르기 — 영역 MRU 로 바꿀 수 있는 자리). 우클릭 경로를 정리할 때 다시 본다.
