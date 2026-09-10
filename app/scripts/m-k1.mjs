// K1 — 부트스트랩 순서(구독→ack→버퍼링→snapshot→멱등 적용)와 수렴 일치.
//
// 부트스트랩 창은 100ms 안팎이라 가만히 두면 버퍼가 빈다. 그래서 **먼저 흔들기 시작하고**
// 그 와중에 앱을 띄운다 — 스파이크 A4 와 같은 조건이다.

import { sleep, startApp, startChurn, tidySession, writeRaw } from './lib.mjs'

await tidySession()
// 부트스트랩 창은 실측 ~106ms 다 (20-k1-order.txt). 그 안에 이벤트를 넣으려면 촘촘해야 해서
// 흔들기를 4개 병렬로 돌린다.
const churns = [0, 1, 2, 3].map(() => startChurn({ intervalMs: 0 }))
await sleep(600)

const app = await startApp({
  name: 'k1',
  env: { CORRAL_VERIFY_CONVERGE: '1' },
  waitFor: (entries) => entries.some((entry) => entry.tag === 'boot.verify'),
})
// 흔들기를 멈추고 **실제로 조용해진 뒤에** 수렴 비교를 한다 — 흔드는 중의 비교는 서로 다른
// 시점을 비교하는 것이라 의미가 없다 (스파이크 A4 도 churn 을 멈추고 비교했다).
// "조용해졌다"는 앱 로그에 push 가 일정 시간 안 들어온 것으로 판정한다 (시계를 믿지 않는다).
for (const churn of churns) await churn.stop()
const quietAt = await waitQuiet(app, 1500, 30000)
const verifyAfterQuiet = await app.verify()
const entries = app.entries()

const ORDER_TAGS = [
  'boot.subscribe.begin',
  'boot.subscribe.ack',
  'push.buffered',
  'boot.snapshot.request',
  'boot.snapshot.applied',
  'boot.buffer.apply.begin',
  'boot.buffer.apply',
  'boot.converged',
  'boot.verify',
]

const order = entries
  .filter((entry) => ORDER_TAGS.includes(entry.tag))
  .map((entry) => ({ ts: entry.ts, at: entry.at, tag: entry.tag, event: entry.event ?? null, note: entry.note ?? null }))

const verify = entries.find((entry) => entry.tag === 'boot.verify') ?? null
const stamp = (tag) => entries.find((entry) => entry.tag === tag)?.at ?? null
const buffered = entries.filter((entry) => entry.tag === 'push.buffered').length
const applied = entries.filter((entry) => entry.tag === 'boot.buffer.apply')

const result = {
  measuredAt: new Date().toISOString(),
  orderOk:
    stamp('boot.subscribe.begin') <= stamp('boot.subscribe.ack') &&
    stamp('boot.subscribe.ack') <= stamp('boot.snapshot.request') &&
    stamp('boot.snapshot.request') <= stamp('boot.snapshot.applied') &&
    stamp('boot.snapshot.applied') <= stamp('boot.buffer.apply.begin'),
  timestamps: {
    subscribeBegin: stamp('boot.subscribe.begin'),
    subscribeAck: stamp('boot.subscribe.ack'),
    firstBufferedPush: stamp('push.buffered'),
    snapshotRequest: stamp('boot.snapshot.request'),
    snapshotApplied: stamp('boot.snapshot.applied'),
    bufferApplyBegin: stamp('boot.buffer.apply.begin'),
    converged: stamp('boot.converged'),
  },
  // 버퍼링 창 = 구독 ack ~ 버퍼 적용 시작. 그 사이 도착분이 **적용되지 않고 쌓였다**는 증명이다.
  bufferedWithinWindow: entries
    .filter((entry) => entry.tag === 'push.buffered')
    .every((entry) => entry.at >= stamp('boot.subscribe.ack') && entry.at <= stamp('boot.buffer.apply.begin')),
  bufferedBeforeSnapshotApplied: entries
    .filter((entry) => entry.tag === 'push.buffered')
    .every((entry) => entry.at <= stamp('boot.snapshot.applied')),
  bufferedCount: buffered,
  appliedFromBuffer: applied.length,
  idempotentAbsorbed: applied.filter((entry) => entry.changed === false).map((entry) => entry.note),
  convergedIds: entries.find((entry) => entry.tag === 'boot.converged') ?? null,
  verify,
  quietAfterMs: quietAt,
  verifyDuringChurn: verify?.match ?? null,
  verifyAfterQuiet: verifyAfterQuiet.verify,
  verifyMatch: verifyAfterQuiet.verify?.match ?? null,
  orderLog: order,
}

writeRaw('20-k1-bootstrap.json', result)
writeRaw(
  '20-k1-order.txt',
  [
    '# K1 — 부트스트랩 순서 (앱 로그의 타임스탬프 그대로)',
    '',
    ...order.map(
      (entry) => `${entry.ts}  ${entry.tag}${entry.event ? ' ' + entry.event : ''}${entry.note ? ' — ' + entry.note : ''}`,
    ),
  ].join('\n') + '\n',
)
console.log(
  JSON.stringify(
    {
      orderOk: result.orderOk,
      bufferedWithinWindow: result.bufferedWithinWindow,
      bufferedBeforeSnapshotApplied: result.bufferedBeforeSnapshotApplied,
      bufferedCount: result.bufferedCount,
      appliedFromBuffer: result.appliedFromBuffer,
      verifyDuringChurn: result.verifyDuringChurn,
      verifyMatch: result.verifyMatch,
    },
    null,
    2,
  ),
)

await app.stop()
await tidySession()

/** 마지막 push.applied 이후 quietMs 가 지날 때까지 기다린다. 못 기다리면 null. */
async function waitQuiet(app, quietMs, timeoutMs) {
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    const pushes = app.entries().filter((entry) => entry.tag === 'push.applied')
    const last = pushes.length === 0 ? started : pushes[pushes.length - 1].at
    if (Date.now() - last >= quietMs) return Date.now() - started
    await sleep(100)
  }
  return null
}
