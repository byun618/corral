---
status: accepted
date: 2026-11-14
decision-makers: 사용자(게이트 ⓪ 안 S·안 H 승인) · LIFE-795 코디
---

# 워커 보고의 보낸 쪽 확인에 Claude 세션 사슬 증명을 더한다 (혼동 방지, 인증 아님)

## Context and Problem Statement

워커 보고(`heartbeat`·`worker_done`·`ask`)는 「Dispatch 가 묶인 pane 에서 왔는가」(`HERDR_PANE_ID` 비교)로 보낸 쪽을 확인했다. Claude 워커를 `←` 로 백그라운드에 옮기면 그 세션은 계정당 하나인 bg 데몬 안에서 돈다. 데몬은 처음 띄운 pane 의 env 를 물려받으므로 보고가 엉뚱한 pane id 를 싣고 와 `sender_mismatch` 로 거절됐다(LIFE-796). 같은 원인으로 bg 세션의 herdr 훅이 그 첫 pane 의 세션 참조를 덮었다(LIFE-795).

## Decision Drivers

* pane id 는 bg 세션에서 믿을 수 없다. 데몬 env 상속은 Claude Code 상류 동작이라 우리가 못 고친다.
* 보낸 쪽 확인의 목적은 혼동 방지(잘못 친 id, 다른 Dispatch)다. 같은 사용자의 악의적 위조를 막는 인증이 아니다.
* 받아들이는 길이 넓어지면 안 된다. 다른 Dispatch·다른 대화·세션 id 없는 호출은 지금처럼 거절해야 한다.
* 문서 잠금 안에서 백엔드 왕복을 더하지 않는다.
* 새 비밀(토큰)을 화면·기록에 남기지 않는다.

## Considered Options

* S: CLI 가 `CLAUDE_CODE_SESSION_ID` 를 싣고, pane 비교가 실패할 때만 그 id 가 Dispatch 가 얼린 민팅 세션 또는 그 기록의 `continued-in` 사슬에 드는지 본다
* T: preamble 에 Dispatch 별 토큰을 넣고 보고에 싣게 한다
* N: 796 은 한계로 두고 bg 전환한 워커는 보고하지 못한다고 문서화한다

## Decision Outcome

Chosen option: "S", because 사슬 재료(민팅 id·`continued-in`)가 이미 corral 이 쓰는 기록에 있어 새 표면이 없고, pane 증명이 통하는 호출은 그대로 두며, 받는 범위를 「그 Dispatch 가 시작한 대화의 이어짐」으로만 넓힌다.

### Consequences

* Good, because bg 로 옮긴 Claude 워커의 보고가 받아지고 완료 감지까지 간다. 답의 `proof: 'pane'|'session_chain'` 으로 어느 길인지 보인다.
* Good, because 사슬은 기록 파일만 읽어 pane 이 사라져도 `stale_dispatch` 가 되고, 잠금 안 백엔드 왕복이 없다.
* Bad, because 증명이 호출자가 싣는 env 값에 기댄다. 그래서 `sessionVerified: false` 로 표시하고 「혼동 방지, 인증 아님」을 문서에 적는다.
* Bad, because bg 안 `/clear` 는 `continued-in` 을 남기지 않아 그 뒤 보고는 거절된다. 같은 id 기록이 두 폴더에 있으면 사슬이 없다.
* Bad, because 795 쪽은 herdr 훅 자산을 corral 이 패치한다(`CLAUDE_JOB_DIR` 이 있으면 보고하지 않음, 버전 표지 9 그대로). brew·상류 herdr 로 재설치하면 패치가 말없이 사라진다.

### Confirmation

* `app/src/runtime/orchestration/session-chain.test.ts`: 수용·거절·pane 소멸·무왕복·유일성·민팅 id 모양
* `app/backend/claude-hook-bg.nodetest.mjs`: 판정 회차는 skipped 0
* 판정 장치를 끄는 변이 시험

## Pros and Cons of the Options

### S

* Good, because 새 비밀이 없고 기존 기록 사슬 규칙(`followContinued`)을 재사용한다.
* Bad, because Claude 에만 해당하고, `/clear` 뒤에는 끊긴다.

### T

* Good, because provider 와 무관하다.
* Bad, because 토큰이 화면·기록에 남고, 새 발급·검증 표면이 생긴다.

### N

* Good, because 코드 변경이 없다.
* Bad, because bg 전환은 사용자가 자주 쓰는 동작이라 완료 감지가 조용히 끊긴다.

## More Information

LIFE-795·LIFE-796. 상류: Claude Code #98872(데몬 env 상속), herdr #5557(fork 보고 거절). 상류가 고쳐지면 다시 본다. 데몬이 pane 별 env 를 갖게 되면 사슬 증명과 훅 패치를 걷는다.
