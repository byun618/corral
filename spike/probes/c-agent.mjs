// ⓒ agent.prompt / agent.wait 왕복 — C1~C4, C6
// C5(엣지: blocked·stalled·unknown)는 c5-edge.mjs 로 분리했다.
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/c-agent.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Conn, RAW_DIR } from '../lib/herdr.mjs'
import { Raw, sleep } from '../lib/raw.mjs'
import { makeApi } from '../lib/pane.mjs'

const raw = new Raw('c-agent')
const api = makeApi(raw)
const R = {}
const CWD =
  '/private/tmp/claude-501/-Users-byun-repos-byun618-corral--claude-worktrees-LIFE-342-spike-claude/dff7969e-c926-4faf-acc3-8fc408797d67/scratchpad/agents'
fs.mkdirSync(CWD, { recursive: true })

// 이전 실행이 남긴 pane(과 그 위의 에이전트)을 먼저 치운다 — 이름이 겹치면 agent_name_taken.
{
  const ps = (await api('pane.list', {})).panes
  for (const p of ps.slice(1)) await api('pane.close', { pane_id: p.pane_id })
  await sleep(800)
}

// --- 상태 전이를 구독으로 따로 받아둔다 (C4 의 근거) ----------------------
// 구독 커넥션은 push 전용이라 (A2-x2) 요청은 다른 커넥션으로 나간다.
const transitions = []
const sub = new Conn({
  onLine: ({ at, line }) => {
    raw.wire('rx', line, { label: 'agent-status' })
    const m = JSON.parse(line)
    if (m.id === 'sub') return
    transitions.push({ at, event: m.event, pane_id: m.data?.pane_id, status: m.data?.agent_status ?? null })
  },
})
await sub.connect()

async function subscribeStatus(paneIds) {
  const subs = [
    { type: 'pane.agent_detected' },
    ...paneIds.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
  ]
  const t = JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: subs } }) + '\n'
  raw.wire('tx', t.trimEnd(), { label: 'agent-status' })
  sub.sock.write(t)
  await sleep(300)
}

// --- C1 기동 -------------------------------------------------------------
async function startAgent({ name, kind, args }) {
  const sp = await api('pane.split', { direction: 'right', cwd: CWD })
  const paneId = sp.pane.pane_id
  await sleep(1500)
  const t0 = Date.now()
  // 갓 만든 pane 은 셸이 뜨기 전이라 agent_pane_busy 로 거부된다. 될 때까지 재시도한다.
  let res = null
  const startAttempts = []
  for (let i = 0; i < 10; i++) {
    try {
      res = await api(
        'agent.start',
        { name, kind, pane_id: paneId, ...(args ? { args } : {}), timeout_ms: 120000 },
        { timeoutMs: 130000 },
      )
      startAttempts.push({ i, ok: true })
      break
    } catch (err) {
      startAttempts.push({ i, ok: false, error: String(err).slice(0, 160) })
      if (!String(err).includes('agent_pane_busy')) throw err
      await sleep(1000)
    }
  }
  if (!res) throw new Error(`agent.start 가 계속 agent_pane_busy: ${JSON.stringify(startAttempts)}`)
  raw.log('agent.start.attempts', { name, startAttempts })
  // agent.start 는 즉시 돌아온다 (launch_pending). 준비될 때까지는 따로 기다려야 한다.
  const settle = []
  let ready = null
  const unblocks = []
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const a = (await api('agent.list', {})).agents.find((x) => x.name === name)
    settle.push({ ms: Date.now() - t0, status: a?.agent_status ?? null, launchPending: a?.launch_pending ?? null })
    // 첫 기동은 신뢰 확인 화면에서 blocked 로 선다.
    // --dangerously-skip-permissions 를 줘도 이 화면은 뜬다 (실측).
    // herdr 는 blocked 라고 정확히 알려주지만, 푸는 키는 에이전트마다 달라서 API 밖이다.
    if (a?.agent_status === 'blocked') {
      const screen = (await api('agent.read', { target: name, source: 'visible', format: 'text' })).read?.text ?? ''
      // 푸는 키가 에이전트마다 다르다 — herdr 는 blocked 라고 알려주지만 해제는 API 밖이다.
      const recipe = /Yes, I trust|trust this folder/i.test(screen)
        ? { keys: [['down'], ['enter']], why: 'claude 신뢰 확인' }
        : /Update available|Skip until next version/i.test(screen)
          ? { keys: [['2'], ['enter']], why: 'codex 업데이트 안내' }
          : null
      if (recipe) {
        for (const k of recipe.keys) {
          await api('agent.send_keys', { target: name, keys: k })
          await sleep(300)
        }
        unblocks.push({ ms: Date.now() - t0, why: recipe.why, keys: recipe.keys.flat() })
        raw.log('agent.unblock', { name, why: recipe.why, ms: Date.now() - t0 })
        await sleep(2500)
        continue
      }
      raw.log('agent.blocked.unknownScreen', { name, screen: screen.slice(0, 600) })
    }
    // launch_pending 은 기동이 끝나면 false 가 아니라 아예 빠진다(undefined).
    // === false 로 기다리면 영원히 안 온다 — 실측으로 물린 지점이다.
    if (a && !a.launch_pending && a.agent_status !== 'unknown' && a.agent_status !== 'blocked') {
      ready = Date.now() - t0
      break
    }
    await sleep(1000)
  }
  raw.log('agent.start', { name, agentKind: kind, paneId, startMs: Date.now() - t0, readyMs: ready, settle, unblocks })
  return { name, paneId, startResponse: res, readyMs: ready, settle, unblocks, startAttempts }
}

const a1 = await startAgent({ name: 'spike-a', kind: 'claude', args: ['--dangerously-skip-permissions'] })
await subscribeStatus([a1.paneId])
R.C1 = {
  name: a1.name,
  paneId: a1.paneId,
  startedType: a1.startResponse.type,
  launchPendingOnReturn: a1.startResponse.agent?.launch_pending ?? null,
  statusOnReturn: a1.startResponse.agent?.agent_status ?? null,
  readyMs: a1.readyMs,
  unblocksNeeded: a1.unblocks,
  startAttempts: a1.startAttempts,
  pass: a1.startResponse.type === 'agent_started' && a1.readyMs !== null,
  note:
    'agent.start 는 기동을 기다리지 않는다 — launch_pending:true 로 즉시 반환. 준비 대기는 호출자 몫. ' +
    '기동이 끝나면 launch_pending 이 false 가 되는 게 아니라 필드가 사라진다',
}
console.log('C1', R.C1.pass ? 'PASS' : 'FAIL', `readyMs=${a1.readyMs}`)

// --- C2 왕복 + C4 상태 신뢰도 --------------------------------------------
// 정답 토큰을 확인해 "settled 라는데 진짜 끝났나"를 검증한다.
// 토큰을 프롬프트에 그대로 쓰면 화면의 프롬프트 에코가 정답으로 오인된다.
// 두 조각을 붙여 답하게 해서 정답 문자열이 프롬프트에 없도록 한다.
const ROUNDS = [
  { token: 'ALPHA1', text: 'ALP 와 HA1 을 붙여서 한 단어로만 답해. 다른 말은 하지 마.' },
  { token: 'BETA2', text: 'BET 와 A2 를 붙여서 한 단어로만 답해. 다른 말은 하지 마.' },
  { token: 'GAMMA3', text: 'GAM 과 MA3 을 붙여서 한 단어로만 답해. 다른 말은 하지 마.' },
]

/**
 * agent.read. working 중에 lines 를 키우면 agent_not_idle 로 거부된다 —
 * "알트스크린 히스토리는 idle 일 때 스크롤해야 잡힌다"는 게 서버 메시지다.
 * 거부되면 visible 로 물러서고, 그 사실을 남긴다 (C3 의 근거).
 */
const readFallbacks = []
async function agentText(name, source = 'recent', lines = 400) {
  try {
    const r = await api('agent.read', { target: name, source, lines, format: 'text' })
    return r.read?.text ?? r.text ?? ''
  } catch (err) {
    if (!String(err).includes('agent_not_idle')) throw err
    readFallbacks.push({ name, source, lines, error: String(err).slice(0, 200) })
    const r = await api('agent.read', { target: name, source: 'visible', format: 'text' })
    return r.read?.text ?? r.text ?? ''
  }
}

const rounds = []
for (const [i, r] of ROUNDS.entries()) {
  const before = transitions.length
  const t0 = Date.now()
  let waitRes = null
  let waitErr = null
  try {
    waitRes = await api(
      'agent.prompt',
      { target: a1.name, text: r.text, wait: { until: ['idle', 'done'], timeout_ms: 180000 } },
      { timeoutMs: 190000 },
    )
  } catch (err) {
    waitErr = String(err)
  }
  const elapsed = Date.now() - t0
  // settled 직후 화면에 정답이 실제로 있는가
  const textAfter = await agentText(a1.name, 'recent', 400)
  const visible = await agentText(a1.name, 'visible')
  const found = textAfter.includes(r.token) || visible.includes(r.token)
  rounds.push({
    i,
    token: r.token,
    elapsedMs: elapsed,
    waitResultType: waitRes?.type ?? null,
    statusReported: waitRes?.agent?.agent_status ?? waitRes?.status ?? null,
    error: waitErr,
    answerOnScreen: found,
    transitions: transitions.slice(before).map((t) => ({ ms: t.at - t0, status: t.status })),
  })
  raw.log('C2.round', rounds[rounds.length - 1])
  console.log(`  왕복 ${i}: ${elapsed}ms status=${rounds[rounds.length - 1].statusReported} 정답화면=${found}`)
  await sleep(1500)
}
R.C2 = {
  rounds,
  pass: rounds.every((x) => !x.error && x.waitResultType),
  note: 'agent.prompt 의 wait 옵션으로 제출과 대기를 한 요청에 담았다',
}
R.C4 = {
  rounds: rounds.map((x) => ({ token: x.token, settled: x.statusReported, answerOnScreen: x.answerOnScreen })),
  // 오탐 = settled 라고 했는데 정답이 화면에 없음
  falsePositives: rounds.filter((x) => x.waitResultType && !x.answerOnScreen).length,
  // 고착 = 정답은 나왔는데 wait 가 타임아웃
  stuck: rounds.filter((x) => x.error && x.answerOnScreen).length,
  pass: rounds.filter((x) => x.waitResultType && !x.answerOnScreen).length === 0 && rounds.every((x) => !x.error),
}
console.log('C2', R.C2.pass ? 'PASS' : 'FAIL', '| C4 오탐', R.C4.falsePositives)

// --- C2 대조군: prompt 와 wait 를 따로 부르면 -----------------------------
{
  const t0 = Date.now()
  const p = await api('agent.prompt', { target: a1.name, text: 'DEL 과 TA4 를 붙여서 한 단어로만 답해.' }, { timeoutMs: 60000 })
  const promptMs = Date.now() - t0
  let w = null
  let werr = null
  try {
    w = await api(
      'agent.wait',
      { target: a1.name, until: ['idle', 'done'], timeout_ms: 180000 },
      { timeoutMs: 190000 },
    )
  } catch (err) {
    werr = String(err)
  }
  const txt = await agentText(a1.name, 'recent', 400)
  R.C2_separate = {
    promptReturnMs: promptMs,
    promptResultType: p.type,
    waitResultType: w?.type ?? null,
    waitError: werr,
    totalMs: Date.now() - t0,
    answerOnScreen: txt.includes('DELTA4'),
    note: 'prompt 와 wait 를 따로 부르는 경로. 레이스 여부를 보려는 대조군',
  }
  console.log('C2 대조군(분리 호출):', JSON.stringify(R.C2_separate))
}

// --- C3 결과 회수 --------------------------------------------------------
{
  const tries = []
  for (const [source, lines] of [
    ['visible', null],
    ['recent', 100],
    ['recent', 1000],
    ['recent_unwrapped', 1000],
    ['detection', null],
  ]) {
    const t = await agentText(a1.name, source, lines ?? undefined)
    tries.push({
      source,
      lines,
      bytes: t.length,
      hasAlpha: t.includes('ALPHA1'),
      hasBeta: t.includes('BETA2'),
      hasGamma: t.includes('GAMMA3'),
      hasDelta: t.includes('DELTA4'),
      tail: t.slice(-200),
    })
  }
  fs.writeFileSync(path.join(RAW_DIR, 'c3-agent-read.txt'), JSON.stringify(tries, null, 2))
  // 파일 경유 폴백: 에이전트에게 파일로 쓰게 하고 그 파일을 읽는다
  const outFile = path.join(CWD, 'c3-answer.txt')
  fs.rmSync(outFile, { force: true })
  await api(
    'agent.prompt',
    {
      target: a1.name,
      text: `${outFile} 파일에 EPSILON5 한 줄만 써. 답변으로는 완료라고만 해.`,
      wait: { until: ['idle', 'done'], timeout_ms: 180000 },
    },
    { timeoutMs: 190000 },
  )
  const fileWorked = fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8').includes('EPSILON5')
  R.C3 = {
    reads: tries,
    notIdleFallbacks: readFallbacks,
    // 지난 왕복의 답을 몇 개나 되찾았는가
    oldAnswersRecovered: tries.map((t) => [t.source, t.lines, [t.hasAlpha, t.hasBeta, t.hasGamma, t.hasDelta].filter(Boolean).length]),
    fileFallbackWorks: fileWorked,
    note: 'agent.read 로 본문이 되찾아지는지 / 파일 경유 폴백이 유일한 길인지',
  }
  console.log('C3 회수:', JSON.stringify(R.C3.oldAnswersRecovered), '파일폴백=', fileWorked)
}

// --- C6 에이전트 2개 동시 ------------------------------------------------
{
  const a2 = await startAgent({ name: 'spike-b', kind: 'codex', args: [] })
  R.C6_start = { name: a2.name, readyMs: a2.readyMs, settle: a2.settle.slice(-3) }
  if (a2.readyMs === null) {
    R.C6 = { pass: false, reason: 'codex 가 120초 안에 준비 상태로 안 들어왔다', settle: a2.settle.slice(-5) }
    console.log('C6 codex 기동 실패 — settle 마지막:', JSON.stringify(a2.settle.slice(-3)))
  } else {
    // 두 에이전트에 서로 다른 토큰을 동시에 던진다
    const [ra, rb] = await Promise.allSettled([
      api(
        'agent.prompt',
        { target: 'spike-a', text: 'ZET 와 A6 을 붙여서 한 단어로만 답해.', wait: { until: ['idle', 'done'], timeout_ms: 180000 } },
        { timeoutMs: 190000 },
      ),
      api(
        'agent.prompt',
        { target: 'spike-b', text: 'ET 와 A7 을 붙여서 한 단어로만 답해.', wait: { until: ['idle', 'done'], timeout_ms: 180000 } },
        { timeoutMs: 190000 },
      ),
    ])
    const ta = await agentText('spike-a', 'recent', 400)
    const tb = await agentText('spike-b', 'recent', 400)
    R.C6 = {
      aStatus: ra.status,
      bStatus: rb.status,
      aGotOwnToken: ta.includes('ZETA6'),
      bGotOwnToken: tb.includes('ETA7'),
      // 서로 섞이지 않았는가
      crossContamination: ta.includes('ETA7') || tb.includes('ZETA6'),
      pass: ra.status === 'fulfilled' && rb.status === 'fulfilled' && ta.includes('ZETA6') && tb.includes('ETA7'),
      aReason: ra.status === 'rejected' ? String(ra.reason) : null,
      bReason: rb.status === 'rejected' ? String(rb.reason) : null,
    }
    console.log('C6', R.C6.pass ? 'PASS' : 'FAIL', JSON.stringify({ a: R.C6.aGotOwnToken, b: R.C6.bGotOwnToken }))
  }
}

R.transitions = transitions.map((t) => ({ event: t.event, pane_id: t.pane_id, status: t.status }))
sub.end()
raw.close({ probe: 'c-agent', at: new Date().toISOString(), results: R })
process.exit(0)
