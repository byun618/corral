---
status: accepted
date: 2026-11-24
decision-makers: 코디네이터(게이트 ⓪ 사용자 승인) · 사용자(출고 회고 채택)
---

# 데스크톱에서 에이전트 pane 으로 글을 넣을 때 폰 지시 허브를 전용 인스턴스로 재사용하고, 고정 리드 한 줄 뒤에 본문을 붙인다

## Context and Problem Statement

diff 줄 메모를 모아 에이전트 pane 에 보내는 기능(LIFE-832)은 렌더러에서 에이전트 pane 으로 글을 넣는 첫 데스크톱 경로다. 넣은 글이 「정말 한 번 들어갔는지」 증명해야 하고, 사람이 그 pane 에 쓰던 글을 덮거나 끼어들면 안 된다.

## Decision Drivers

* 들어감 증명 — 「썼다」가 아니라 provider 세션 기록에 그 글이 정확히 한 번
* 사람 입력과의 경합(쓰던 초안·리드와 본문 사이 키)·대상 바뀜을 막는 울타리
* 폰 지시 경로와 수명·상태를 섞지 않기
* claude 가 여러 줄 붙여넣기를 포장해 기록하는 방식, provider 의 입력 변환(탭·비가시 문자)

## Considered Options

* raw PTY 입력(`termInput`)
* CLI `terminal prompt`
* 폰 지시 허브(InputHub)를 데스크톱 전용 인스턴스로 재사용 + 리드 한 줄

## Decision Outcome

Chosen option: "InputHub 데스크톱 전용 인스턴스 + 리드 한 줄", because 접수 때 대상 묶기·준비 관문·맥 입력 울타리·기록 매칭(정확히 1건)을 이미 갖췄고, 인스턴스를 나누면 폰 수명과 섞이지 않는다. claude 가 붙여넣기만의 메시지를 포장해 대조가 안 되므로, 허브 울타리 사슬 안에서 고정 리드 한 줄을 먼저 치고 본문을 붙여 넣으며, 대조는 경로별 lead 인자로 그 모양만 센다(lead 없는 기존 경로 규칙은 그대로). 본문에서 provider 가 바꾸거나 지우는 글자(탭·비가시 문자)는 보이는 이스케이프로 남기지 않는다.

### Consequences

* Good, because 「들어감」이 기록 대조로 증명되고, 초안·끼어듦·pane 사라짐이 각각 다른 실패 사유로 드러난다
* Good, because 폰 허브 코드는 바뀌지 않고 선택 의존성(lead)만 늘었다
* Bad, because provider 기록 형식(포장·변환)에 묶인다 — provider 판이 바뀌면 대조가 「확인 못 함」 으로 기울 수 있다(안전 방향)
* Bad, because 리드 한 줄이 에이전트 대화에 늘 같이 보인다

### Confirmation

provider 실기록 배달 오라클(claude·codex·grok 각 1회 이상 정확히 1건) · 리드 전후 상태 시퀀스 불변 실측 · 설치본 사람 손 관문(초안 상태 거절 포함).

## Pros and Cons of the Options

### raw PTY 입력

* Good, because 가장 단순하다
* Bad, because 들어감 증명·울타리가 없다

### CLI `terminal prompt`

* Good, because 오케스트레이션과 같은 경로
* Bad, because 에이전트 기록(AgentRecord)이 있는 pane 만 받아 GUI 로 띄운 pane 은 거절된다

## More Information

LIFE-832(구현·관문), LIFE-582·598·709(폰 지시 허브), LIFE-836(폰 경로의 같은 부류 문제 — 리드 없는 여러 줄·비가시 문자). 다시 볼 조건: provider 의 붙여넣기 기록 형식이 바뀔 때, 데스크톱에서 pane 으로 넣는 두 번째 기능이 생길 때.
