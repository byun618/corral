// L6·L7 선행 실측 — 에이전트 상태와 "출력이 있었다"를 herdr 가 무엇으로 알려 주는가.
//
// 두 질문을 한 번에 잰다. 둘 다 **봉투를 먼저 보고** 결정해야 하는 자리다.
//
//   ① L6: `pane.agent_status_changed` 봉투 모양. 이건 **파라미터를 받는 3종** 중 하나라
//      1회차에서 뺐다 — 스키마상 `pane_id` 가 required 다. 즉 **pane 마다 구독**해야 한다.
//      그래서 같이 본다: 파라미터 없는 `pane.agent_detected`·`pane.updated` 만으로도 상태가
//      오는가? 온다면 corral 은 pane 마다 구독을 걸 필요가 없다.
//   ② L7: `pane.updated` 의 `revision` 이 **이벤트 경로에서** 움직이는가.
//      스파이크는 `pane.read`·`pane.list` 의 revision 이 고정이라고 했고 이벤트 경로는
//      안 재보고 미검증 공백으로 남겼다 (LIFE-342 §2.2). 여기서 그 공백이 필요해졌다.
//
// 격리: life344-probe 에서만. 에이전트도 거기서 띄우고 끝나면 끈다.

import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { SESSION, request, sleep, socketPath, writeRaw } from './lib.mjs'

const run = promisify(execFile)
const SOCK = socketPath() // 격리 가드
const AGENT_CMD = process.env.L344_AGENT_CMD ?? 'claude --dangerously-skip-permissions'
const PROMPT = process.env.L344_AGENT_PROMPT ?? 'reply with exactly: pong'

// --- 대상 pane 을 정한다 -------------------------------------------------
const snapshot = (await request('session.snapshot')).result.snapshot
const pane = snapshot.panes[0]
if (!pane) throw new Error('격리 세션에 pane 이 없다')

// --- 구독 두 개를 나눠 연다 ---------------------------------------------
// A: 파라미터 없는 것만 (지금 corral 이 여는 것과 같은 모양 + agent_detected)
// B: pane_id 를 받는 agent_status_changed 까지 (되는지 자체가 측정 대상)
const paramFree = ['pane.created', 'pane.closed', 'pane.updated', 'pane.exited', 'pane.agent_detected']
const withParam = [...paramFree, { type: 'pane.agent_status_changed', pane_id: pane.pane_id }]

const a = await subscribe(paramFree.map((type) => ({ type })), 'A-파라미터없음')
const b = await subscribe(withParam.map((item) => (typeof item === 'string' ? { type: item } : item)), 'B-pane_id포함')

// --- ⓪ 먼저 **에이전트 없이** 순수 출력만 낸다 ---------------------------
// L7 이 묻는 것은 "출력이 있었다를 알 수 있는가" 다. 에이전트를 띄운 채로 재면 revision 이
// 출력 때문에 움직인 건지 에이전트 상태 때문에 움직인 건지 구별할 수 없다.
const plainAt = Date.now()
await request('pane.send_text', { pane_id: pane.pane_id, text: 'for i in 1 2 3 4 5; do echo hi-$i; sleep 1; done\n' })
await sleep(9000)
const plainUpdates = paneUpdates(a, pane.pane_id, plainAt)

// --- ① 에이전트를 실제로 띄운다 ------------------------------------------
const startedAt = Date.now()
await request('pane.send_text', { pane_id: pane.pane_id, text: `${AGENT_CMD}\n` })
// 기동을 시계로 재지 않는다 — herdr 가 "붙었다"고 말할 때까지 기다린다.
const detectedAt = await waitFor(a, (item) => normalize(item.event) === 'pane_agent_detected', 90000)
await sleep(3000)
await request('pane.send_text', { pane_id: pane.pane_id, text: `${PROMPT}\n` })
await sleep(1200)
await request('pane.send_keys', { pane_id: pane.pane_id, keys: ['Enter'] }).catch(() => {})
// working 이 보이면 그때부터 idle 로 돌아올 때까지 기다린다.
const workingAt = await waitFor(a, (item) => statusOf(item) === 'working', 90000)
const idleAt = workingAt === null ? null : await waitFor(a, (item) => statusOf(item) === 'idle', 120000, workingAt)
await sleep(1500)
const agentUpdates = paneUpdates(a, pane.pane_id, startedAt)

// 빠져나온다 — pane 을 원래대로 되돌린다.
await request('pane.send_keys', { pane_id: pane.pane_id, keys: ['C-c'] }).catch(() => {})
await sleep(800)
await request('pane.send_keys', { pane_id: pane.pane_id, keys: ['C-c'] }).catch(() => {})
await sleep(2000)
const during = readPane(a, b)

a.socket.destroy()
b.socket.destroy()

// --- ① 상태가 어느 경로로 왔나 ------------------------------------------
// **실측 주의**: 이 이벤트만 `event` 이름이 점을 유지한다 (`pane.agent_status_changed`).
// 나머지는 전부 밑줄이다 (`pane_updated`·`pane_agent_detected`). 두 표기 다 받는다.
const isStatus = (item) => normalize(item.event) === 'pane_agent_status_changed'
const statusFromA = a.events.filter(isStatus)
const statusFromB = b.events.filter(isStatus)
const detected = [...a.events, ...b.events].filter((item) => normalize(item.event) === 'pane_agent_detected')
const updatedWithStatus = a.events
  .filter((item) => normalize(item.event) === 'pane_updated')
  .map((item) => item.data?.pane?.agent_status)
  .filter((value) => value !== undefined)

// --- ② revision 이 움직였나 ---------------------------------------------
const revisions = paneUpdates(a, pane.pane_id, plainAt)
const distinctRevisions = [...new Set(revisions.map((item) => item.revision))]

const result = {
  measuredAt: new Date().toISOString(),
  session: SESSION,
  targetPane: pane.pane_id,
  agentCommand: AGENT_CMD,
  subscriptions: {
    A: { types: paramFree, accepted: a.ack, note: '지금 corral 이 여는 모양 + agent_detected' },
    B: {
      types: withParam,
      accepted: b.ack,
      note: 'pane_id 를 받는 pane.agent_status_changed 를 같은 요청에 섞었다',
    },
    finding:
      b.ack?.error === undefined
        ? 'pane_id 를 받는 타입도 같은 events.subscribe 에 섞을 수 있다 — 다만 pane 마다 걸어야 한다.'
        : `섞으면 거부된다: ${JSON.stringify(b.ack?.error)}`,
  },
  L6: {
    question: '상태 전이가 화면까지 올 수 있는가. 파라미터 없는 구독만으로도 오는가.',
    statusEventsOnParamFreeConnection: statusFromA.length,
    statusEventsOnPaneIdConnection: statusFromB.length,
    statusEnvelopeSamples: statusFromB.slice(0, 8).map((item) => ({ at: item.at - plainAt, ...item.raw })),
    agentDetectedSamples: detected.slice(0, 4).map((item) => item.raw),
    agentStatusesSeenOnPaneUpdated: [...new Set(updatedWithStatus)],
    agentDetectedAtMs: detectedAt === null ? null : detectedAt - startedAt,
    workingAtMs: workingAt === null ? null : workingAt - startedAt,
    idleAtMs: idleAt === null ? null : idleAt - startedAt,
    sawWorkingThenIdle: workingAt !== null && idleAt !== null,
    transitions: statusFromB.map((item) => ({
      at: item.at - plainAt,
      status: item.data?.agent_status,
      agent: item.data?.agent ?? null,
      displayAgent: item.data?.display_agent ?? null,
      title: item.data?.title ?? null,
    })),
  },
  L7: {
    question: 'pane.updated 의 revision 이 이벤트 경로에서 움직이는가 (LIFE-342 §2.2 미검증 공백)',
    // 두 구간을 나눠 본다 — **출력만 났을 때**와 **에이전트가 붙었다 떨어질 때**.
    plainOutputWindow: {
      what: 'echo 5줄 + sleep — 에이전트 없이 순수 출력만',
      paneUpdatedEvents: plainUpdates.length,
      revisions: plainUpdates,
      movedWithOutput: new Set(plainUpdates.map((item) => item.revision)).size > 1,
    },
    agentWindow: {
      what: '에이전트 기동 → 프롬프트 → 종료',
      paneUpdatedEvents: agentUpdates.length,
      revisions: agentUpdates,
    },
    paneUpdatedEvents: revisions.length,
    distinctRevisions,
    moves: distinctRevisions.length > 1,
    samples: revisions.slice(0, 20),
  },
  rawCounts: {
    A: countByEvent(a.events),
    B: countByEvent(b.events),
  },
  paneAfter: during,
}

result.L6.conclusion =
  statusFromB.length === 0 && updatedWithStatus.length === 0
    ? '상태 전이를 한 건도 못 봤다 — 이 측정으로는 L6 을 판정할 수 없다(보류).'
    : statusFromA.length > 0
      ? '파라미터 없는 구독만으로도 상태 전이가 온다 — pane 마다 구독을 걸 필요가 없다.'
      : `상태 전이는 pane_id 를 건 구독으로만 왔다 (${statusFromB.length}건). pane 마다 구독이 필요하다.`
result.L7.conclusion = !result.L7.moves
  ? `pane.updated 가 ${revisions.length}건 왔는데 revision 이 ${JSON.stringify(distinctRevisions)} 로 고정이다 — ` +
    '"출력이 있었다"를 이 경로로는 알 수 없다. 경과 시간은 보류.'
  : result.L7.plainOutputWindow.movedWithOutput
    ? 'revision 이 **순수 출력만으로도** 움직인다 — "마지막 출력 시각"을 이걸로 만들 수 있다.'
    : 'revision 은 움직이지만 **출력만으로는 안 움직인다** (에이전트가 붙거나 떨어질 때만 왔다). ' +
      '그래서 이 경로로 만들 수 있는 것은 "마지막 출력 이후"가 아니라 **"상태가 바뀐 지"** 다. ' +
      'Orca 의 경과와 뜻이 다르므로 그대로 쓰면 틀린 값이 된다.'

writeRaw('36-agent-status-and-revision.json', result)
console.log(
  JSON.stringify(
    {
      subscribeB: result.subscriptions.finding,
      statusA: statusFromA.length,
      statusB: statusFromB.length,
      transitions: result.L6.transitions.map((item) => `${item.at}ms ${item.status} ${item.agent ?? ''}`),
      revisionMoves: result.L7.moves,
      revisionMovedWithPlainOutput: result.L7.plainOutputWindow.movedWithOutput,
      distinctRevisions,
      sawWorkingThenIdle: result.L6.sawWorkingThenIdle,
    },
    null,
    2,
  ),
)
await run('herdr', ['api', 'snapshot']).catch(() => {})

function countByEvent(events) {
  const out = {}
  for (const item of events) out[item.event] = (out[item.event] ?? 0) + 1
  return out
}

function readPane(a, b) {
  return { aEvents: a.events.length, bEvents: b.events.length }
}

/** 구독 커넥션 하나. ack 원문과 push 원문을 그대로 들고 있는다. */
function subscribe(subscriptions, label) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCK)
    socket.setEncoding('utf8')
    const events = []
    let buffer = ''
    let ack = null
    let settled = false
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index === -1) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length === 0) continue
        const message = JSON.parse(line)
        if (message.event) {
          events.push({ at: Date.now(), event: message.event, data: message.data, raw: message })
        } else if (!settled) {
          ack = message
          settled = true
          resolve({ socket, events, ack, label })
        }
      }
    })
    socket.on('connect', () =>
      socket.write(JSON.stringify({ id: label, method: 'events.subscribe', params: { subscriptions } }) + '\n'),
    )
    setTimeout(() => {
      if (!settled) {
        settled = true
        resolve({ socket, events, ack: { timeout: true }, label })
      }
    }, 5000)
  })
}

/** 이벤트 이름 표기를 하나로 맞춘다 — herdr 는 대부분 밑줄인데 상태 이벤트만 점을 유지한다. */
function normalize(event) {
  return String(event).replace(/\./g, '_')
}

function statusOf(item) {
  if (normalize(item.event) === 'pane_agent_status_changed') return item.data?.agent_status ?? null
  if (normalize(item.event) === 'pane_updated') return item.data?.pane?.agent_status ?? null
  return null
}

function paneUpdates(conn, paneId, since) {
  return conn.events
    .filter((item) => normalize(item.event) === 'pane_updated' && item.data?.pane?.pane_id === paneId && item.at >= since)
    .map((item) => ({ at: item.at - since, revision: item.data.pane.revision, agentStatus: item.data.pane.agent_status }))
}

/** 조건에 맞는 이벤트가 올 때까지 기다린다. 돌려주는 값은 도착 시각(없으면 null). */
async function waitFor(conn, predicate, timeoutMs, after = 0) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = conn.events.find((item) => item.at > after && predicate(item))
    if (hit) return hit.at
    await sleep(200)
  }
  return null
}
