---
status: accepted
date: 2026-11-02
decision-makers: 사용자(게이트 ① 채택 승인), 코디(리뷰 r1 판정·구조 선택), 구현 워커(구현)
---

# herdr guard 는 입력 revision 을 둘로 낸다 — 초안 revision 은 마우스를 세지 않고, 모든 입력 revision 은 센다

## Context and Problem Statement

폰 지시는 맥 입력창에 쓰던 글과 합쳐지지 않도록 guard 의 사용자 입력 revision 으로 울타리를 친다. 이 revision 이 휠·클릭 같은 마우스 보고까지 세서, 맥에서 스크롤만 해도 지시가 실패했다(LIFE-708). 마우스를 빼면 같은 revision 으로 맥 클릭을 막던 질문 답 경로가 보호를 잃는다 — 답은 커서 상대 키라 클릭으로 선택이 옮겨지면 다른 답이 나간다(LIFE-708 리뷰). 한 revision 으로 두 소비자의 요구를 함께 맞출 수 있나?

## Decision Drivers

* 지시: 마우스는 입력줄에 글을 남기지 않으므로 지시를 막으면 안 된다.
* 답: 되돌릴 수 없는 제출이라 맥 클릭이 끼면 막아야 한다(base 동작 유지).
* provider 가 지금 클릭으로 선택을 옮기는지에 기대는 판단은 provider 업데이트로 다시 열린다.
* 옛 guard(필드 없음)와 섞여 돌아도 의미가 깨지지 않아야 한다.

## Considered Options

* 마우스를 그대로 센다(현상 유지)
* 마우스를 빼고, 답 경로는 provider 별 실측으로 클릭 영향이 없음을 보인다
* 두 값을 낸다 — 초안 revision(마우스 제외)과 모든 입력 revision(마우스 포함). 지시 경로는 초안, 답 경로는 모든 입력 값으로 울타리

## Decision Outcome

Chosen option: "두 값", because 소비자마다 필요한 의미가 달라 한 값으로는 하나를 깨고, provider 실측은 업데이트마다 다시 열리기 때문이다. 옛 guard 는 원래 마우스까지 세므로 모든 입력 값이 없을 때 초안 값으로 대체해도 의미가 같다.

### Consequences

* Good, because 맥 스크롤·클릭이 폰 지시를 막지 않고, 답 경로의 클릭 보호는 그대로다.
* Good, because guard 울타리(`expected_any_input_revision`)가 키를 쓰기 직전에 막아 경합 창이 없다.
* Bad, because guard 패치·허브에 값이 하나 늘고, 새 허브 + 옛 서버 / 옛 허브 + 새 서버 전환기에는 한쪽 의미가 옛 것으로 돈다(서버 재기동 뒤 정상).
* Bad, because provider 가 1003(any-motion)을 켜면 맥 포인터 이동만으로도 답이 막힌다(fail-closed, 의도).

### Confirmation

guard Rust 시험(마우스 보고는 초안 불변·모든 입력 +1, 모든 입력 울타리 거절), 허브 시험(답 경로 클릭 → `question_changed`, 지시는 같은 클릭에 전달), 변이 양성 대조. 실기기는 출고 통합 확인.

## Pros and Cons of the Options

### 마우스를 그대로 센다

* Good, because 변경이 없다.
* Bad, because 708 증상이 그대로다.

### 마우스를 빼고 답 경로는 실측으로

* Good, because 값이 하나다.
* Bad, because provider 업데이트마다 다시 증명해야 하고, 증명이 늦으면 잘못된 답이 나간다.

## More Information

LIFE-708(LIFE-709 포함). 다시 볼 조건: guard 가 입력줄 상태를 직접 내게 되면(화면 판별 대신) 초안 revision 의 역할을 재검토.
