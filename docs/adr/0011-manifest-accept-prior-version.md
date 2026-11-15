---
status: accepted
date: 2026-11-03
decision-makers: 사용자(게이트 ⓪), 코디네이터
---

# herdr 재기동 전 구간을 위해 Claude manifest 기대값이 옛 값도 받는다

## Context and Problem Statement

앱 교체와 herdr 재기동은 시점이 다르다. 재기동은 모든 pane 에 영향이 있어 사용자가 정하므로, 새 앱이 옛 herdr 위에서 도는 구간이 생긴다. 기대값이 하나면 그 구간에 Claude 입력이 전부 `detect_manifest_unverified` 로 거절된다(LIFE-651·665·670 의 grok 거절 전례). LIFE-780 이 Claude manifest 를 올리면서 이 선택이 필요해졌다.

## Decision Drivers

* Claude 는 사용자의 코디·워커가 돌고 있는 주 도구라 거절 범위가 넓다
* 게이트의 목적(모르는 판독 규칙 위에서 입력하지 않기)은 지켜야 한다
* 재기동 시점은 사용자 결정이다 — 앱이 강제하지 않는다

## Considered Options

* 기대값 하나 유지, 재기동 때까지 거절
* 옛 값과 새 값을 둘 다 받는다
* 버전 게이트를 Claude 에서 뺀다

## Decision Outcome

Chosen option: "옛 값과 새 값을 둘 다 받는다", because 재기동 전 구간에 입력이 끊기지 않으면서 알려지지 않은 버전·비 bundled·로컬 그림자는 계속 거절한다. `ManifestExpectation.priorVersions` 로 명시하고 Claude 만 값을 가진다.

### Consequences

* Good, because 앱 교체와 재기동을 따로 할 수 있다
* Bad, because 옛 값 구간에는 고치기 전 판독이 그대로다 — 이름 붙은 질문에 CLI 입력이 들어가 첫 선택지가 답으로 기록될 수 있다(LIFE-780 C5 대조). 재기동해야 풀린다
* Bad, because `priorVersions` 를 언제 비울지는 사람이 정한다

### Confirmation

`app/src/runtime/runtime.test.ts` 가 옛·새 통과와 다른 버전·비 bundled·그림자 거절을 고정한다. 실제 조합은 LIFE-780 C7·C11ⓐ.

## Pros and Cons of the Options

### 기대값 하나 유지

* Good, because 판독이 항상 새 규칙임을 보장한다
* Bad, because 재기동 전까지 Claude 입력이 전부 끊기고, 사용자가 재기동을 사실상 강제당한다

### 버전 게이트를 Claude 에서 뺀다

* Good, because 거절이 없다
* Bad, because 로컬 덮어쓰기·모르는 manifest 위에서 입력하는 경로가 열린다

## More Information

LIFE-780. 다시 볼 조건: 다음 Claude manifest 를 올릴 때(옛 값을 몇 개까지 받을지), codex·grok 에서 같은 재기동 구간 문제가 다시 날 때.
