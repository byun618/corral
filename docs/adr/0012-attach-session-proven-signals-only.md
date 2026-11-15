---
status: accepted
date: 2026-11-10
decision-makers: 사용자(게이트 ⓪·최종 관문 판정 N), 코디네이터
---

# herdr 가 세션 참조를 주지 않는 claude pane 은 증명된 신호로만 세션을 정한다

## Context and Problem Statement

`/bg` 뒤 같은 pane 에서 `claude attach`(또는 실행 중 bg 세션 `--resume`)하면 herdr 는 그 pane 에 세션 참조를 주지 않는다. corral store 는 키가 없으면 옛 참조를 그대로 두었다. 그래서 폰이 `/bg` 전 세션이나 전혀 다른 세션의 대화를 보이고, 폰 입력도 그 기록으로 확인될 수 있었다(LIFE-769).

## Decision Drivers

* 다른 세션을 보이거나 그 기록으로 입력을 확인하는 것이 가장 무거운 결함이다 — 없음이 그보다 낫다.
* herdr 상태에 corral 이 쓰지 않는다(바닥 레이어 경계).
* 신호는 공식 출력(`claude agents --json --all`)을 우선하고, 비공식 관측(argv 재작성·`continued-in`)은 실패하면 없음으로 떨어지게 쓴다.

## Considered Options

* A: foreground argv `claude attach <ref>` + `claude agents --json --all` 로 corral 안에서만 푼다.
* B: corral 이 herdr 에 `pane.report_agent_session` 으로 채운다.
* C: `~/.claude/sessions/<pid>.json` 같은 내부 파일을 읽는다.

## Decision Outcome

Chosen option: "A", because 공식 출력과 herdr 무변경을 함께 지키고, 못 풀면 없음으로 닫히기 때문이다. 옛 참조는 그 기록의 `continued-in` 연쇄가 푼 값에 정확히 닿을 때만 쓴다(첫 입력 전 대화를 보이기 위한 예외, 판정 N).

### Consequences

* Good, because 경우 ③(다른 세션)이 사라지고, corral 재시작 뒤에도 attach pane 의 세션을 다시 찾는다.
* Bad, because attach pane 이 있는 동안 1.5 s 마다 `claude agents` 프로세스가 돈다(한 코어 약 7 %, 사용자 수용).
* Bad, because agent view 를 거친 클라이언트는 신호가 없어 없음이다. 옛 참조를 모르거나 연결이 증명되지 않으면(`/rename` 뒤 `/bg` 포함) 첫 입력 전 대화가 빈다.

### Confirmation

`attach-session.test.ts` 의 합성 해소·증명 시험과 변이 대조(해소 끔·증명 끔·대상 대조 끔), `SURFACE.md` 「attach pane 의 세션 해소」 한계 목록. Claude Code 버전이 바뀌면 실제 pane 으로 경우 ①②③ 을 다시 잰다.

## Pros and Cons of the Options

### A

* Good, because 공식 출력·herdr 무변경.
* Bad, because argv 재작성은 문서에 없는 관측이고 주기 조회 비용이 든다.

### B

* Good, because 모든 소비자가 herdr 값 하나를 본다.
* Bad, because corral 이 바닥 레이어 상태를 쓴다. 쓴 값이 틀리면 herdr·다른 클라이언트까지 틀린다.

### C

* Good, because 프로세스 하나 없이 읽는다.
* Bad, because 비공식 내부 형식이라 예고 없이 깨진다.

## More Information

LIFE-769(이 결정), LIFE-766(`continued-in` 따라가기), LIFE-795(bg 워커가 다른 pane 의 herdr 참조를 덮을 수 있음 — 같은 경계의 반대쪽).
