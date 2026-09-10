// K5 — 구독 타입 취급.
//
// ① 평상시 앱이 보내는 구독 타입이 0.9.0 이 아는 27종 안에 있는가 (스키마와 대조)
// ② 일부러 모르는 타입을 하나 섞으면 서버가 **요청 전체를 거부**하는가,
//    그때 앱이 조용히 죽지 않고 식별 가능한 실패로 남는가 (CORRAL_INJECT_BAD_SUB=1)

import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

await tidySession()

// --- ① 정상 구독 --------------------------------------------------------
const good = await startApp({ name: 'k5-good' })
const goodEntries = good.entries()
const subscribeFrame = JSON.parse(goodEntries.find((entry) => entry.tag === 'sub.tx').line)
const usedTypes = subscribeFrame.params.subscriptions.map((item) => item.type)
const goodAck = goodEntries.find((entry) => entry.tag === 'sub.ack') ?? null
await good.stop()

const schema = JSON.parse(
  fs.readFileSync(path.join(path.dirname(APP_DIR), 'specs/reference/herdr-api-schema-0.9.0.json'), 'utf8'),
)
const knownTypes = schema.schemas.request.$defs.Subscription.oneOf.map((item) => item.properties.type.const)
const unknownUsed = usedTypes.filter((type) => !knownTypes.includes(type))

// --- ② 일부러 모르는 타입 섞기 ------------------------------------------
const bad = await startApp({
  name: 'k5-bad',
  env: { CORRAL_INJECT_BAD_SUB: '1' },
  waitFor: (entries) => entries.some((entry) => entry.tag === 'link.phase' && entry.phase === 'failed'),
  timeoutMs: 20000,
})
await sleep(800)
await bad.shot('k5-bad-subscription-failed')
// 앱이 살아 있는가 — 제어 채널이 응답하면 main 프로세스가 살아 있다는 뜻이다.
const aliveState = await bad.state()
const badEntries = bad.entries()
const rejected = badEntries.find((entry) => entry.tag === 'sub.ack.rejected') ?? null
const failed = badEntries.find((entry) => entry.tag === 'boot.failed') ?? null
const rawRejection = badEntries.filter((entry) => entry.tag === 'sub.rx').map((entry) => entry.line)
await sleep(2500)
const retriesAfterFailure = bad.entries().filter((entry) => entry.tag === 'link.retry.scheduled').length
await bad.stop()

const result = {
  measuredAt: new Date().toISOString(),
  normal: {
    subscribedTypes: usedTypes,
    knownTypeCount: knownTypes.length,
    unknownTypesSent: unknownUsed,
    ack: goodAck ? JSON.parse(goodAck.result) : null,
  },
  injected: {
    injectedType: badEntries.find((entry) => entry.tag === 'boot.subscribe.begin')?.injectedBadType ?? null,
    serverRejection: rawRejection,
    rejectionParsed: rejected,
    appReaction: failed,
    linkPhase: aliveState.state.link.phase,
    lastError: aliveState.state.link.lastError,
    appAlive: aliveState.ok === true,
    // 재시도해도 같은 결과이므로 재시도 루프에 넣지 않는다 — 무한 루프 방지
    retriesScheduledAfterFailure: retriesAfterFailure,
    processCrashed: badEntries.some((entry) => entry.tag === 'main.uncaught_exception'),
  },
}

writeRaw('23-k5-subscription-types.json', result)
console.log(
  JSON.stringify(
    {
      unknownTypesSent: result.normal.unknownTypesSent,
      subscribedCount: usedTypes.length,
      rejectionCode: rejected?.code ?? null,
      linkPhase: result.injected.linkPhase,
      appAlive: result.injected.appAlive,
      retriesScheduledAfterFailure: result.injected.retriesScheduledAfterFailure,
    },
    null,
    2,
  ),
)

await tidySession()
