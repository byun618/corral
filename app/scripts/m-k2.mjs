// K2 · K3 — 구독/요청 커넥션 분리, 요청 1건 = 커넥션 1개.
//
// K2 통과선: 구독이 살아 있는 동안 요청을 10회 이상 보내도 구독이 끊기지 않는다(push 계속 수신).
// K3 통과선: 커넥션 생성·종료가 요청 수와 1:1.
//
// 앱은 CORRAL_PROBE_REQUESTS=10 으로 live 직후 ping 10회를 보낸다. 그 전후로 흔들어서
// push 가 계속 오는지 본다.

import { request, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

await tidySession()

const app = await startApp({
  name: 'k2',
  env: { CORRAL_PROBE_REQUESTS: '10' },
  waitFor: (entries) => entries.some((entry) => entry.tag === 'probe.requests.end'),
  timeoutMs: 40000,
})

const probeEnd = app.entries().find((entry) => entry.tag === 'probe.requests.end')
if (!probeEnd) throw new Error('요청 10회가 끝나지 않았다')

// 요청 10회 **후** 에도 push 가 오는가 — 구독이 살아 있다는 직접 증거다.
const afterRequests = Date.now()
const created = []
for (let i = 0; i < 3; i++) {
  const response = await request('workspace.create')
  created.push(response.result?.workspace?.workspace_id)
  await sleep(200)
}
for (const workspaceId of created) {
  await request('workspace.close', { workspace_id: workspaceId })
  await sleep(200)
}
await sleep(800)

const entries = app.entries()
const opens = entries.filter((entry) => entry.tag === 'req.conn.open')
const closes = entries.filter((entry) => entry.tag === 'req.conn.close')
const txs = entries.filter((entry) => entry.tag === 'req.tx')
const subConns = entries.filter((entry) => entry.tag === 'sub.conn.open')
const pushesAfter = entries.filter((entry) => entry.tag === 'push.applied' && entry.at > afterRequests)
const subDrops = entries.filter((entry) => entry.tag === 'sub.drop')

// 요청 커넥션 id 와 구독 커넥션 id 가 겹치지 않는 것이 "분리"의 기계적 증거다.
const requestConnIds = new Set(opens.map((entry) => entry.conn))
const subscriptionConnIds = new Set(subConns.map((entry) => entry.conn))
const overlap = [...requestConnIds].filter((id) => subscriptionConnIds.has(id))

// 커넥션당 요청은 1건인가 (req.tx 를 conn 별로 센다)
const perConn = {}
for (const tx of txs) perConn[tx.conn] = (perConn[tx.conn] ?? 0) + 1

const result = {
  measuredAt: new Date().toISOString(),
  probeRequests: probeEnd.count,
  requestConnections: { opened: opens.length, closed: closes.length, requestsSent: txs.length },
  maxRequestsPerConnection: Math.max(...Object.values(perConn)),
  oneRequestPerConnection: Object.values(perConn).every((count) => count === 1),
  openCloseBalanced: opens.length === closes.length && opens.length === txs.length,
  subscriptionConnections: subConns.length,
  connectionIdOverlap: overlap,
  subscriptionDropsDuringRun: subDrops.length,
  pushesAfterTenRequests: pushesAfter.length,
  pushEventsAfterTenRequests: pushesAfter.map((entry) => entry.event),
  requestLog: [...opens, ...txs, ...closes]
    .sort((a, b) => a.at - b.at)
    .map((entry) => ({ ts: entry.ts, tag: entry.tag, conn: entry.conn, method: entry.method ?? null })),
}

writeRaw('21-k2k3-connections.json', result)
console.log(
  JSON.stringify(
    {
      probeRequests: result.probeRequests,
      oneRequestPerConnection: result.oneRequestPerConnection,
      openCloseBalanced: result.openCloseBalanced,
      connectionIdOverlap: result.connectionIdOverlap,
      subscriptionDropsDuringRun: result.subscriptionDropsDuringRun,
      pushesAfterTenRequests: result.pushesAfterTenRequests,
    },
    null,
    2,
  ),
)

await app.stop()
await tidySession()
