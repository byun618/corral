---
status: accepted
date: 2026-11-12
decision-makers: 사용자(게이트 ⓪ 안 A 승인) · LIFE-772 코디
---

# corral 이 멈춘 herdr 를 띄우기 직전에만 `session.json` 의 claude 재개 참조를 고쳐 쓴다

## Context and Problem Statement

herdr 는 재시작 때 pane 의 claude 를 저장 참조 그대로 `claude --resume <id>` 로 재개한다. Claude Code 의 백그라운드 전환(`←`·`/bg`)은 새 세션 id 로 이어 쓰는데, herdr 교체 게이트는 `fork` 보고를 받지 않아 참조가 옛 id 에 머문다. 그래서 재시작 재개가 전환 시점에 멈춘 사본을 열고 그 뒤 입력이 옛 기록에 이어 써져 대화가 갈라진다(LIFE-772). herdr 는 corral 의 바닥 레이어이고, 지금까지 corral 은 herdr 영속 파일을 쓰지 않았다.

## Decision Drivers

* 재개가 전환 뒤 대화를 열어야 한다 — 대화 갈라짐은 되돌릴 수 없다.
* herdr 는 상주 쓰기 주체다 — 살아 있는 서버의 상태·파일을 corral 이 바꾸면 덮이거나 경합한다.
* herdr 패치는 상류 추적·digest 관리 비용이 크다.
* 판별은 폰 대화가 쓰는 766 이어 가기 규칙과 한 벌이어야 한다.
* 판별을 못 하면 지금 동작 그대로여야 한다(안전한 실패).

## Considered Options

* A: corral 이 멈춘 `default` 서버를 띄우기 직전(멈춤 확인 뒤·spawn 앞) `session.json` 의 claude 참조를 연쇄 끝 id 로 고쳐 쓴다
* B: herdr 패치 — 재개 때 참조를 따라간다
* C: 살아 있는 herdr 참조를 전환 즉시 바꾼다
* D: 재시작 뒤 경고만 띄운다
* E: 고치지 않고 닫는다
* F: herdr 교체 게이트에 `fork` 를 더한다(패치)

## Decision Outcome

Chosen option: "A", because 쓰기 주체(herdr)가 없는 유일한 순간에 값 하나만 바꾸고, 766 판별을 그대로 쓰며, 판별 실패·쓰기 실패면 파일을 건드리지 않아 지금 동작으로 떨어진다. herdr 패치 없이 재개 동작을 고친다.

### Consequences

* Good, because 재시작 재개가 전환 뒤 대화를 연다 — bg 잡이 살아 있으면 `claude attach`, 없으면 일반 재개(격리 herdr + 실제 Claude Code 2.1.296 실측).
* Good, because 바뀌는 바이트는 참조 `value` 문자열뿐이고(재파싱 대조), 같은 디렉터리 임시 파일 → rename 이라 부분 쓰기가 없다.
* Bad, because corral 이 herdr 영속 형식(`session.json` 구조·`source`·`kind`)에 처음 의존한다 — herdr 판이 형식을 바꾸면 고쳐 쓰기가 「구조 모름」으로 조용히 빠진다(안전한 실패지만 효과가 사라진다).
* Bad, because corral 밖에서 띄운 herdr(TUI·CLI)와 바인딩 세션은 고쳐지지 않는다.
* Bad, because herdr 가 같은 id 를 한 번만 재개하므로(`dedupe_key`) 다른 pane 이 이미 쥔 id 로는 옮기지 않는다 — 그 pane 은 지금처럼 멈춘 사본을 연다.

### Confirmation

`restore-rewrite.test.ts`(합성 판별·바이트·원자성)·`backend-start.test.ts`(spawn 직전 한 번·바인딩/돎/모름이면 호출 0)·변이 시험. herdr 판을 올릴 때 `session.json` 형식과 교체 게이트(`fork` 수용 여부)를 다시 본다. 로그 `herdr.restore_rewrite` 의 `outcomes` 로 실제 동작을 본다.

## Pros and Cons of the Options

### A

* Good, because herdr 무패치, 쓰기 경합 없음, 실패 시 무변경.
* Bad, because herdr 영속 형식 의존, corral 이 띄운 서버에만 효과.

### B·F (herdr 패치)

* Good, because 모든 진입(TUI·CLI)에 효과가 있다.
* Bad, because 패치 유지 비용. F 는 `fork` 보고를 받으면 bg 워커 env 상속(LIFE-795) 경로의 보고까지 참조를 바꿔 다른 문제를 연다.

### C (살아 있는 참조 변경)

* Good, because 재시작을 기다리지 않는다.
* Bad, because 766 원칙(살아 있는 herdr 상태를 바꾸지 않는다)에 어긋나고, herdr 가 다음 저장으로 덮을 수 있다.

### D·E

* Good, because 변경이 없다.
* Bad, because 대화 갈라짐이 그대로 일어난다.

## More Information

LIFE-772(이 결정), LIFE-766(이어 가기 규칙), LIFE-769(attach pane 세션 해소), LIFE-795(bg 워커 env 상속). 다시 볼 조건: herdr 가 `fork` 를 교체 게이트에 받거나 재개 때 참조를 따라가게 되면 A 를 걷어낸다. herdr 판 업그레이드 때 `session.json` 형식 변화.
