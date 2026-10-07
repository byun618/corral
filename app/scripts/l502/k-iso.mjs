// LIFE-502 격리 실행 — 기동 반짝임(K1) · 진짜 완료 회귀(K2) 를 안 읽음 세 표시(pane 안 읽음 · worktree 벨 · 탭 벨)로 잰다.
//
// 격리: --work(/tmp/l502i*) 아래 userData·ui-prefs·레지스트리·herdr 세션·제어 소켓·fixture (l471 `isolation()` 그대로).
// 빌드: --app 이 가리키는 app 폴더의 빌드 산출물(기준 = /tmp/l502base/app, 구현 = 이 worktree 의 app).
// 「보고 있지 않은」 pane: 회차마다 fixture worktree 에 새 탭을 만들고 **첫 탭(셸)을 다시 선택**한다 — 새 탭 pane 은 활성 영역 선택 pane 이
// 아니라 창 상태와 무관하게 보고 있지 않다. K2ⓔ(보고 있는 pane)만 그 탭을 선택하고 CDP 포커스 에뮬레이션으로 창 포커스를 만든다.
// 에이전트 cwd: 이미 신뢰된 이 구현 worktree(신뢰 대화상자·codex 신뢰 줄 쓰기를 피한다). pane 은 fixture worktree 의 탭이다.
// env: 이 하네스를 부른 Claude/Orca 세션 변수(CLAUDE*·ORCA*·ANTHROPIC_API_KEY)를 지운다 — 물려받으면 claude 가 transcript 저장을 끈다.
// codex: 회차 전 ~/.codex/config.toml 바이트 백업, 회차 뒤 다르면 백업으로 되돌리고 그 사실을 기록한다(G5).
//
// 판독(회차마다 250ms): 제어 소켓 `state` 의 그 pane(agentStatus·agentState.history·agent·agentSession·digest 발화 유무) +
// DOM(행 `data-unseen-done` · 카드 `data-worktree-unread-toggle` · 탭 `[data-main-tab] [data-tab-unread-bell]`).
// 반짝임(G2) = 그 회차 상태 이력에 `unknown` 바로 뒤 working/blocked 구간이 idle/done 으로 끝난 것.
//
// 사용: node app/scripts/l502/k-iso.mjs --app <app 폴더> --work /tmp/l502iX --port 95NN --out <raw 폴더> --plan codex-flash,codex-flash,...
// 회차 종류: codex-flash · claude-launch · grok-launch · claude-prompt · claude-argprompt · report-idle-first · report-direct · watched-report
//           · claude-codex-relaunch-fast(r2 R2-03 — Ctrl-C 뒤 --relaunch-gap ms(기본 1000)만에 codex 재기동)
//           · claude-relaunch · codex-relaunch · claude-codex-relaunch(같은 pane 에서 프롬프트 1턴 → 종료 → 재기동, r1 R1-01 — codex 는 프롬프트 1회를 쓴다)
//           · claude-slowmcp-prompt(K2ⓕ — claude 느린 MCP 기동 반짝임 뒤 프롬프트 1턴)
//           · codex-prompt(K2ⓓ+ⓕ — 느린 MCP 로 반짝임을 낸 같은 pane 에 프롬프트 1회. 반짝임 뒤 observeMs 동안 표시 없음도 같이 본다. 토큰 사용)
/* global document -- CDP evaluate 클로저 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { backendRpc, inputs, isolation, launchCorral, makeRepo, parseArgs, pause, quitCorral, rpc, startBackend, stopPid, until } from '../l471/lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const implApp = path.resolve(here, '../..')
const implRoot = path.resolve(implApp, '..')
const args = parseArgs(process.argv.slice(2))
const appRoot = path.resolve(String(args.app ?? implApp))
const work = path.resolve(String(args.work ?? '/tmp/l502i'))
if (!work.startsWith('/tmp/l502i')) throw new Error(`--work 는 /tmp/l502i* (격리 규칙 4): ${work}`)
const out = path.resolve(String(args.out))
const port = Number(args.port ?? 9502)
const plan = String(args.plan ?? 'codex-flash').split(',').filter(Boolean)
const observeMs = Number(args.observe ?? 10_000)
// claude-codex-relaunch-fast 의 Ctrl-C 뒤 재기동까지 기다리는 시간(r2 R2-03 — 사람 수준). 기본 1초.
const relaunchGapMs = Number(args['relaunch-gap'] ?? 1000)
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
fs.mkdirSync(out, { recursive: true })
const t0 = Date.now()
const log = (...parts) => console.log(`[l502 +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...parts)

const SLOW_CODEX = `codex -c check_for_update_on_startup=false -c 'mcp_servers.l502slow.command="sleep"' -c 'mcp_servers.l502slow.args=["8"]' -c mcp_servers.l502slow.startup_timeout_sec=6`
const CLAUDE = 'claude --model claude-haiku-4-5-20251001'
const SLOW_CLAUDE = `${CLAUDE} --mcp-config '{"mcpServers":{"l502slow":{"command":"sleep","args":["8"]}}}'`
const PROMPT = 'Reply with exactly the word OK and nothing else. Do not use any tools.'
// 기동 인자 프롬프트는 응답이 길어야 한다 — 1초 턴은 herdr 가 에이전트를 감지하기 전에 끝나 working 이 안 선다(impl-r1 argprompt 2회 무효).
const ARG_PROMPT = 'Write the integers from 1 to 400 separated by single spaces. Output nothing else. Do not use any tools.'
const CODEX_CONFIG = path.join(process.env.HOME, '.codex/config.toml')
const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null)

const iso = isolation({ work, session: 'l502-iso' })
for (const key of Object.keys(iso.env)) if (/^(CLAUDE|ORCA_)/.test(key) || key === 'ANTHROPIC_API_KEY') delete iso.env[key]
const spawned = []
const result = { app: appRoot, build: null, plan, observeMs, runs: [], spawned, codexConfig: [], error: null, startedAt: new Date().toISOString() }
const save = () => fs.writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(result, null, 1)}\n`)
const ctl = (request) => rpc(iso.control, request, 30_000)
const herdrCli = (...rest) => execFileSync('herdr', ['--session', iso.session, ...rest], { env: iso.env, encoding: 'utf8' })
let backend = null
let app = null
let ui = null

const state = async () => (await ctl({ cmd: 'state' })).state
const worktreeOf = async (p) => (await state()).repos.flatMap((repo) => repo.worktrees).find((row) => row.path === p) ?? null
function paneOf(st, paneId) {
  for (const repo of st.repos) for (const wt of repo.worktrees) for (const tab of wt.workspace?.tabs ?? []) for (const pane of tab.panes) if (pane.paneId === paneId) return { pane, tab, wt }
  return null
}
/** 한 표본 — 그 pane 의 상태(app state)와 세 표시(DOM). */
async function sample({ paneId, tabId, worktreePath }) {
  const st = await state()
  const hit = paneOf(st, paneId)
  const dom = await app.cdp.evaluate(
    (ids) => {
      const row = document.querySelector(`[data-agent-row="${ids.paneId}"]`)
      const card = document.querySelector(`[data-worktree="${ids.worktreePath}"]`)
      const tab = document.querySelector(`[data-main-tab="${ids.tabId}"]`)
      return {
        rowUnseen: row === null ? null : row.getAttribute('data-unseen-done') === 'true',
        cardBell: card?.querySelector('[data-worktree-unread-toggle]')?.getAttribute('data-worktree-unread-toggle') ?? null,
        tabBell: tab === null ? null : tab.querySelector('[data-tab-unread-bell]') !== null,
        tabActive: tab?.getAttribute('data-active') ?? null,
        attention: document.documentElement.dataset.windowAttention ?? null,
      }
    },
    { paneId, tabId, worktreePath },
  )
  const pane = hit?.pane ?? null
  return {
    t: Date.now() - t0,
    status: pane?.agentStatus ?? null,
    agent: pane?.agent ?? null,
    session: pane?.agentSession === null || pane === null ? null : pane.agentSession.kind,
    // 세션 id 는 앞 8자만 — 재기동 뒤 참조가 바뀌었나(낡은 참조, r1 R1-01)를 가르는 데 쓴다.
    sessionId: pane === null || pane.agentSession === null ? null : (pane.agentSession.kind === 'id' ? pane.agentSession.id : pane.agentSession.path).slice(0, 8),
    activity: pane?.digest?.activity?.state ?? null,
    firstPrompt: pane?.digest?.firstPrompt != null,
    lastPrompt: pane?.digest?.lastPrompt != null,
    observedAt: pane?.agentState?.observedAt ?? null,
    history: pane?.agentState?.history?.map((step) => `${step.status}@${step.observedAt}`) ?? null,
    ...dom,
  }
}
const shown = (s) => s.rowUnseen === true || s.cardBell === 'unread' || s.tabBell === true
/** 상태 이력(오래된 것부터) + 지금 상태 → 기동 반짝임(unknown 바로 뒤 RUNNING 구간이 FINISHED 로 끝남)·전이 목록. */
function analyse(last) {
  if (last === null || last.history === null) return { flash: false, timeline: [] }
  const timeline = [...last.history].reverse().concat([`${last.status}@${last.observedAt}`]).map((entry) => entry.split('@')[0])
  let flash = false
  let fromUnknown = false
  for (let i = 1; i < timeline.length; i += 1) {
    const running = (s) => s === 'working' || s === 'blocked'
    if (running(timeline[i]) && !running(timeline[i - 1])) fromUnknown = timeline[i - 1] === 'unknown'
    if (running(timeline[i - 1]) && (timeline[i] === 'idle' || timeline[i] === 'done') && fromUnknown) flash = true
  }
  return { flash, timeline }
}

async function selectTab(tabId) {
  await ui.click(`[data-main-tab="${tabId}"]`)
  await until(() => app.cdp.evaluate((id) => document.querySelector(`[data-main-tab="${id}"]`)?.getAttribute('data-active') === 'true', tabId), `tab ${tabId} active`, 10_000)
}
async function newTab(workspaceId) {
  const before = new Set((await worktreeOf(A)).workspace.tabs.map((tab) => tab.tabId))
  await backendRpc(iso, 'tab.create', { workspace_id: workspaceId })
  const tab = await until(async () => (await worktreeOf(A)).workspace.tabs.find((row) => !before.has(row.tabId)) ?? null, 'new tab', 20_000)
  await until(() => app.cdp.evaluate((id) => document.querySelector(`[data-main-tab="${id}"]`) !== null, tab.tabId), 'new tab rendered', 20_000)
  await selectTab(homeTab)
  return { tabId: tab.tabId, paneId: tab.panes[0].paneId }
}
async function clearIndicators(label) {
  const card = await app.cdp.evaluate((p) => document.querySelector(`[data-worktree="${p}"] [data-worktree-unread-toggle]`)?.getAttribute('data-worktree-unread-toggle') ?? null, A)
  if (card === 'unread') {
    await ui.click(`[data-worktree="${A}"] [data-worktree-unread-toggle]`)
    await pause(500)
  }
  return { label, cardBefore: card }
}
const report = (paneId, st) => backendRpc(iso, 'pane.report_agent', { pane_id: paneId, source: 'l502-iso', agent: 'claude', state: st })
const sendText = (paneId, text) => backendRpc(iso, 'pane.send_text', { pane_id: paneId, text })
// codex 프롬프트는 짧은 한 줄(r1 코디 답 — 사용량 90%).
const CODEX_PROMPT = 'Reply exactly: PONG'
async function sendPrompt({ paneId, text = PROMPT }) {
  await sendText(paneId, text)
  await pause(600)
  await sendText(paneId, '\r')
}

/** 회차 하나. `drive` 가 기동·입력을 하고, 끝 조건이 서면 그 뒤 observeMs 동안 표본을 계속 모은다. */
async function runOne(kind, index) {
  const run = { kind, index, startedAt: Date.now() - t0, samples: [], events: [], codexConfig: null }
  const note = (label, extra = {}) => run.events.push({ t: Date.now() - t0, label, ...extra })
  const ws = (await worktreeOf(A)).workspace
  const { tabId, paneId } = await newTab(ws.workspaceId)
  Object.assign(run, { tabId, paneId })
  const ids = { paneId, tabId, worktreePath: A }
  let stop = false
  const sampler = (async () => {
    let lastKey = ''
    while (!stop) {
      try {
        const s = await sample(ids)
        const key = JSON.stringify({ ...s, t: 0 })
        if (key !== lastKey) run.samples.push(s)
        lastKey = key
      } catch (error) {
        run.samples.push({ t: Date.now() - t0, error: String(error).slice(0, 200) })
      }
      await pause(250)
    }
  })()
  const statusNow = async () => (await sample(ids)).status
  const waitStatus = async (want, label, timeout) => until(async () => (want.includes(await statusNow()) ? true : null), label, timeout, 200)
  /** working/blocked 를 본 뒤 idle/done — 못 보면 시간 초과까지 idle 을 기다린다(반짝임 없는 회차). */
  const waitTurn = async (label, timeout) => {
    const sawRunning = await waitStatus(['working', 'blocked'], `${label} running`, timeout).then(() => true).catch(() => false)
    note(sawRunning ? `${label}:running-seen` : `${label}:running-not-seen`, { sawRunning })
    await waitStatus(['idle', 'done'], `${label} finished`, timeout)
    note(`${label}:finished`)
  }
  const codexBackup = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG) : null
  const cd = `cd '${implRoot}' && `
  try {
    switch (kind) {
      case 'codex-flash':
      case 'claude-launch':
      case 'grok-launch': {
        const command = { 'codex-flash': SLOW_CODEX, 'claude-launch': CLAUDE, 'grok-launch': 'grok' }[kind]
        note('launch', { command })
        herdrCli('pane', 'run', paneId, cd + command)
        // 반짝임이 나면 working → idle, 안 나면 unknown → idle. 둘 다 idle 진입까지 기다린다.
        await waitStatus(['working', 'blocked'], 'launch running', 30_000).then(() => note('running-seen')).catch(() => note('running-not-seen-within-30s'))
        await waitStatus(['idle', 'done'], 'launch idle', 45_000)
        note('idle')
        break
      }
      case 'claude-prompt': {
        note('launch', { command: CLAUDE })
        herdrCli('pane', 'run', paneId, cd + CLAUDE)
        await waitStatus(['idle', 'done'], 'claude ready', 45_000)
        await pause(1500)
        note('prompt-send', { prompt: PROMPT })
        await sendPrompt({ paneId })
        await waitTurn('prompt', 120_000)
        break
      }
      case 'claude-argprompt': {
        const command = `${CLAUDE} "${ARG_PROMPT}"`
        note('launch', { command })
        herdrCli('pane', 'run', paneId, cd + command)
        await waitTurn('argprompt', 120_000)
        break
      }
      case 'claude-slowmcp-prompt':
      case 'codex-prompt': {
        // claude-slowmcp-prompt: K2ⓕ 를 claude 쿼터로 — claude 에 느린 MCP(`--mcp-config` 인라인, 설정 파일 무변경)를 붙여 기동 반짝임을 노리고, 그 pane 에 프롬프트 1턴.
        const command = kind === 'codex-prompt' ? SLOW_CODEX : SLOW_CLAUDE
        note('launch', { command })
        herdrCli('pane', 'run', paneId, cd + command)
        await waitStatus(['working', 'blocked'], 'codex flash running', 30_000).then(() => note('running-seen')).catch(() => note('running-not-seen-within-30s'))
        await waitStatus(['idle', 'done'], 'codex ready', 45_000)
        note('flash-idle')
        note('preprompt-observe-start', { ms: observeMs })
        await pause(observeMs)
        note('preprompt-observe-end')
        const promptText = kind === 'codex-prompt' ? CODEX_PROMPT : PROMPT
        note('prompt-send', { prompt: promptText })
        await sendPrompt({ paneId, text: promptText })
        await waitTurn('prompt', 180_000)
        break
      }
      case 'claude-codex-relaunch-fast': {
        // R2-03 — 빠른 재기동: 1턴 뒤 표시를 **먼저** 지우고, Ctrl-C 두 번 → relaunchGapMs 만 쉬고 곧바로 codex 느린 MCP 를 띄운다.
        // 렌더러가 「에이전트 없음」 묶음을 받을 틈이 사람 수준으로 짧다 — 물러난 참조가 기억되는지(재기동 반짝임이 안 서는지)를 본다.
        note('launch-1', { command: CLAUDE })
        herdrCli('pane', 'run', paneId, cd + CLAUDE)
        await waitStatus(['idle', 'done'], 'ready-1', 45_000)
        await pause(1500)
        note('prompt-send', { prompt: PROMPT })
        await sendPrompt({ paneId })
        await waitTurn('turn-1', 180_000)
        await pause(2000)
        run.cleared1 = await clearIndicators('after turn-1')
        await pause(1000)
        note('exit-1')
        await sendText(paneId, '\u0003')
        await pause(300)
        await sendText(paneId, '\u0003')
        await pause(relaunchGapMs)
        run.atRelaunch = await sample(ids)
        run.relaunchEpoch = Date.now()
        note('relaunch', { command: SLOW_CODEX, epoch: run.relaunchEpoch, gapMs: relaunchGapMs })
        herdrCli('pane', 'run', paneId, cd + SLOW_CODEX)
        await waitStatus(['working', 'blocked'], 'flash-2 running', 30_000).then(() => note('flash-2:running-seen')).catch(() => note('flash-2:running-not-seen'))
        await waitStatus(['idle', 'done'], 'ready-2', 45_000)
        note('idle')
        break
      }
      case 'claude-relaunch':
      case 'codex-relaunch':
      case 'claude-codex-relaunch': {
        // F1(r1 R1-01) — 같은 pane 에서 프롬프트 1턴 → 종료 → 다시 기동. 2회차 기동의 세션 참조·지문·세 표시를 본다.
        // claude-codex-relaunch: 1턴은 claude(쿼터 쌈), 재기동은 codex 느린 MCP — 낡은 참조(발화 있음)가 남은 채 codex 반짝임이 나는 같은 모양을 codex 토큰 없이 만든다.
        const first = kind === 'codex-relaunch' ? SLOW_CODEX : CLAUDE
        const launch = kind === 'claude-relaunch' ? CLAUDE : SLOW_CODEX
        note('launch-1', { command: first })
        herdrCli('pane', 'run', paneId, cd + first)
        if (kind === 'codex-relaunch') await waitStatus(['working', 'blocked'], 'flash-1 running', 30_000).then(() => note('flash-1:running-seen')).catch(() => note('flash-1:running-not-seen'))
        await waitStatus(['idle', 'done'], 'ready-1', 45_000)
        await pause(1500)
        note('prompt-send', { prompt: PROMPT })
        await sendPrompt({ paneId })
        await waitTurn('turn-1', 180_000)
        await pause(3000)
        note('exit-1')
        await sendText(paneId, '\u0003')
        await pause(500)
        await sendText(paneId, '\u0003')
        await until(async () => {
          const s = await sample(ids)
          return s.agent === null || s.status === 'unknown' ? true : null
        }, 'agent gone', 30_000).then(() => note('agent-gone')).catch(() => note('agent-not-gone-within-30s'))
        await pause(3000)
        run.afterExit = await sample(ids)
        run.cleared1 = await clearIndicators('after turn-1')
        await pause(1500)
        run.relaunchEpoch = Date.now()
        note('relaunch', { command: launch, epoch: run.relaunchEpoch })
        herdrCli('pane', 'run', paneId, cd + launch)
        await waitStatus(['working', 'blocked'], 'flash-2 running', 30_000).then(() => note('flash-2:running-seen')).catch(() => note('flash-2:running-not-seen'))
        await waitStatus(['idle', 'done'], 'ready-2', 45_000)
        note('idle')
        break
      }
      case 'report-idle-first': {
        note('report idle → working → idle (471 하네스 방식)')
        await report(paneId, 'idle')
        await waitStatus(['idle', 'done'], 'report idle', 10_000)
        await pause(1500)
        await report(paneId, 'working')
        await waitStatus(['working'], 'report working', 10_000)
        await pause(1500)
        await report(paneId, 'idle')
        await waitStatus(['idle', 'done'], 'report idle 2', 10_000)
        note('idle')
        break
      }
      case 'report-direct': {
        note('report working → idle (unknown 에서 곧장)')
        await report(paneId, 'working')
        await waitStatus(['working'], 'report working', 10_000)
        await pause(1500)
        await report(paneId, 'idle')
        await waitStatus(['idle', 'done'], 'report idle', 10_000)
        note('idle')
        break
      }
      case 'watched-report': {
        // K2ⓔ — 그 탭을 선택 + 포커스 에뮬레이션(창 포커스). 보고 있는 pane 의 완료는 서지 않는다.
        await app.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
        await selectTab(tabId)
        await until(() => app.cdp.evaluate(() => (document.documentElement.dataset.windowAttention === 'watched' ? true : null)), 'attention watched', 8000).catch(() => note('attention-not-watched'))
        await report(paneId, 'idle')
        await waitStatus(['idle', 'done'], 'report idle', 10_000)
        await pause(1500)
        await report(paneId, 'working')
        await waitStatus(['working'], 'report working', 10_000)
        await pause(1500)
        await report(paneId, 'idle')
        await waitStatus(['idle', 'done'], 'report idle 2', 10_000)
        note('idle')
        break
      }
      default:
        throw new Error(`모르는 회차 ${kind}`)
    }
    note('observe-start', { ms: observeMs })
    await pause(observeMs)
    note('observe-end')
  } catch (error) {
    run.error = String(error?.stack ?? error).slice(0, 800)
  } finally {
    stop = true
    await sampler
    run.screen = (() => {
      try {
        return herdrCli('pane', 'read', paneId).slice(-2500)
      } catch (error) {
        return `read failed: ${String(error).slice(0, 200)}`
      }
    })()
    // 판정 창 = 끝 조건(idle 진입) 뒤 관찰 구간. 그 구간의 표본에 세 표시 중 하나라도 섰나.
    const obsStart = run.events.find((event) => event.label === 'observe-start')?.t ?? Infinity
    // 표본은 바뀔 때만 쌓인다 — 구간 시작 직전 표본(그때의 화면)을 구간에 포함한다.
    const valid = run.samples.filter((s) => s.error === undefined)
    const inRange = (from, to) => {
      const before = valid.filter((s) => s.t < from).at(-1)
      return [...(before === undefined ? [] : [before]), ...valid.filter((s) => s.t >= from && s.t <= to)]
    }
    const window = obsStart === Infinity ? [] : inRange(obsStart, Infinity)
    const anyShown = run.samples.filter((s) => s.error === undefined && shown(s))
    const last = [...run.samples].reverse().find((s) => s.error === undefined && s.history !== null) ?? null
    const { flash, timeline } = analyse(last)
    // 재기동 회차는 재기동 뒤 구간만 본다 — 첫 기동의 반짝임을 2회차 반짝임으로 세지 않게(G2).
    // 재기동 직전 상태 하나(보통 unknown)를 앞에 남겨야 「unknown 바로 뒤 구간」을 볼 수 있다.
    const relaunchSegment = (() => {
      if (run.relaunchEpoch === undefined || last === null) return null
      const ordered = [...last.history].reverse()
      const firstAfter = ordered.findIndex((entry) => Number(entry.split('@')[1]) >= run.relaunchEpoch)
      const kept = firstAfter === -1 ? ordered.slice(-1) : ordered.slice(Math.max(0, firstAfter - 1))
      return analyse({ history: [...kept].reverse(), status: last.status, observedAt: last.observedAt })
    })()
    const pre = run.events.find((event) => event.label === 'preprompt-observe-start')?.t
    const preEnd = run.events.find((event) => event.label === 'preprompt-observe-end')?.t
    run.verdict = {
      // F5(r1 R1-05) — 하네스 오류가 난 회차는 무효다. 아래 값이 통과처럼 읽히지 않게 맨 앞에 둔다.
      invalid: run.error === undefined ? null : 'harness error — see run.error',
      flash,
      relaunchFlash: relaunchSegment === null ? null : relaunchSegment.flash,
      relaunchTimeline: relaunchSegment === null ? null : relaunchSegment.timeline,
      sessionAfterExit: run.afterExit === undefined ? null : run.afterExit.sessionId,
      // R2-03 — 종료(exit-1)와 재기동 사이 main 상태 표본에 「에이전트 없음」 이 있었나(250ms 표본 — 렌더러가 받는 같은 상태). 첫 표본 시각·개수.
      agentNullBetween: (() => {
        const exit = run.events.find((event) => event.label === 'exit-1')?.t
        const relaunch = run.events.find((event) => event.label === 'relaunch')?.t
        if (exit === undefined || relaunch === undefined) return null
        const nulls = run.samples.filter((s) => s.error === undefined && s.t >= exit && s.t <= relaunch + 3000 && s.agent === null)
        return { count: nulls.length, firstAt: nulls[0]?.t ?? null, exitAt: exit, relaunchAt: relaunch }
      })(),
      shownBeforePrompt: pre === undefined ? null : inRange(pre, preEnd ?? Infinity).some(shown),
      timeline,
      shownInWindow: window.some(shown),
      shownEver: anyShown.length > 0,
      firstShownAt: anyShown[0]?.t ?? null,
      indicatorsAtEnd: window.at(-1) === undefined ? null : { rowUnseen: window.at(-1).rowUnseen, cardBell: window.at(-1).cardBell, tabBell: window.at(-1).tabBell, attention: window.at(-1).attention, tabActive: window.at(-1).tabActive },
      sessionAtEnd: last?.session ?? null,
      promptAtEnd: last === null ? null : last.firstPrompt || last.lastPrompt,
      samplesInWindow: window.length,
    }
    if (kind === 'watched-report') {
      await app.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
      await selectTab(homeTab).catch(() => {})
    }
    // 끄기 — 에이전트 종료(Ctrl-C 두 번) 뒤 탭 닫기. 표시 지우기는 다음 회차 전에.
    try {
      if (/codex|claude|grok/.test(kind)) {
        await sendText(paneId, '\u0003')
        await pause(400)
        await sendText(paneId, '\u0003')
        await pause(1500)
      }
      await backendRpc(iso, 'tab.close', { tab_id: tabId })
    } catch (error) {
      note('close-failed', { error: String(error).slice(0, 200) })
    }
    await pause(1500)
    run.cleared = await clearIndicators(`after ${kind}#${index}`)
    if (codexBackup !== null) {
      const now = fs.readFileSync(CODEX_CONFIG)
      run.codexConfig = { changed: !now.equals(codexBackup), before: crypto.createHash('sha256').update(codexBackup).digest('hex'), after: crypto.createHash('sha256').update(now).digest('hex') }
      if (run.codexConfig.changed) {
        fs.writeFileSync(CODEX_CONFIG, codexBackup)
        run.codexConfig.restored = sha(CODEX_CONFIG)
      }
    }
  }
  log(kind, index, JSON.stringify(run.verdict))
  return run
}

let A = null
let homeTab = null
let exitCode = 2
try {
  result.build = {
    head: spawnSync('git', ['-C', appRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || null,
    rendererBundleMtime: fs.statSync(path.join(appRoot, 'out/renderer/index.html')).mtime.toISOString(),
    // F6(r1 R1-07) — 실행한 렌더러 번들의 파일명·sha256(식별값). rendererHasLaunchRule 은 식별 근거가 아니다(기준에서도 true).
    rendererBundles: fs.readdirSync(path.join(appRoot, 'out/renderer/assets')).filter((file) => file.endsWith('.js')).map((file) => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(appRoot, 'out/renderer/assets', file))).digest('hex') })),
    rendererHasLaunchRule: fs.readdirSync(path.join(appRoot, 'out/renderer/assets')).some((file) => file.endsWith('.js') && fs.readFileSync(path.join(appRoot, 'out/renderer/assets', file), 'utf8').includes('.held')),
  }
  const { root } = makeRepo({ reposDir: path.join(work, 'repos'), name: 'iso', linked: [] })
  A = root
  backend = await startBackend({ iso, logFile: path.join(out, 'backend.log'), spawned })
  app = await launchCorral({ iso, appRoot, port, socket: iso.realSocket, spawned })
  ui = inputs(app.cdp)
  const added = await ctl({ cmd: 'add-repo', root: A })
  if (!added.ok) throw new Error(`add-repo: ${JSON.stringify(added)}`)
  await until(() => app.cdp.evaluate((p) => document.querySelector(`[data-worktree="${p}"]`) !== null, A), 'card', 60_000)
  await ui.click(`[data-worktree="${A}"] [data-worktree-card-surface]`)
  await until(async () => (await worktreeOf(A))?.workspace?.tabs?.length > 0, 'workspace open', 60_000)
  homeTab = (await worktreeOf(A)).workspace.tabs[0].tabId
  await until(() => app.cdp.evaluate((id) => document.querySelector(`[data-main-tab="${id}"]`) !== null, homeTab), 'home tab rendered', 20_000)
  await selectTab(homeTab)
  result.homeTab = homeTab
  for (const [index, kind] of plan.entries()) {
    result.runs.push(await runOne(kind, index))
    save()
  }
  exitCode = 0
} catch (error) {
  result.error = String(error?.stack ?? error)
  log('ERROR', result.error)
} finally {
  if (app !== null) await quitCorral({ iso, app }).catch((error) => log('quit failed', String(error)))
  if (backend !== null) await stopPid(backend.pid, 'herdr backend').catch((error) => log('backend stop failed', String(error)))
  result.finishedAt = new Date().toISOString()
  result.leftovers = spawnSync('ps', ['-Ao', 'pid,ppid,etime,command'], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line.includes('l502-iso') || line.includes(`remote-debugging-port=${port}`) || line.includes(work))
  save()
  log('done', exitCode, out)
  process.exit(exitCode)
}
