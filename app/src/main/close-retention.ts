// **닫기 한 번을 억제 표와 함께 감싼다** (S15ⓓ ② · fix-r1 F6 · fix-r3 R3-F1).
//
// 표를 찍는 것은 「지금 corral 이 이걸 닫는 중이다」는 약속이다. 그 약속이 깨졌는데 표가
// 남으면, 그 pane 이 **나중에 진짜로 끝나서 사라질 때** 완료 기록을 조용히 삼킨다.
//
// R3-F1 로 이 파일이 생겼다. 전에는 같은 함수가 `main/index.ts` 안의 지역 함수였고, 그래서
// **테스트가 이 경로를 탈 수 없었다** — Electron 엔트리를 import 할 수 없으니 검증은 store 를
// 직접 부르는 수밖에 없었고, 실제 호출부가 store 에 무엇을 넘기는지는 아무도 안 쟀다.
// 실제로 거기 있던 결함이 그 틈으로 지나갔다(아래 ②).

import type { CloseEffect } from '../shared/agent-state.js'
import { HerdrRequestError } from './adapter/index.js'
import { log } from './log.js'

/** 억제 표를 들고 있는 쪽 (실제로는 어댑터의 `SessionLink.store`). */
export interface RetentionLedger {
  suppressRetention(id: string): void
  settleSuppression(input: { ids: readonly string[]; code?: string | null; sent: boolean }): {
    effect: CloseEffect
    released: readonly string[]
    kept: readonly string[]
  }
}

/**
 * 닫기 호출 하나의 결과. corral 의 닫기 3종이 모두 이 모양이다 —
 * `closeTab`/`closeWorkspace` 는 `closed`·`rejected`·`error`, `closePane` 은 `ok`·`rejected`.
 */
export interface CloseAttempt { outcome: string; rejection?: { code: string; message: string } }

/**
 * 결과를 세 갈래로 가른다:
 *
 *   · 닫혔다        → 표를 그대로 둔다. 곧 올 닫힘 통보를 그 표가 받는다
 *   · **확정 거절** → 표를 걷는다. 요청이 나가지도 못했거나, herdr 가 **손대지 않고** 거절했다
 *   · **결과 불명** → 표를 **그대로 둔다**. 닫혔을 수도 있고, 그때 걷으면 사용자가 닫은 것이
 *     완료 행으로 되살아난다. 둘 중 덜 나쁜 쪽을 고른다
 *
 * ① 분류는 CLI 와 **같은 함수**가 한다 (`closeEffect`, R2-F3). 전에는 여기서 `timeout` 만
 *    불명으로 봤고 CLI 는 타임아웃까지 걷어서 같은 상황을 반대로 판정했다.
 * ② **거절이라고 해서 안 나간 것이 아니다** (R3-F1 정정). 라운드 2 의 이 자리에는
 *    *"우리 자신의 게이트가 막은 것이다 — 소켓에 나가지 않았다"* 라고 적혀 있었는데,
 *    거짓이다: `closeTab`/`closeWorkspace`/`closePane` 은 **herdr 의 에러 응답**을
 *    `outcome:'rejected'` 로 돌려준다(`lifecycle.ts`·`panes.ts`). 즉 `rejected` 는 요청이
 *    나가고 **답까지 받은** 것이다. 우리 게이트가 막은 것은 `request()` 가 던지는 쪽이다.
 *    그래서 전송 여부는 추측하지 않고 `onSent` 로 **받는다**.
 */
export async function withRetentionSuppressed<T extends CloseAttempt>(input: {
  store: RetentionLedger
  ids: readonly string[]
  what: string
  run: (hooks: { onSent: () => void }) => Promise<T>
}): Promise<T> {
  for (const id of input.ids) input.store.suppressRetention(id)
  let sent = false
  try {
    const outcome = await input.run({ onSent: () => { sent = true } })
    if (outcome.outcome === 'rejected' || outcome.outcome === 'error') {
      const code = 'rejection' in outcome && outcome.rejection ? outcome.rejection.code : null
      const settled = input.store.settleSuppression({ ids: input.ids, code, sent })
      log('retention.suppress.settled', { what: input.what, ...settled, why: outcome.outcome, code, sent })
    }
    return outcome
  } catch (error) {
    const code = error instanceof HerdrRequestError ? error.code : null
    const settled = input.store.settleSuppression({ ids: input.ids, code, sent })
    log('retention.suppress.settled', { what: input.what, ...settled, code, sent })
    throw error
  }
}
