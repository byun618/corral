// LIFE-502 K4 — 네이티브 관문 본 회차. `native-up.sh` 뒤, `native-down.sh` 앞에 한 번 돈다(l490 native-run.mjs 의 N1 앞부분을 옮겼다).
//
// 사용자 userData + 구현 브랜치 빌드(`native-app.sh`) + 설치 herdr `default`. 「서버 시작」(provider 재개)은 코디 승인(`--allow-session-restore`) —
// 재개 pane 에 입력하지 않는다. fixture 레포(`<ROOT>/fx/l502fx`)를 **앱 UI 로 등록**(「프로젝트 추가」 → 「폴더 찾아보기」 — OS 대화는 제어 채널
// `browse-stub`)하고 그 main worktree 를 연다. 누르고 입력하는 것은 fixture 와 그 탭뿐이다.
// 회차: ⓐ codex 느린 MCP 기동(K4ⓐ) ⓑ claude 프롬프트 완료(K4ⓑ) — 회차마다 fixture workspace 에 새 탭(포커스 없이)을 만들고 첫 탭을 다시 선택해
// 「보고 있지 않은」 pane 으로 둔다. 판독은 k-iso.mjs 와 같다(제어 소켓 state 의 그 pane + DOM 세 표시). 에이전트 cwd 는 이 구현 worktree(이미 신뢰됨).
// codex 회차 전 ~/.codex/config.toml 바이트 백업 → 바뀌면 그 자리에서 백업 바이트로 되돌리고 기록한다(킥오프 격리 2).
// 서버·앱은 끄지 않는다 — native-down.sh 가 멈추고 원복한다(server.pid 를 여기서 적는다).
// 사용: node native-k4.mjs --root <ROOT=/tmp/l502n*> --app <app 디렉터리> --raw <raw 폴더> [--observe 10000]
// 종료코드: 0 = 모든 check 통과, 1 = 하나라도 실패(원자료는 남긴다), 2 = 진행 불가.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1]]] : pairs), []))
const ROOT = String(args.root)
const APP = path.resolve(String(args.app))
const RAWD = path.resolve(String(args.raw))
const observeMs = Number(args.observe ?? 10_000)
if (!/^\/tmp\/l502n[^/]*$/.test(ROOT)) throw new Error(`--root 는 /tmp/l502n*: ${ROOT}`)
fs.mkdirSync(RAWD, { recursive: true })
const HERE = path.dirname(new URL(import.meta.url).pathname)
const IMPL_ROOT = path.resolve(HERE, '../../..')
const HERDR = '/opt/homebrew/bin/herdr'
const CODEX_CONFIG = path.join(process.env.HOME, '.codex/config.toml')
const SLOW_CODEX = `codex -c check_for_update_on_startup=false -c 'mcp_servers.l502slow.command="sleep"' -c 'mcp_servers.l502slow.args=["8"]' -c mcp_servers.l502slow.startup_timeout_sec=6`
const CLAUDE = 'claude --model claude-haiku-4-5-20251001'
const PROMPT = 'Reply with exactly the word OK and nothing else. Do not use any tools.'
const sock = path.join(ROOT, 'ctl.sock')
const t0 = Date.now()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const out = { checks: [], steps: {}, runs: [], startedAt: new Date().toISOString() }
const check = (name, actual, expected) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  out.checks.push({ name, pass, actual, expected })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} (실측 ${JSON.stringify(actual)}${pass ? '' : ` / 기대 ${JSON.stringify(expected)}`})`)
  return pass
}
const ctl = (request, timeout = 30_000) => rpc(sock, request, timeout)
const state = async () => (await ctl({ cmd: 'state' })).state
const evalJs = async (code) => (await ctl({ cmd: 'eval', code })).result
const until = async (fn, label, timeoutMs = 30_000, stepMs = 200) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null)
    if (value) return value
    await pause(stepMs)
  }
  throw new Error(`timeout: ${label}`)
}
const herdr = (...rest) => execFileSync(HERDR, rest, { encoding: 'utf8' })
const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8' }).trim()
const dservers = () => execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((line) => /^\s*\d+ \/opt\/homebrew\/bin\/herdr( --session default)? server$/.test(line)).map((line) => line.trim().split(' ')[0])
const rowOf = (st, p) => st.repos.flatMap((repo) => repo.worktrees).find((row) => row.path === p) ?? null
const shot = async (name, selector) => {
  const reply = await ctl({ cmd: 'shot', name, selector })
  if (reply.file && fs.existsSync(reply.file)) fs.copyFileSync(reply.file, path.join(RAWD, path.basename(reply.file)))
  return reply.file ? path.basename(reply.file) : null
}
function paneOf(st, paneId) {
  for (const repo of st.repos) for (const wt of repo.worktrees) for (const tab of wt.workspace?.tabs ?? []) for (const pane of tab.panes) if (pane.paneId === paneId) return pane
  return null
}
async function sample({ paneId, tabId, worktreePath }) {
  const pane = paneOf(await state(), paneId)
  const dom = await evalJs(`(() => {
    const row = document.querySelector(${JSON.stringify(`[data-agent-row="${paneId}"]`)})
    const card = document.querySelector(${JSON.stringify(`[data-worktree="${worktreePath}"]`)})
    const tab = document.querySelector(${JSON.stringify(`[data-main-tab="${tabId}"]`)})
    return {
      rowUnseen: row === null ? null : row.getAttribute('data-unseen-done') === 'true',
      cardBell: card?.querySelector('[data-worktree-unread-toggle]')?.getAttribute('data-worktree-unread-toggle') ?? null,
      tabBell: tab === null ? null : tab.querySelector('[data-tab-unread-bell]') !== null,
      tabActive: tab?.getAttribute('data-active') ?? null,
      attention: document.documentElement.dataset.windowAttention ?? null,
    }
  })()`)
  return {
    t: Date.now() - t0,
    status: pane?.agentStatus ?? null,
    agent: pane?.agent ?? null,
    session: pane === null || pane.agentSession === null ? null : pane.agentSession.kind,
    prompt: pane === null ? null : pane.digest.firstPrompt !== null || pane.digest.lastPrompt !== null,
    observedAt: pane?.agentState?.observedAt ?? null,
    history: pane?.agentState?.history?.map((step) => `${step.status}@${step.observedAt}`) ?? null,
    ...dom,
  }
}
const shown = (s) => s.rowUnseen === true || s.cardBell === 'unread' || s.tabBell === true
function analyse(last) {
  if (last === null || last.history === null) return { flash: false, timeline: [] }
  const timeline = [...last.history].reverse().concat([`${last.status}@${last.observedAt}`]).map((entry) => entry.split('@')[0])
  const running = (s) => s === 'working' || s === 'blocked'
  let flash = false
  let fromUnknown = false
  for (let i = 1; i < timeline.length; i += 1) {
    if (running(timeline[i]) && !running(timeline[i - 1])) fromUnknown = timeline[i - 1] === 'unknown'
    if (running(timeline[i - 1]) && (timeline[i] === 'idle' || timeline[i] === 'done') && fromUnknown) flash = true
  }
  return { flash, timeline }
}
const selectTab = async (tabId) => {
  await ctl({ cmd: 'click', selector: `[data-main-tab="${tabId}"]` })
  await until(async () => ((await evalJs(`document.querySelector(${JSON.stringify(`[data-main-tab="${tabId}"]`)})?.getAttribute('data-active')`)) === 'true' ? true : null), `tab ${tabId} active`, 10_000)
}

async function runOne({ kind, fx, workspaceId, homeTab }) {
  const run = { kind, samples: [], events: [] }
  const note = (label, extra = {}) => run.events.push({ t: Date.now() - t0, label, ...extra })
  const before = new Set(rowOf(await state(), fx).workspace.tabs.map((tab) => tab.tabId))
  herdr('tab', 'create', '--workspace', workspaceId, '--cwd', fx)
  const tab = await until(async () => rowOf(await state(), fx).workspace.tabs.find((row) => !before.has(row.tabId)) ?? null, 'new tab', 20_000)
  const ids = { tabId: tab.tabId, paneId: tab.panes[0].paneId, worktreePath: fx }
  Object.assign(run, { tabId: ids.tabId, paneId: ids.paneId })
  await until(async () => ((await evalJs(`document.querySelector(${JSON.stringify(`[data-main-tab="${ids.tabId}"]`)}) !== null`)) ? true : null), 'tab rendered', 20_000)
  await selectTab(homeTab)
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
  const waitStatus = (want, label, timeout) => until(async () => (want.includes(await statusNow()) ? true : null), label, timeout)
  const codexBackup = kind === 'codex-flash' ? fs.readFileSync(CODEX_CONFIG) : null
  try {
    if (kind === 'codex-flash') {
      note('launch', { command: SLOW_CODEX })
      herdr('pane', 'run', ids.paneId, `cd '${IMPL_ROOT}' && ${SLOW_CODEX}`)
      await waitStatus(['working', 'blocked'], 'flash running', 30_000).then(() => note('running-seen')).catch(() => note('no-running-within-30s'))
      await waitStatus(['idle', 'done'], 'idle', 45_000)
      note('idle')
    } else {
      note('launch', { command: CLAUDE })
      herdr('pane', 'run', ids.paneId, `cd '${IMPL_ROOT}' && ${CLAUDE}`)
      await waitStatus(['idle', 'done'], 'claude ready', 45_000)
      await pause(1500)
      note('prompt-send', { prompt: PROMPT })
      herdr('pane', 'send-text', ids.paneId, PROMPT)
      await pause(600)
      herdr('pane', 'send-text', ids.paneId, '\r')
      const saw = await waitStatus(['working', 'blocked'], 'prompt running', 60_000).then(() => true).catch(() => false)
      note('prompt:running-seen', { saw })
      await waitStatus(['idle', 'done'], 'prompt finished', 120_000)
      note('prompt:finished')
    }
    note('observe-start', { ms: observeMs })
    await pause(observeMs)
    note('observe-end')
  } catch (error) {
    run.error = String(error?.stack ?? error).slice(0, 800)
  } finally {
    stop = true
    await sampler
    run.shot = await shot(`k4-${kind}`, `[data-worktree="${fx}"]`).catch((error) => `shot failed: ${String(error).slice(0, 100)}`)
    run.screen = (() => {
      try {
        return herdr('pane', 'read', ids.paneId).slice(-2000)
      } catch (error) {
        return `read failed: ${String(error).slice(0, 200)}`
      }
    })()
    const valid = run.samples.filter((s) => s.error === undefined)
    const obsStart = run.events.find((event) => event.label === 'observe-start')?.t
    const beforeObs = obsStart === undefined ? undefined : valid.filter((s) => s.t < obsStart).at(-1)
    const window = obsStart === undefined ? [] : [...(beforeObs === undefined ? [] : [beforeObs]), ...valid.filter((s) => s.t >= obsStart)]
    const last = [...valid].reverse().find((s) => s.history !== null) ?? null
    run.verdict = {
      ...analyse(last),
      shownInWindow: window.some(shown),
      shownEver: valid.some(shown),
      indicatorsAtEnd: window.at(-1) === undefined ? null : { rowUnseen: window.at(-1).rowUnseen, cardBell: window.at(-1).cardBell, tabBell: window.at(-1).tabBell, attention: window.at(-1).attention, tabActive: window.at(-1).tabActive },
      sessionAtEnd: last?.session ?? null,
      promptAtEnd: last?.prompt ?? null,
    }
    try {
      herdr('pane', 'send-keys', ids.paneId, 'C-c')
      await pause(400)
      herdr('pane', 'send-keys', ids.paneId, 'C-c')
      await pause(1500)
    } catch (error) {
      note('ctrl-c failed', { error: String(error).slice(0, 200) })
    }
    try {
      herdr('tab', 'close', ids.tabId)
    } catch (error) {
      note('close failed', { error: String(error).slice(0, 200) })
    }
    await pause(1500)
    const bell = await evalJs(`document.querySelector(${JSON.stringify(`[data-worktree="${fx}"] [data-worktree-unread-toggle]`)})?.getAttribute('data-worktree-unread-toggle') ?? null`)
    if (bell === 'unread') {
      await ctl({ cmd: 'click', selector: `[data-worktree="${fx}"] [data-worktree-unread-toggle]` })
      await pause(500)
    }
    run.cleared = { bellBefore: bell }
    if (codexBackup !== null) {
      const now = fs.readFileSync(CODEX_CONFIG)
      run.codexConfig = { changed: !now.equals(codexBackup), before: crypto.createHash('sha256').update(codexBackup).digest('hex'), after: crypto.createHash('sha256').update(now).digest('hex') }
      if (run.codexConfig.changed) {
        fs.writeFileSync(CODEX_CONFIG, codexBackup)
        run.codexConfig.restored = crypto.createHash('sha256').update(fs.readFileSync(CODEX_CONFIG)).digest('hex')
      }
    }
  }
  console.log(kind, JSON.stringify(run.verdict))
  return run
}

async function main() {
  // F6(r1 R1-07) — 실행한 빌드의 식별값: git HEAD·app/src 마지막 commit·렌더러 번들 파일명과 sha256.
  const assets = path.join(APP, 'out/renderer/assets')
  out.build = {
    head: git(APP, 'rev-parse', 'HEAD'),
    productCommit: git(APP, 'log', '-1', '--format=%H', '--', 'src'),
    rendererBundles: fs.readdirSync(assets).filter((file) => file.endsWith('.js')).map((file) => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(assets, file))).digest('hex'), mtime: fs.statSync(path.join(assets, file)).mtime.toISOString() })),
  }
  const fxBase = path.join(ROOT, 'fx')
  const fxDir = path.join(fxBase, 'l502fx')
  fs.mkdirSync(fxDir, { recursive: true })
  git(fxDir, 'init', '-q', '-b', 'main')
  git(fxDir, '-c', 'user.email=l502@example.invalid', '-c', 'user.name=l502', 'commit', '-q', '--allow-empty', '-m', 'c1')
  const fx = fs.realpathSync(fxDir)
  out.fixture = fx

  const up = spawnSync('sh', [path.join(HERE, 'native-app.sh'), ROOT, APP, RAWD, 'k4'], { encoding: 'utf8' })
  fs.writeFileSync(path.join(RAWD, 'k4-app.txt'), `${up.stdout}\n${up.stderr}`)
  if (up.status !== 0) throw new Error(`native-app.sh → ${up.status}`)
  const first = await until(async () => {
    const st = await state()
    return st.backend.kind === 'confirm' || st.link.phase === 'live' ? st : null
  }, 'confirm card or live', 30_000)
  out.steps.card = { backend: first.backend, link: first.link.phase }
  check('K4 설치 default server(클릭 전)', dservers().length, 0)
  if (first.backend.kind === 'confirm') {
    out.steps.cardShot = await shot('k4-confirm', '[data-backend-card]')
    // 「서버 시작」 — 코디 승인(--allow-session-restore). 재개 pane 에 입력하지 않는다.
    const start = await ctl({ cmd: 'click', selector: '[data-backend-start]' })
    out.steps.startClick = { ok: start.ok }
  }
  await until(async () => ((await state()).link.phase === 'live' ? true : null), 'link live', 60_000)
  await pause(2000)
  const servers = dservers()
  fs.writeFileSync(path.join(ROOT, 'server.pid'), `${servers.join('\n')}\n`)
  check('K4 서버 시작 뒤 설치 default server 수', servers.length, 1)
  await pause(4000)
  const agents = spawnSync('sh', [path.join(HERE, 'agent-status.sh')], { encoding: 'utf8' })
  fs.writeFileSync(path.join(RAWD, 'k4-agent-status.json'), agents.stdout)
  out.steps.restored = spawnSync(process.execPath, [path.join(HERE, 'restored-agents.mjs'), servers[0] ?? '0', RAWD], { encoding: 'utf8' }).stdout.trim()

  const reposBefore = (await state()).repos.length
  await ctl({ cmd: 'browse-stub', path: fx })
  check('K4 프로젝트 추가 클릭', (await ctl({ cmd: 'click', selector: '[data-add-repo]' })).ok, true)
  await until(async () => ((await evalJs(`document.querySelector('[data-browse-folder]') !== null`)) ? true : null), 'add repo modal', 10_000)
  check('K4 폴더 찾아보기 클릭', (await ctl({ cmd: 'click', selector: '[data-browse-folder]' })).ok, true)
  await until(async () => (rowOf(await state(), fx) !== null ? true : null), 'fixture registered', 30_000)
  await ctl({ cmd: 'browse-stub' })
  check('K4 등록 뒤 레포 수', (await state()).repos.length, reposBefore + 1)
  await evalJs(`document.querySelector(${JSON.stringify(`[data-worktree="${fx}"] [data-worktree-branch]`)})?.scrollIntoView({ block: 'center' })`)
  await pause(200)
  await ctl({ cmd: 'click', selector: `[data-worktree="${fx}"] [data-worktree-branch]` })
  const ws = await until(async () => {
    const row = rowOf(await state(), fx)
    return row?.workspace?.tabs?.length > 0 ? row.workspace : null
  }, 'fixture workspace open', 30_000)
  const homeTab = ws.tabs[0].tabId
  await until(async () => ((await evalJs(`document.querySelector(${JSON.stringify(`[data-main-tab="${homeTab}"]`)}) !== null`)) ? true : null), 'home tab rendered', 20_000)
  await selectTab(homeTab)
  out.steps.fixtureWorkspace = { workspaceId: ws.workspaceId, homeTab }

  for (const kind of ['codex-flash', 'claude-prompt']) out.runs.push(await runOne({ kind, fx, workspaceId: ws.workspaceId, homeTab }))
  const [codex, claude] = out.runs
  check('K4ⓐ codex 기동 반짝임(상태 이력)', codex.verdict.flash, true)
  check('K4ⓐ codex 기동 — 세 표시 없음(전 구간)', codex.verdict.shownEver, false)
  check('K4ⓑ claude 프롬프트 완료 — 관찰 구간에 세 표시', { row: claude.verdict.indicatorsAtEnd?.rowUnseen, card: claude.verdict.indicatorsAtEnd?.cardBell, tab: claude.verdict.indicatorsAtEnd?.tabBell }, { row: true, card: 'unread', tab: true })
  check('codex config 바뀜 없음(바뀌었으면 복원됨)', codex.codexConfig?.changed === false || codex.codexConfig?.restored === codex.codexConfig?.before, true)
}

let code = 0
try {
  await main()
  code = out.checks.every((item) => item.pass) ? 0 : 1
} catch (error) {
  out.error = String(error?.stack ?? error)
  console.log(`ERROR ${out.error}`)
  code = 2
} finally {
  fs.writeFileSync(path.join(RAWD, 'native-k4.json'), JSON.stringify(out, null, 2))
  console.log(`checks ${out.checks.filter((item) => item.pass).length}/${out.checks.length} → exit ${code}`)
  process.exit(code)
}
