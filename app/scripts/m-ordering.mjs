// herdr push 순서 실측 — 같은 workspace 의 create 와 close 가 뒤집혀 오는가.
//
// 왜 재나: K1 수렴 비교가 간헐적으로 어긋났고, 원인을 앱 로그에서 추적했더니
// `workspace_closed(w8G)` 가 `workspace_created(w8G)` 보다 **먼저** 도착해 있었다.
// 앱 로그는 앱의 해석이 섞이므로, 여기서는 하네스가 **구독 스트림 원문**으로 다시 잰다.
//
// 이건 herdr 의 성질이지 앱의 버그가 아니다 — 다만 클라이언트가 방어해야 한다.

import net from 'node:net'
import { SESSION, sleep, socketPath, startChurn, tidySession, writeRaw } from './lib.mjs'

const TYPES = [
  'workspace.created',
  'workspace.closed',
  'tab.created',
  'tab.closed',
  'pane.created',
  'pane.closed',
]

const SOCK = socketPath()
const events = []

const subscription = net.createConnection(SOCK)
subscription.setEncoding('utf8')
let buffer = ''
subscription.on('error', (error) => console.error('sub error', error.code))
subscription.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index === -1) break
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim().length === 0) continue
    const message = JSON.parse(line)
    if (message.event) events.push({ at: Date.now(), event: message.event, data: message.data })
  }
})
await new Promise((resolve) => subscription.on('connect', resolve))
subscription.write(
  JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: TYPES.map((type) => ({ type })) } }) +
    '\n',
)
await sleep(300)

await tidySession()
const churns = [0, 1, 2, 3, 4, 5].map(() => startChurn({ intervalMs: 0 }))
await sleep(8000)
for (const churn of churns) await churn.stop()
// 넉넉히 기다린다 — 늦게 오는 푸시를 "안 온 것"으로 세지 않기 위해서다.
await sleep(4000)
subscription.end()
subscription.destroy()

// --- 도착 순서를 workspace 별로 정리한다 ---------------------------------
const byWorkspace = new Map()
for (const item of events) {
  const workspaceId =
    item.data?.workspace?.workspace_id ??
    item.data?.workspace_id ??
    item.data?.pane?.workspace_id ??
    item.data?.tab?.workspace_id ??
    null
  if (workspaceId === null) continue
  const list = byWorkspace.get(workspaceId) ?? []
  list.push({ at: item.at, event: item.event })
  byWorkspace.set(workspaceId, list)
}

const inversions = []
const lateChildren = []
for (const [workspaceId, list] of byWorkspace) {
  const created = list.find((item) => item.event === 'workspace_created')
  const closed = list.find((item) => item.event === 'workspace_closed')
  if (created && closed && closed.at < created.at) {
    inversions.push({ workspaceId, closedAt: closed.at, createdAt: created.at, lagMs: created.at - closed.at })
  }
  if (closed) {
    for (const item of list) {
      if ((item.event === 'pane_created' || item.event === 'tab_created') && item.at > closed.at) {
        lateChildren.push({ workspaceId, event: item.event, lagMs: item.at - closed.at })
      }
    }
  }
}

// --- 흔들기가 실제로 한 일 vs 스트림이 알려 준 일 -------------------------
// 앱 밖에서, 구독 스트림 원문만으로 센다. herdr 가 푸시를 흘리는지가 여기서 갈린다.
const requestedCreates = churns.flatMap((churn) => churn.events.filter((e) => e.kind === 'create').map((e) => e.workspaceId))
const requestedCloses = churns.flatMap((churn) => churn.events.filter((e) => e.kind === 'close').map((e) => e.workspaceId))
const pushedCreates = new Set(
  events.filter((item) => item.event === 'workspace_created').map((item) => item.data?.workspace?.workspace_id),
)
const pushedCloses = new Set(events.filter((item) => item.event === 'workspace_closed').map((item) => item.data?.workspace_id))
const missingCreatePushes = [...new Set(requestedCreates)].filter((id) => id && !pushedCreates.has(id))
const missingClosePushes = [...new Set(requestedCloses)].filter((id) => id && !pushedCloses.has(id))

const result = {
  measuredAt: new Date().toISOString(),
  session: SESSION,
  question: '같은 workspace 의 push 가 인과 순서대로 오는가 (create → close). 그리고 다 오기는 하는가.',
  delivery: {
    requestedCreates: new Set(requestedCreates).size,
    requestedCloses: new Set(requestedCloses).size,
    missingCreatePushes: { count: missingCreatePushes.length, samples: missingCreatePushes.slice(0, 10) },
    missingClosePushes: { count: missingClosePushes.length, samples: missingClosePushes.slice(0, 10) },
    note:
      '하네스가 요청한 생성·종료 중 구독 스트림으로 **되돌아오지 않은** 것. 앱을 거치지 않은 ' +
      '원문 집계라 클라이언트 버그와 섞이지 않는다.',
  },
  workspacesObserved: byWorkspace.size,
  eventsObserved: events.length,
  inversions: {
    count: inversions.length,
    maxLagMs: inversions.reduce((max, item) => Math.max(max, item.lagMs), 0),
    samples: inversions.slice(0, 10),
    note: 'workspace_closed 가 같은 workspace 의 workspace_created 보다 먼저 도착한 경우',
  },
  lateChildren: {
    count: lateChildren.length,
    maxLagMs: lateChildren.reduce((max, item) => Math.max(max, item.lagMs), 0),
    samples: lateChildren.slice(0, 10),
    note: 'workspace 가 닫힌 뒤에 그 workspace 의 pane_created/tab_created 가 도착한 경우',
  },
  // 이 최댓값이 "시간창으로는 못 막는다"의 근거다 — 부하를 올리면 같이 올라간다.
  // corral 은 시간창을 버리고 묘비(닫힌 id 는 다시 받지 않는다)로 갔다 (28-orphan-holding.json).
  windowBasis: {
    note:
      '뒤집힘 지연은 부하와 그날의 서버 상태를 따라 흔들린다 — 같은 6갈래·8초 흔들기인데 ' +
      '수정 1회차에는 1374ms 가 나왔다 (그 원자료는 이 파일이 덮었다). 이번 실행의 값은 위 ' +
      'inversions.maxLagMs 다. 한쪽 실행의 값을 보고 창을 잡으면 다른 실행에서 틀린다 — ' +
      '고정 시간창이 틀린 도구인 이유가 이것이다. ' +
      'corral 은 workspace_id 가 생애 안에서 재사용되지 않는다는 실측(29-id-reuse.json)에 기대어 ' +
      '시간을 아예 안 보는 쪽(묘비)으로 갔다.',
  },
  deliveryConclusion:
    missingClosePushes.length > 0 || missingCreatePushes.length > 0
      ? 'herdr 는 부하가 걸리면 push 를 **흘린다**. 구독만으로는 상태가 수렴하지 않는다 — ' +
        '스냅샷 재조회가 유일한 진실 회복 경로다 (Step 2 가 물려받아야 한다).'
      : '이번 부하에서는 흘린 push 가 없었다.',
  conclusion:
    inversions.length > 0 || lateChildren.length > 0
      ? 'herdr push 는 같은 workspace 안에서도 인과 순서를 보장하지 않는다. 푸시에 시퀀스 번호가 ' +
        '없으므로 클라이언트가 막아야 한다 — corral 은 (1) 주인보다 먼저 온 pane/tab 을 보류함에 ' +
        '담았다가 주인이 오면 붙이고 (2) 이 생애에서 닫힌 id 를 묘비에 적어 다시 받지 않는다.'
      : '이번 측정에서는 뒤집힘이 관측되지 않았다 (부하가 낮았을 수 있다 — 공백으로 남긴다).',
}

writeRaw('27-push-ordering.json', result)
console.log(
  JSON.stringify(
    {
      workspaces: result.workspacesObserved,
      inversions: inversions.length,
      maxInversionLagMs: result.inversions.maxLagMs,
      lateChildren: lateChildren.length,
      missingCreatePushes: missingCreatePushes.length,
      missingClosePushes: missingClosePushes.length,
    },
    null,
    2,
  ),
)
await tidySession()
