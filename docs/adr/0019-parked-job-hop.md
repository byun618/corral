---
status: accepted
date: 2026-11-18
decision-makers: LIFE-797 코디(게이트 ⓪ 위임 판단) · 사용자(게이트 ① 채택)
---

# 빈 대화 park 의 이어짐은 Claude 레지스트리 `parkedJobId` 한 hop 으로 증명한다 (fail-closed)

## Context and Problem Statement

대화가 아직 없는 Claude pane 에서 `←` 로 park 했다가 `esc` 로 돌아오면 그 pane 은 bg 세션의 새 파일에 쓰는데, 민팅 파일이 없어 `continued-in` 이 남지 않는다. 그래서 배달 확인이 `unknown` 으로 120초를 쓰고, 워커 `worker_done` 이 `sender_mismatch` 로 거절됐다(LIFE-797, ADR-0015 의 사슬이 시작조차 못 함).

## Decision Drivers

* 거짓 completed·거짓 수락이 unknown 보다 나쁘다.
* 화면은 거절 방향으로만 읽는다(ADR-0014) — 화면 표지로 배달을 증명하지 않는다.
* 이미 `continued-in`(문서화 안 된 transcript 기록)에 기대고 있다 — 같은 급의 근거는 받아들일 수 있다.
* `main/` 소비자(채팅 뷰·폰)는 이 일감에서 바꾸지 않는다.

## Considered Options

* ⓐ 민팅 파일이 없을 때만, 레지스트리의 대화형 항목(민팅 id) `parkedJobId` → `kind: "bg"`·같은 `jobId` 항목의 `sessionId` → 그 파일 한 hop. 고리마다 정확히 하나, 아니면 이전 답
* 화면 표지(본문·답이 보이면 배달)
* ⓑ 한계로 문서화만

## Decision Outcome

Chosen option: "ⓐ", because 고리마다 Claude 자신의 기록이 다음 세션을 이름으로 가리키고(앞선 대화가 있을 때 `continued-in` 과 같은 답 — 실측), 어긋나면 지금 답으로 떨어져 거짓 성립 경로가 없다.

### Consequences

* Good, because 빈 pane park 뒤 재개가 수 초 안에 `confirmed` 이고 bg 워커의 보고가 `session_chain` 으로 받아진다.
* Bad, because 문서화되지 않은 레지스트리 형식(관측 2.1.296)에 기대 — 형식이 바뀌면 조용히 이전 답(unknown·거절)으로 돌아간다. 2.1.325·2.1.326 이후 park 동작은 확인 안 함.
* Bad, because 레지스트리의 깨진 항목 하나가 남아 있는 동안 모든 pane 의 hop 이 꺼진다(건너뛰면 fail-open 이라 받아들임).
* Bad, because 배달 hop(pane 폴더)과 보고자 hop(전 project 폴더 스캔)이 다른 폴더 구성에서 서로 다른 답을 낼 수 있다.

### Confirmation

* `app/src/runtime/orchestration/parked.test.ts`, `app/src/runtime/runtime.test.ts` LIFE-797 블록 — fail-closed 고리·네 소비자·상한 9·`.key` 이웃
* LIFE-797 최종 관문 C6 변이 25건
