// ⓒ C5 엣지 — agent_blocked · agent_prompt_stalled · unknown 을 실제로 재현하고
// 각각의 복구 경로를 확인한다.
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/c5-edge.mjs

import fs from 'node:fs'
import { Raw, sleep } from '../lib/raw.mjs'
import { makeApi } from '../lib/pane.mjs'

const raw = new Raw('c5-edge')
const api = makeApi(raw)
const R = {}
// 신뢰한 적 없는 새 디렉터리라야 claude 가 신뢰 확인 화면에서 선다.
const FRESH = `/private/tmp/claude-501/-Users-byun-repos-byun618-corral--claude-worktrees-LIFE-342-spike-claude/dff7969e-c926-4faf-acc3-8fc408797d67/scratchpad/c5-${Date.now()}`
fs.mkdirSync(FRESH, { recursive: true })

for (const p of (await api('pane.list', {})).panes.slice(1)) await api('pane.close', { pane_id: p.pane_id })
await sleep(800)

const status = async (name) => (await api('agent.list', {})).agents.find((x) => x.name === name) ?? null
const screen = async (name) =>
  (await api('agent.read', { target: name, source: 'visible', format: 'text' })).read?.text ?? ''

/** 오류를 던지지 않고 결과를 그대로 돌려준다 — 엣지 항목은 에러가 곧 결과다. */
async function attempt(method, params, opts) {
  try {
    const r = await api(method, params, opts)
    return { ok: true, result: r }
  } catch (err) {
    return { ok: false, error: String(err).replace(/^Error: /, '') }
  }
}

// pane 을 하나 만들고 셸이 뜰 때까지 기다린다
async function freshPane() {
  const sp = await api('pane.split', { direction: 'right', cwd: FRESH })
  await sleep(1500)
  return sp.pane.pane_id
}

// --- unknown: 기동 직후 --------------------------------------------------
const paneId = await freshPane()
let started = null
for (let i = 0; i < 10; i++) {
  const r = await attempt('agent.start', { name: 'c5-a', kind: 'claude', pane_id: paneId, timeout_ms: 120000 }, { timeoutMs: 130000 })
  if (r.ok) {
    started = r.result
    break
  }
  if (!r.error.includes('agent_pane_busy')) throw new Error(r.error)
  await sleep(1000)
}
{
  const s0 = await status('c5-a')
  // status 가 unknown 인 동안 프롬프트를 던지면?
  const p = s0?.agent_status === 'unknown' ? await attempt('agent.prompt', { target: 'c5-a', text: '안녕' }) : null
  R.unknown = {
    reproduced: s0?.agent_status === 'unknown',
    statusAtStart: s0?.agent_status ?? null,
    launchPending: s0?.launch_pending ?? null,
    promptWhileUnknown: p,
    note: 'unknown 은 감지 실패가 아니라 "아직 모른다" 다. 기동 직후 launch_pending 과 함께 나온다',
  }
  console.log('unknown:', JSON.stringify(R.unknown).slice(0, 300))
}

// --- blocked: 신뢰 확인 화면 ---------------------------------------------
{
  let s = null
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    s = await status('c5-a')
    if (s?.agent_status === 'blocked') break
    await sleep(1000)
  }
  const scr = await screen('c5-a')
  const blockedNow = s?.agent_status === 'blocked'

  // blocked 상태에서 프롬프트를 던지면 어떻게 되나 (문서: 입력 전에 거부)
  const promptNoWait = await attempt('agent.prompt', { target: 'c5-a', text: 'BLOCKED 테스트' }, { timeoutMs: 30000 })
  const screenAfterPrompt = await screen('c5-a')
  // 거부라면 화면에 그 글자가 안 들어가 있어야 한다
  const textLeaked = screenAfterPrompt.includes('BLOCKED 테스트')

  const promptWithWait = await attempt(
    'agent.prompt',
    { target: 'c5-a', text: 'BLOCKED2 테스트', wait: { until: ['idle', 'done'], timeout_ms: 15000 } },
    { timeoutMs: 25000 },
  )

  // 복구: 화면을 보고 에이전트별 키를 넣는다
  const recipe = /Yes, I trust|trust this folder/i.test(scr) ? [['down'], ['enter']] : null
  const recovery = { recipe: recipe ? recipe.flat() : null, worked: null, msToIdle: null }
  if (recipe) {
    const t0 = Date.now()
    for (const k of recipe) {
      await api('agent.send_keys', { target: 'c5-a', keys: k })
      await sleep(300)
    }
    const dl = Date.now() + 60000
    while (Date.now() < dl) {
      const s2 = await status('c5-a')
      if (s2 && ['idle', 'done'].includes(s2.agent_status)) {
        recovery.worked = true
        recovery.msToIdle = Date.now() - t0
        break
      }
      await sleep(1000)
    }
    if (recovery.worked === null) recovery.worked = false
  }
  // 복구 뒤에 프롬프트가 실제로 통하는가.
  // herdr 가 idle 이라고 해도 에이전트 입력창이 아직 준비 전이라 첫 프롬프트가
  // agent_prompt_stalled 로 튕기는 일이 있다 — 몇 번 만에 통하는지까지 센다.
  const recoveryPrompts = []
  let afterRecovery = null
  if (recovery.worked) {
    for (let i = 0; i < 4; i++) {
      afterRecovery = await attempt(
        'agent.prompt',
        { target: 'c5-a', text: 'RE 와 COVER1 을 붙여 한 단어로만 답해.', wait: { until: ['idle', 'done'], timeout_ms: 120000 } },
        { timeoutMs: 130000 },
      )
      recoveryPrompts.push({ i, ok: afterRecovery.ok, error: afterRecovery.error ?? null })
      if (afterRecovery.ok) break
      await sleep(3000)
    }
  }
  const finalScreen = recovery.worked ? await screen('c5-a') : ''
  R.blocked = {
    reproduced: blockedNow,
    screenExcerpt: scr.split('\n').filter((x) => x.trim()).slice(0, 8),
    promptWhileBlocked: promptNoWait,
    promptTextLeakedToScreen: textLeaked,
    promptWithWaitWhileBlocked: promptWithWait,
    recovery,
    recoveryPromptAttempts: recoveryPrompts,
    attemptsUntilPromptTook: recoveryPrompts.findIndex((x) => x.ok) + 1 || null,
    promptAfterRecovery: afterRecovery
      ? { ok: afterRecovery.ok, type: afterRecovery.result?.type ?? null, error: afterRecovery.error ?? null }
      : null,
    answerAfterRecovery: finalScreen.includes('RECOVER1'),
    note: 'herdr 는 blocked 를 정확히 알려준다. 다만 푸는 키는 에이전트별이고 API 가 알려주지 않는다',
  }
  console.log('blocked:', JSON.stringify({ ...R.blocked, screenExcerpt: undefined }).slice(0, 500))
}

// --- stalled: 비working 상태에서 5초 내 상태변화 없음 ---------------------
// 문서가 말하는 agent_prompt_stalled 를 실제로 뽑아본다. 몇 가지를 시도하고
// 무엇이 실제로 그 코드를 내는지(또는 안 내는지) 있는 그대로 남긴다.
{
  const tries = []

  // ⓪ 에이전트를 modal(슬래시 커맨드 메뉴)에 세워둔다 — blocked 로는 안 잡히는 대기 상태.
  //    문서가 말하는 "비working 상태에서 5초 내 상태변화 없음"에 가장 가까운 그림이다.
  await api('agent.send_keys', { target: 'c5-a', keys: ['/'] })
  await sleep(2000)
  const modalStatus = await status('c5-a')
  const modalScreen = await screen('c5-a')
  tries.push({
    scenario: '슬래시 커맨드 메뉴를 띄운 채 프롬프트 (blocked 로는 안 잡히는 대기)',
    statusBefore: modalStatus?.agent_status ?? null,
    screenTail: modalScreen.split('\n').filter((x) => x.trim()).slice(-4),
    result: await attempt(
      'agent.prompt',
      { target: 'c5-a', text: 'STALL0', wait: { until: ['idle', 'done'], timeout_ms: 10000 } },
      { timeoutMs: 20000 },
    ),
  })
  await api('agent.send_keys', { target: 'c5-a', keys: ['esc'] })
  await sleep(800)

  // ① 에이전트 프로세스를 죽여 pane 을 셸로 되돌린 뒤 프롬프트
  await api('agent.send_keys', { target: 'c5-a', keys: ['ctrl+c'] })
  await sleep(500)
  await api('agent.send_keys', { target: 'c5-a', keys: ['ctrl+c'] })
  await sleep(3000)
  const afterKill = await status('c5-a')
  tries.push({
    scenario: '에이전트를 Ctrl-C 로 종료한 뒤 프롬프트',
    statusBefore: afterKill?.agent_status ?? null,
    agentStillListed: !!afterKill,
    result: await attempt(
      'agent.prompt',
      { target: 'c5-a', text: 'STALL1', wait: { until: ['idle', 'done'], timeout_ms: 10000 } },
      { timeoutMs: 20000 },
    ),
  })

  // ② 존재하지 않는 이름
  tries.push({
    scenario: '없는 에이전트 이름',
    result: await attempt('agent.prompt', { target: 'c5-없는이름', text: 'STALL2' }, { timeoutMs: 15000 }),
  })

  // ③ 에이전트가 아닌 pane 을 target 으로
  const plain = await freshPane()
  tries.push({
    scenario: '에이전트가 아닌 pane',
    result: await attempt('agent.prompt', { target: plain, text: 'STALL3' }, { timeoutMs: 15000 }),
  })

  // ④ agent.wait 를 아무 일도 안 일어날 때 짧은 타임아웃으로
  tries.push({
    scenario: 'agent.wait 짧은 타임아웃 (아무 일도 안 일어남)',
    result: await attempt('agent.wait', { target: 'c5-a', until: ['working'], timeout_ms: 6000 }, { timeoutMs: 20000 }),
  })

  // 에러 문자열은 "<method>: <code> <message>" 꼴이다 — 코드만 뽑는다.
  const codes = tries.map((t) => (t.result.ok ? 'ok' : (t.result.error.match(/:\s*(\w+)/)?.[1] ?? '?')))
  R.stalled = {
    tries,
    errorCodes: codes,
    stalledCodeSeen: tries.some((t) => !t.result.ok && /stalled/i.test(t.result.error)),
    note: 'agent_prompt_stalled 를 직접 유발하지 못하면 그것도 결과다 — 재현 시도를 그대로 남긴다',
  }
  console.log('stalled 시도:', JSON.stringify(tries.map((t) => [t.scenario, t.result.ok ? 'ok' : t.result.error.slice(0, 80)]), null, 0).slice(0, 800))
}

raw.close({ probe: 'c5-edge', at: new Date().toISOString(), results: R })
process.exit(0)
