---
status: accepted
date: 2026-11-13
decision-makers: 사용자(게이트 ⓪ 안 A 승인) · LIFE-787 코디
---

# 런타임은 provider 화면을 거절하는 방향으로만 읽는다

## Context and Problem Statement

corral 런타임은 「provider 화면을 파싱하지 않는다 — 준비 여부는 herdr 상태 기계, 배달은 세션 기록으로 본다」를 원칙으로 두었다. 그런데 Claude pane 이 agent view(빈 프롬프트에서 `←`)인 동안 herdr 는 그 화면을 일반 입력 대기(`idle`)로 읽어서, `terminal prompt`·`worker-start` 본문이 새 백그라운드 세션으로 들어갔다(LIFE-787, 770 실측). herdr 상태·세션 기록만으로는 이 화면을 가릴 수 없다.

## Decision Drivers

* 본문이 다른 세션(사용자 기본 권한)으로 들어가는 것은 되돌릴 수 없다 — 쓰기 전에 막아야 한다.
* herdr 상태·제목 외에 「이 PTY 가 agent view 다」를 알리는 공식 신호(플래그·필드·hook)가 없다.
* 폰 경로(770)가 이미 같은 화면을 실표본으로 판별한다 — 두 벌을 두지 않는다.
* 화면 판별이 틀릴 때의 비용이 한쪽으로만 나야 한다 — 준비·배달 판정에 화면을 쓰면 오판이 「넣었다」 쪽으로 난다.
* guard·herdr 패치 없이 해야 한다.

## Considered Options

* A: 폰의 화면 판별을 재사용하고 탭 제목(`claude agents`)을 더해, 둘 중 하나면 쓰기 전에 거절한다. 원칙은 「거절 방향으로만 읽는다」로 고친다
* B: 탭 제목만 본다(화면 파싱 원칙 유지)
* C: `leftArrowOpensAgents: false`·`disableAgentView` 로 agent view 자체를 막는다

## Decision Outcome

Chosen option: "A", because 제목을 끈 환경에서도 화면 표지로 막고, 폰과 판별이 한 벌이며, 화면을 읽은 결과는 「거절한다」로만 쓰여 오판이 넣지 않는 쪽으로만 난다.

### Consequences

* Good, because agent view pane 에 본문·리드 줄이 쓰이지 않는다 — 거절은 `agent_view`·`not_started` 이고 요청 id 를 쓰지 않아 `esc` 뒤 같은 요청으로 다시 할 수 있다.
* Good, because 판정 화면은 입력이 폰과 같은 quiet 시간만큼 조용할 때만 믿고, 판정 뒤 들어온 키는 guard 의 입력 revision 울타리가 `input_changed` 로 거절한다.
* Bad, because 런타임이 provider 화면 문구(2.1.296 실표본)에 의존한다 — 판 올림에서 표지가 바뀌면 화면·제목 둘 다 놓칠 수 있다(놓치면 예전 동작).
* Bad, because 세션 이름이 정확히 `claude agents` 인 대화는 `esc` 로도 풀리지 않고 계속 거절된다.
* Bad, because 다시 그리기가 quiet 시간보다 늦은 환경, 제목을 끈 환경에서 화면 판별이 원래 놓치는 좁은 화면은 열린 채다.

### Confirmation

`app/src/runtime/terminal/agent.ts` 머리 주석의 원칙 문구와 `app/cli/README.md` 원칙 문단이 같은 뜻인지 리뷰에서 본다. 화면을 읽는 새 코드가 준비·배달·입력줄 비었음 판정에 쓰이면 이 결정을 다시 연다. Claude Code 판을 올릴 때 agent view 실표본(fixture)을 다시 떠서 판별 시험을 돌린다.

## Pros and Cons of the Options

### A

* Good, because 제목을 꺼도 화면 표지가 남는다.
* Good, because 폰과 판별이 한 벌이다.
* Bad, because 원칙 문구를 고쳐야 하고 화면 문구 의존이 생긴다.

### B

* Good, because 화면 파싱 원칙을 그대로 지킨다.
* Bad, because `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` 이면 agent view 목록이 제목을 쓰지 않아 막지 못한다.
* Bad, because 폰과 판별이 두 벌이 된다.

### C

* Good, because 화면을 읽을 필요가 없다.
* Bad, because `leftArrowOpensAgents` 는 사용자 전역 설정이라 corral 이 pane 마다 줄 수 없다.
* Bad, because `disableAgentView` 는 `/bg` 까지 꺼서 769·771·772 가 기대는 백그라운드 전환을 막는다.

## More Information

LIFE-770(폰 경로 판별) · LIFE-787 · LIFE-797(거절 뒤 빈 대화 재개 `outcome_unknown`). 공식 신호(플래그·JSON 필드·hook)가 생기면 화면 판별을 그것으로 바꾸고 이 결정을 대체한다.
