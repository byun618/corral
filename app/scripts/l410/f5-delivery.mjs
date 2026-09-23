// LIFE-410 F5 — Delivery and ACK, against the real CLI and a real runtime.
//
// The messages here are coordinator `status` sends, which need no worker pane: F5 is about the
// batching rule, not about who wrote the message. The worker side of the same rule is measured on
// a native provider pane by `native.mjs`.
import assert from 'node:assert/strict'
import { fixture } from './lib.mjs'

const f = await fixture('f5', { expectedChecks: 7 })
try {
  await f.startBackend()
  await f.serve()
  await f.cli(['orchestration', 'run-create', '--objective', 'LIFE-410 F5 — Delivery and ACK'])

  const say = (subject, type = 'status') => f.cli(['orchestration', 'send', '--type', type, '--subject', subject, '--body', `body of ${subject}`])
  for (const subject of ['one', 'two', 'three']) await say(subject)

  const first = await f.check('F5-one-batch-in-sequence-order', async () => {
    const response = await f.cli(['orchestration', 'check'])
    const batch = response.result
    assert.equal(batch.count, 3, JSON.stringify(batch))
    assert.equal(batch.deliveryReplayed, false)
    assert.deepEqual(batch.messages.map(entry => entry.subject), ['one', 'two', 'three'])
    assert.deepEqual(batch.messages.map(entry => entry.sequence), [1, 2, 3])
    assert.match(batch.deliveryId, /^delivery_[0-9a-f]{12}$/)
    return batch
  })
  const deliveryId = first.deliveryId

  await f.check('F5-the-same-batch-replays-and-never-widens', async () => {
    await say('four')
    const again = await f.cli(['orchestration', 'check'])
    assert.equal(again.result.deliveryReplayed, true)
    assert.equal(again.result.deliveryId, deliveryId)
    assert.deepEqual(again.result.messages.map(entry => entry.subject), ['one', 'two', 'three'],
      'a message that arrived while the batch was outstanding must not be mixed into it')
    return again.result
  })

  await f.check('F5-peek-reports-without-creating-a-delivery', async () => {
    const before = f.stateDigest()
    const peeked = await f.cli(['orchestration', 'check', '--peek'])
    assert.equal(peeked.result.peeked, true)
    assert.equal(peeked.result.deliveryId, null)
    assert.equal(f.stateDigest(), before, 'peek must not write')
    return peeked.result
  })

  await f.check('F5-only-the-outstanding-id-acknowledges', async () => {
    const acknowledged = await f.cli(['orchestration', 'check', '--ack', deliveryId])
    assert.equal(acknowledged.result.acknowledged, deliveryId)
    // The next batch holds what arrived since, and only that.
    assert.deepEqual(acknowledged.result.messages.map(entry => entry.subject), ['four'])
    const second = acknowledged.result.deliveryId
    const before = f.stateDigest()
    const repeated = await f.cli(['orchestration', 'check', '--ack', deliveryId], { fail: true })
    assert.equal(repeated.error.code, 'delivery_stale', JSON.stringify(repeated))
    const invented = await f.cli(['orchestration', 'check', '--ack', 'delivery_0123456789ab'], { fail: true })
    assert.equal(invented.error.code, 'delivery_stale', JSON.stringify(invented))
    assert.equal(f.stateDigest(), before, 'a stale ACK must leave the stored bytes untouched')
    return { acknowledged: acknowledged.result, second, repeated: repeated.error, invented: invented.error }
  })

  await f.check('F5-types-filter-the-batch', async () => {
    // Acknowledge what is outstanding first, so the filter decides the next batch rather than a replay.
    const outstanding = (await f.cli(['orchestration', 'check'])).result.deliveryId
    await f.cli(['orchestration', 'check', '--ack', outstanding, '--types', 'worker_done'])
    await say('five')
    const filtered = await f.cli(['orchestration', 'check', '--types', 'worker_done'])
    assert.equal(filtered.result.count, 0, 'no worker_done has been sent in this Run')
    const matched = await f.cli(['orchestration', 'check', '--types', 'status'])
    assert.deepEqual(matched.result.messages.map(entry => entry.subject), ['five'])
    return { filtered: filtered.result, matched: matched.result }
  })

  await f.check('F5-a-batch-is-cut-at-fifty', async () => {
    const outstanding = (await f.cli(['orchestration', 'check'])).result.deliveryId
    await f.cli(['orchestration', 'check', '--ack', outstanding])
    for (let index = 0; index < 52; index++) await say(`bulk-${index}`)
    const batch = await f.cli(['orchestration', 'check'])
    assert.equal(batch.result.count, 50, JSON.stringify({ count: batch.result.count }))
    assert.equal(batch.result.messages[0].subject, 'bulk-0')
    await f.cli(['orchestration', 'check', '--ack', batch.result.deliveryId])
    const rest = await f.cli(['orchestration', 'check'])
    assert.equal(rest.result.count, 2)
    // inbox is the non-consuming view of the same mailbox.
    const listed = await f.cli(['orchestration', 'inbox', '--limit', '10000'])
    assert.equal(listed.result.consumed, false)
    assert.equal(listed.result.totalCount, 57, JSON.stringify({ totalCount: listed.result.totalCount }))
    f.record('f5-inbox', listed.result.messages.slice(0, 5))
    return { first: batch.result.count, rest: rest.result.count, inbox: listed.result.totalCount }
  })
  await f.check('F5-an-ack-under-a-block-happens-once-and-the-wait-still-waits', async () => {
    // An ACK is an effect, and an effect happens once. Re-applying it on every poll of a `--block`
    // made the second poll refuse the batch the first had just closed, so `check --ack <id>
    // --block` — the shape a coordinator loop actually uses — answered `delivery_stale` instead of
    // waiting (V1). The mailbox is drained first so the wait is a real wait.
    for (;;) {
      const batch = await f.cli(['orchestration', 'check'])
      if (batch.result.count === 0) break
      await f.cli(['orchestration', 'check', '--ack', batch.result.deliveryId])
    }
    await say('to-be-acked')
    const outstanding = (await f.cli(['orchestration', 'check'])).result.deliveryId
    // Empty mailbox, an ACK to spend, and a deadline to run out: the ACK lands, the wait ends as a
    // normal answer rather than as an error.
    const startedAt = Date.now()
    const timedOut = await f.cli(['orchestration', 'check', '--ack', outstanding, '--block', '--timeout-ms', '3000'], { timeout: 40000 })
    assert.equal(timedOut.result.acknowledged, outstanding, JSON.stringify(timedOut.result))
    assert.equal(timedOut.result.timedOut, true, JSON.stringify(timedOut.result))
    assert.equal(timedOut.result.count, 0, JSON.stringify(timedOut.result))
    assert.ok(Date.now() - startedAt >= 2500, 'the block has to have waited out its deadline')
    // …and the same shape when a message arrives late: the ACK is still reported, and the batch is
    // the one that arrived while it waited.
    await say('to-be-acked-again')
    const second = (await f.cli(['orchestration', 'check'])).result.deliveryId
    const waiting = f.cli(['orchestration', 'check', '--ack', second, '--block', '--timeout-ms', '60000'], { timeout: 80000 })
    await f.pause(1500)
    await say('arrived-late')
    const received = await waiting
    assert.equal(received.result.acknowledged, second, JSON.stringify(received.result))
    assert.deepEqual(received.result.messages.map(entry => entry.subject), ['arrived-late'])
    assert.equal(received.result.timedOut, false)
    await f.cli(['orchestration', 'check', '--ack', received.result.deliveryId])
    return { timedOut: timedOut.result, received: received.result }
  })

  f.record('f5-state', f.stateJson())
} finally { await f.cleanup() }
