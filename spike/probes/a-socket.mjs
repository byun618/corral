// ⓐ 소켓 직결 + 구독 스트림 — A1·A2·A3·A4·A6
// A5(서버 강제 종료 후 복구)는 세션을 죽이므로 a5-reconnect.mjs 로 분리했다.
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/a-socket.mjs

import { Conn, call, withConn } from '../lib/herdr.mjs'
import { Raw, sleep } from '../lib/raw.mjs'

const raw = new Raw('a-socket')
const R = {}

// 푸시되는 이벤트 이름은 밑줄, 구독 타입은 점이다.
const EV = { created: 'pane_created', closed: 'pane_closed' }

process.on('unhandledRejection', (e) => {
  raw.log('unhandledRejection', { error: String(e) })
  console.error('unhandledRejection', e)
})

/** 요청 1건 = 커넥션 1개. 서버가 응답 후 커넥션을 닫기 때문이다 (A2-x1 참조). */
async function one(method, params = {}) {
  return withConn((c) => c.request(method, params), {
    onLine: ({ line }) => raw.wire('rx', line, { method }),
  }).then((r) => {
    raw.log('request', { method, params, ok: !!r.result, error: r.error ?? null })
    return r
  })
}

// --- A1 연결·왕복 --------------------------------------------------------
{
  const r = await one('ping', {})
  R.A1 = { pass: !!r.result && r.result.type === 'pong', response: r.result ?? r.error }
  console.log('A1', R.A1.pass ? 'PASS' : 'FAIL', JSON.stringify(R.A1.response))
}

// --- A2-x1 커넥션 수명: 응답 1건 뒤 서버가 닫는가 -------------------------
// 한 줄에 두 요청을 파이프라인해서 보낸다. 둘 다 답하면 커넥션이 유지되는 것이고,
// 첫 응답 뒤 close 가 오면 요청당 커넥션 1개가 강제된다.
async function rawSession({ label, writes, holdMs }) {
  return new Promise((resolve) => {
    const events = []
    const c = new Conn({
      onLine: ({ at, line }) => {
        raw.wire('rx', line, { label })
        events.push({ ms: at, dir: 'rx', line })
      },
      onEvent: () => {},
      onClose: () => {
        events.push({ ms: Date.now(), dir: 'close' })
        resolve(events)
      },
    })
    c.connect().then(async () => {
      for (const w of writes) {
        if (typeof w === 'number') {
          await sleep(w)
          continue
        }
        raw.wire('tx', w.trimEnd(), { label })
        events.push({ ms: Date.now(), dir: 'tx', line: w.trimEnd() })
        if (c.closed) {
          events.push({ ms: Date.now(), dir: 'tx-after-close' })
          break
        }
        try {
          c.sock.write(w)
        } catch (err) {
          events.push({ ms: Date.now(), dir: 'tx-error', line: String(err) })
        }
      }
      await sleep(holdMs)
      c.end()
      resolve(events)
    })
  })
}

const req = (id, method, params = {}) => JSON.stringify({ id, method, params }) + '\n'

{
  const ev = await rawSession({
    label: 'A2-x1-pipeline',
    writes: [req('a', 'ping') + req('b', 'pane.list')],
    holdMs: 800,
  })
  const answered = ev.filter((e) => e.dir === 'rx').map((e) => JSON.parse(e.line).id)
  const closedByServer = ev.some((e) => e.dir === 'close')
  R.A2x1 = { answered, closedByServer, note: '한 write 에 요청 2건을 파이프라인' }
  console.log('A2-x1 answered=', answered, 'serverClosed=', closedByServer)
}

// --- A2 다중 구독 + push 수신 -------------------------------------------
// 한 커넥션에서 events.subscribe 로 3종 동시 구독 → ack → 다른 커넥션에서 pane 을
// 만들고 지워 push 가 실제로 오는지 본다.
{
  const got = []
  let ack = null
  const c = new Conn({
    onLine: ({ at, line }) => {
      raw.wire('rx', line, { label: 'A2-sub' })
      const m = JSON.parse(line)
      if (m.id === 's1') ack = { at, msg: m }
      else got.push({ at, msg: m })
    },
  })
  await c.connect()
  const subs = [{ type: 'pane.created' }, { type: 'pane.closed' }, { type: 'layout.updated' }]
  const txt = req('s1', 'events.subscribe', { subscriptions: subs })
  raw.wire('tx', txt.trimEnd(), { label: 'A2-sub' })
  c.sock.write(txt)
  await sleep(300)

  // push 유발: 별도 커넥션에서 pane 을 만들고 닫는다.
  const split = await one('pane.split', { direction: 'right' })
  const newPane = split.result?.pane?.pane_id
  await sleep(400)
  if (newPane) await one('pane.close', { pane_id: newPane })
  await sleep(600)
  const alive = !c.closed
  c.end()

  const kinds = got.map((g) => g.msg.type ?? g.msg.event?.type ?? JSON.stringify(g.msg).slice(0, 60))
  R.A2 = {
    subscribed: subs.map((s) => s.type),
    ack: ack?.msg?.result ?? null,
    pushCount: got.length,
    pushKinds: kinds,
    connectionAliveAfterPush: alive,
    pass: !!ack?.msg?.result && got.length > 0,
  }
  console.log('A2', R.A2.pass ? 'PASS' : 'FAIL', 'pushes=', got.length, kinds)
}

// --- A2-x2 ack 이후 같은 커넥션에 요청을 섞을 수 있는가 -------------------
{
  const ev = await rawSession({
    label: 'A2-x2-mix',
    writes: [
      req('s1', 'events.subscribe', { subscriptions: [{ type: 'pane.created' }] }),
      400,
      req('p1', 'ping'),
      400,
    ],
    holdMs: 600,
  })
  const rxIds = ev.filter((e) => e.dir === 'rx').map((e) => JSON.parse(e.line).id)
  const txPing = ev.findIndex((e) => e.dir === 'tx' && e.line.includes('"ping"'))
  const closeIdx = ev.findIndex((e) => e.dir === 'close')
  R.A2x2 = {
    rxIds,
    pingAnswered: rxIds.includes('p1'),
    serverClosedAfterPing: closeIdx > txPing && txPing !== -1,
    msFromPingToClose:
      closeIdx > -1 && txPing > -1 ? ev[closeIdx].ms - ev[txPing].ms : null,
  }
  console.log('A2-x2 pingAnswered=', R.A2x2.pingAnswered, 'closedAfterPing=', R.A2x2.serverClosedAfterPing)
}

// --- A2-x3 같은 커넥션에 events.subscribe 를 두 번 ------------------------
{
  const ev = await rawSession({
    label: 'A2-x3-double-sub',
    writes: [
      req('s1', 'events.subscribe', { subscriptions: [{ type: 'pane.created' }] }),
      400,
      req('s2', 'events.subscribe', { subscriptions: [{ type: 'pane.focused' }] }),
      400,
    ],
    holdMs: 600,
  })
  const rxIds = ev.filter((e) => e.dir === 'rx').map((e) => JSON.parse(e.line).id)
  R.A2x3 = { rxIds, secondAcked: rxIds.includes('s2'), closed: ev.some((e) => e.dir === 'close') }
  console.log('A2-x3 secondAcked=', R.A2x3.secondAcked)
}

// --- A3 이벤트 도달: 10회 유발 → 10/10 --------------------------------
{
  const got = []
  const c = new Conn({
    onLine: ({ at, line }) => {
      raw.wire('rx', line, { label: 'A3' })
      const m = JSON.parse(line)
      if (m.id !== 's1') got.push({ at, msg: m })
    },
  })
  await c.connect()
  const txt = req('s1', 'events.subscribe', {
    subscriptions: [{ type: 'pane.created' }, { type: 'pane.closed' }],
  })
  raw.wire('tx', txt.trimEnd(), { label: 'A3' })
  c.sock.write(txt)
  await sleep(400)

  const triggers = []
  for (let i = 0; i < 5; i++) {
    const s = await one('pane.split', { direction: 'right' })
    const id = s.result?.pane?.pane_id
    triggers.push({ i, action: 'split', pane_id: id ?? null, error: s.error ?? null })
    raw.log('trigger', { i, action: 'split', pane_id: id })
    await sleep(250)
    const cl = await one('pane.close', { pane_id: id })
    triggers.push({ i, action: 'close', pane_id: id, error: cl.error ?? null })
    raw.log('trigger', { i, action: 'close', pane_id: id })
    await sleep(250)
  }
  await sleep(1200)
  c.end()

  const created = got.filter((g) => kindOf(g.msg) === EV.created)
  const closed = got.filter((g) => kindOf(g.msg) === EV.closed)
  const wantIds = triggers.filter((t) => t.action === 'split' && t.pane_id).map((t) => t.pane_id)
  const createdIds = created.map((g) => paneIdOf(g.msg))
  const closedIds = closed.map((g) => paneIdOf(g.msg))
  R.A3 = {
    triggered: 10,
    createdEvents: created.length,
    closedEvents: closed.length,
    delivered: created.length + closed.length,
    wantIds,
    createdIds,
    closedIds,
    missing: wantIds.filter((id) => !createdIds.includes(id) || !closedIds.includes(id)),
    otherEventKinds: got.map((g) => kindOf(g.msg)).filter((k) => ![EV.created, EV.closed].includes(k)),
    pass: created.length === 5 && closed.length === 5,
  }
  console.log('A3', R.A3.pass ? 'PASS' : 'FAIL', `${R.A3.delivered}/10`)
}

// 푸시 봉투는 {"event":"pane_created","data":{"type":"pane_created","pane":{...}}} 이다.
// 구독 타입은 점(pane.created), 푸시되는 이름은 밑줄(pane_created) — 이름이 다르다.
function kindOf(m) {
  return m.event ?? m.data?.type ?? null
}
function paneIdOf(m) {
  return m.data?.pane?.pane_id ?? m.data?.pane_id ?? null
}

// --- A4 초기 상태 정합 (문서가 고정한 부트스트랩 절차) -------------------
// ① subscribe + ack ② 스트림을 버퍼링한 채 session.snapshot ③ 스냅샷 설치 후
//    버퍼 이벤트를 순서대로 적용. 스냅샷은 별도 커넥션이어야 한다 (A2-x2 결과).
// 검증: 부트스트랩이 도는 동안 pane 을 계속 만들고 지운다.
//       수렴한 pane 집합이 마지막에 실제 pane.list 와 같아야 한다.
{
  const buffered = []
  let ack = false
  const c = new Conn({
    onLine: ({ at, line }) => {
      raw.wire('rx', line, { label: 'A4' })
      const m = JSON.parse(line)
      if (m.id === 's1') {
        ack = true
        return
      }
      buffered.push({ at, msg: m })
    },
  })
  await c.connect()
  const txt = req('s1', 'events.subscribe', {
    subscriptions: [{ type: 'pane.created' }, { type: 'pane.closed' }],
  })
  raw.wire('tx', txt.trimEnd(), { label: 'A4' })
  c.sock.write(txt)
  while (!ack) await sleep(20)
  raw.log('A4.ack', {})

  // 부트스트랩 도중에 변화를 계속 일으키는 백그라운드 작업.
  const churn = (async () => {
    const made = []
    for (let i = 0; i < 4; i++) {
      const s = await one('pane.split', { direction: 'right' })
      const id = s.result?.pane?.pane_id
      made.push(id)
      raw.log('A4.churn', { action: 'split', pane_id: id })
      await sleep(120)
    }
    // 절반은 다시 닫는다 — 스냅샷에 있었다가 사라지는 것을 만든다.
    for (const id of made.slice(0, 2)) {
      await one('pane.close', { pane_id: id })
      raw.log('A4.churn', { action: 'close', pane_id: id })
      await sleep(120)
    }
    return made
  })()

  await sleep(150) // 스냅샷을 churn 한복판에서 찍는다
  const snapT0 = Date.now()
  const snap = await one('session.snapshot', {})
  const snapT1 = Date.now()
  raw.log('A4.snapshot', { ms: snapT1 - snapT0 })

  const made = await churn
  await sleep(1200)
  const afterBuffered = buffered.length
  c.end()

  // ③ 스냅샷 설치 후 버퍼 이벤트를 순서대로 적용 — 상태 모델은 pane_id 집합뿐이다.
  const state = new Set(panesInSnapshot(snap.result))
  const snapshotSet = [...state]
  const applied = []
  let dupCreate = 0
  let missingClose = 0
  for (const b of buffered) {
    // 스냅샷보다 앞선 이벤트도 그대로 적용한다 — 문서 절차에는 필터가 없다.
    const k = kindOf(b.msg)
    const id = paneIdOf(b.msg)
    if (!id) continue
    if (k === EV.created) {
      if (state.has(id)) dupCreate++
      state.add(id)
      applied.push(['+', id])
    } else if (k === EV.closed) {
      if (!state.has(id)) missingClose++
      state.delete(id)
      applied.push(['-', id])
    }
  }
  const live = await one('pane.list', {})
  const actual = (live.result?.panes ?? []).map((p) => p.pane_id).sort()
  const converged = [...state].sort()
  R.A4 = {
    snapshotMs: snapT1 - snapT0,
    snapshotPanes: snapshotSet.sort(),
    bufferedEvents: afterBuffered,
    appliedOps: applied,
    churnPanes: made,
    convergedSet: converged,
    actualSet: actual,
    // 중복반영 = 스냅샷에 이미 있는 pane 에 create 가 또 적용됨
    duplicateCreates: dupCreate,
    // 유실 = 모르는 pane 에 close 가 옴 (스냅샷·버퍼 어디에도 create 가 없었음)
    closeWithoutCreate: missingClose,
    pass: JSON.stringify(converged) === JSON.stringify(actual),
  }
  console.log('A4', R.A4.pass ? 'PASS' : 'FAIL', 'converged=', converged, 'actual=', actual)
}

function panesInSnapshot(result) {
  const out = []
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (n && typeof n === 'object') {
      if (typeof n.pane_id === 'string') out.push(n.pane_id)
      Object.values(n).forEach(walk)
    }
  }
  walk(result)
  return [...new Set(out)]
}

// --- A6 버전 계약 -------------------------------------------------------
{
  const t = {}
  // (1) 미지원 메서드 — 에러로 돌아오는가, 응답에 id 가 실려 오는가
  // 주의: 에러 응답은 id 를 잃는다("id":"")— 요청 id 로 찾으면 응답을 놓친다.
  {
    const ev = await rawSession({
      label: 'A6-unknown-method',
      writes: [req('u1', 'corral.does_not_exist', { x: 1 }), 400],
      holdMs: 400,
    })
    const rx = ev.filter((e) => e.dir === 'rx').map((e) => JSON.parse(e.line))
    t.unknownMethod = {
      responded: rx.length > 0,
      response: rx[0] ?? null,
      idEchoed: rx[0]?.id === 'u1',
      // 커넥션은 어차피 응답 1건 뒤 닫힌다 (A2-x1). 에러라서 닫힌 게 아니다.
      note: '에러도 정상 응답과 같은 수명 — 응답 1건 뒤 서버가 닫는다',
    }
  }
  // (1b) 유효한 메서드 + 없는 pane_id — 의미 에러도 id 를 잃는가
  {
    const ev = await rawSession({
      label: 'A6-semantic-error',
      writes: [req('u3', 'pane.read', { pane_id: 'w9:p99', source: 'visible' }), 400],
      holdMs: 400,
    })
    const rx = ev.filter((e) => e.dir === 'rx').map((e) => JSON.parse(e.line))
    t.semanticError = { response: rx[0] ?? null, idEchoed: rx[0]?.id === 'u3' }
  }
  // (2) 알려진 메서드 + 모르는 필드 — 서버가 unknown 필드를 무시하는가
  {
    const c = new Conn({ onLine: ({ line }) => raw.wire('rx', line, { label: 'A6-unknown-field' }) })
    await c.connect()
    const r = await c.requestRaw({
      method: 'pane.read',
      params: {
        pane_id: (await currentPane()),
        source: 'visible',
        corral_future_field: 'hello',
        another_unknown: { nested: true },
      },
    })
    c.end()
    t.unknownParamField = { ok: !!r.result, error: r.error ?? null }
  }
  // (3) 모르는 구독 타입
  {
    const ev = await rawSession({
      label: 'A6-unknown-subscription',
      writes: [
        req('s1', 'events.subscribe', {
          subscriptions: [{ type: 'pane.created' }, { type: 'corral.future_event' }],
        }),
        300,
      ],
      holdMs: 500,
    })
    const rx = ev.filter((e) => e.dir === 'rx').map((e) => JSON.parse(e.line))
    t.unknownSubscriptionType = {
      response: rx[0] ?? null,
      idEchoed: rx[0]?.id === 's1',
      // 알려진 타입 하나가 같이 들어 있었는데도 요청 전체가 거부됐는지
      wholeRequestRejected: !!rx[0]?.error,
    }
  }
  // (4) 봉투 자체에 모르는 최상위 필드
  {
    const c = new Conn({ onLine: ({ line }) => raw.wire('rx', line, { label: 'A6-unknown-envelope' }) })
    await c.connect()
    const r = await c.requestRaw({ method: 'ping', params: {}, corral_extra: 1 })
    c.end()
    t.unknownEnvelopeField = { ok: !!r.result, error: r.error ?? null }
  }
  R.A6 = t
  console.log('A6', JSON.stringify(t).slice(0, 400))
}

async function currentPane() {
  const l = await call('pane.list', {})
  return l.result.panes[0].pane_id
}

// --- 정리: 프로브가 만든 pane 을 닫는다 (원래 pane 1개만 남긴다) ------------
{
  const live = await one('pane.list', {})
  const ids = (live.result?.panes ?? []).map((p) => p.pane_id)
  const keep = ids[0]
  for (const id of ids.slice(1)) await one('pane.close', { pane_id: id })
  raw.log('cleanup', { kept: keep, closed: ids.slice(1) })
  console.log('cleanup: kept', keep, 'closed', ids.slice(1))
}

raw.close({ probe: 'a-socket', at: new Date().toISOString(), results: R })
process.exit(0)
