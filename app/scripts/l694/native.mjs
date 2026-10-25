/* global fetch, WebSocket */
// LIFE-694 C8 네이티브 관측 — 설치본(`/Applications/corral.app`, `--remote-debugging-port` 로 띄움)에 CDP 로 붙어 세 장면을 돈다.
// 입력은 DOM 쪽으로만(`element.click()`·preload API) — 키 입력은 쓰지 않는다(다른 pane 으로 샐 수 있다). OS 입력·캡처 없음(캡처는 CDP).
//   node scripts/l694/native.mjs --cdp <port> --sock <herdr 소켓> --herdr <herdr 바이너리> --session <세션> --repo <등록 레포 루트> --out <원자료 폴더> [--bundle <index-*.js>] [--log <corral.ndjson>] <장면>
// 장면: check(번들·세션·링크) · a(지운 worktree 자리 workspace 외부 닫기 → 행 없음) · b(카드에 붙은 외부 닫기 → 보존 행 ✕ 로 걷기)
//       · c(폴더만 남은 자리 카드 밖 줄 = 주인 없음) · cleanup(관문용 worktree·브랜치·폴더·workspace 정리 — 이름이 LIFE-694-c8- 로 시작하는 것만)
// 격리 dry-run 도 같은 인자로(격리 인스턴스의 cdp.port·소켓·guard 바이너리·세션). 대기는 시간 초과를 예외로 올리고 장면은 exit 1.
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { cdp: { type: 'string' }, sock: { type: 'string' }, herdr: { type: 'string' }, session: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, bundle: { type: 'string' }, log: { type: 'string' } } })
const scene = positionals[0]
const PREFIX = 'LIFE-694-c8-'
const REPO = fs.realpathSync(args.repo)
const SLOTS = path.join(REPO, '.claude/worktrees')
const OUT = path.join(args.out, `${scene}-${new Date().toISOString().replace(/[:.]/g, '')}`)
fs.mkdirSync(OUT, { recursive: true })
const record = { scene, at: new Date().toISOString(), uptime: execFileSync('uptime').toString().trim(), args: { ...args }, steps: [], checks: [] }
const step = (name, data = {}) => record.steps.push({ t: new Date().toISOString(), at: Date.now(), name, ...data })
const check = (name, ok, data = {}) => record.checks.push({ name, ok: ok === true, ...data })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, { timeoutMs = 20_000, everyMs = 250, label }) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`대기 시간 초과: ${label}`)
    await sleep(everyMs)
  }
}

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(args.sock)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, 15_000)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l694n', method, params }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const i = buffer.indexOf('\n')
      if (i === -1) return
      clearTimeout(timer); socket.destroy()
      const m = JSON.parse(buffer.slice(0, i))
      if (m.error) reject(new Error(`${method}: ${m.error.code} ${m.error.message}`)); else resolve(m.result)
    })
  })
}
/** corral 밖 닫기 — herdr CLI. */
// 설치본은 기본 세션(`~/.config/corral-herdr/herdr.sock`, `--session` 없음)이다 — `--session default` 면 인자를 뺀다.
const sessionArgs = args.session && args.session !== 'default' ? ['--session', args.session] : []
function herdrCli(cliArgs) {
  return new Promise((resolve) => execFile(args.herdr, [...sessionArgs, ...cliArgs], { env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' }, timeout: 15_000 }, (error, stdout, stderr) => resolve({ argv: ['herdr', ...sessionArgs, ...cliArgs], exit: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })))
}
const git = (...a) => execFileSync('/usr/bin/git', ['-C', REPO, ...a], { encoding: 'utf8' })

let devtools
async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${args.cdp}/json`)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
  if (!page) throw new Error('CDP 렌더러 페이지 없음')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (message) => { const d = JSON.parse(message.data); if (d.id === undefined) return; const p = pending.get(d.id); pending.delete(d.id); if (d.error) p.reject(new Error(JSON.stringify(d.error))); else p.resolve(d.result) }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  return { send, close: () => ws.close() }
}
async function evaluate(expression) {
  const r = await devtools.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}
const getState = () => evaluate('window.corral.getState()')
const supplyHas = async (paneId) => (await getState()).retainedAgents.some((row) => row.paneId === paneId)
async function capture(name) {
  const r = await devtools.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'))
  step('capture', { name })
}
/** 사이드바 「닫힌 탭」 행 — 접힌 묶음은 DOM click 으로 펼친 뒤. */
async function domRetained() {
  await evaluate(`(() => { for (const el of document.querySelectorAll('[data-agent-group][data-agent-group-expanded="false"]')) el.click() })()`)
  await sleep(300)
  return evaluate(`[...document.querySelectorAll('[data-agent-row-source="retained"]')].map((el) => ({ key: el.getAttribute('data-agent-row'), worktree: el.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null, dismiss: el.querySelector('[data-dismiss-retained]')?.getAttribute('data-dismiss-retained') ?? null }))`)
}
const cardOf = async (wt) => (await getState()).repos.flatMap((repo) => repo.worktrees).find((item) => item.path === wt) ?? null
async function makeDone(paneId) {
  await rpc('pane.report_agent', { pane_id: paneId, source: 'l694-c8', agent: 'claude', state: 'working', seq: 1 })
  await sleep(1200)
  await rpc('pane.report_agent', { pane_id: paneId, source: 'l694-c8', agent: 'claude', state: 'idle', seq: 2 })
  await waitFor(async () => ((await rpc('pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.agent_status === 'done', { timeoutMs: 8000, label: `done ${paneId}` })
  step('done', { paneId })
  await sleep(2500) // 재동기(agent-session-nudge)가 끝나게 — 격리 g11·g20 교훈
}
async function openCard(name) {
  const wt = path.join(SLOTS, `${PREFIX}${name}`)
  git('worktree', 'add', '-q', '-b', `${PREFIX}${name}`, wt)
  step('git worktree add', { wt })
  await waitFor(async () => (await cardOf(wt)) !== null, { timeoutMs: 30_000, label: `${name} 카드 생김` })
  const opened = await rpc('worktree.open', { cwd: REPO, path: wt, trust_repository: true, focus: false })
  step('worktree.open', { workspaceId: opened.workspace?.workspace_id })
  const card = await waitFor(async () => { const c = await cardOf(wt); return c?.openWorkspaceId ? c : null }, { timeoutMs: 15_000, label: `${name} 카드 귀속` })
  const paneId = card.workspace.tabs[0].panes[0].paneId
  const focused = ((await rpc('pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.focused
  check(`${name} pane 이 포커스 안 됨(done 전제)`, focused === false, { paneId, focused })
  return { wt, workspaceId: card.openWorkspaceId, paneId }
}
const treeBuiltAfter = async (t) => waitFor(async () => {
  const s = await getState()
  return s.repos.length > 0 && Date.now() - t > 6000 ? s : null // 설치본엔 로그 읽기 길이 없다 — 감시기(2초)·재빌드가 돌 시간을 둔다
}, { timeoutMs: 20_000, label: '골격 갱신 대기' })

const scenes = {
  async check() {
    const s = await getState()
    const bundle = await evaluate('[...document.scripts].map((el) => el.src.split("/").pop())')
    record.bundle = bundle
    check('렌더러 번들이 이 빌드', args.bundle === undefined || bundle.includes(args.bundle), { bundle, expected: args.bundle ?? null })
    check('링크 live·세션 일치', s.link.phase === 'live' && (s.selectedSession ?? 'default') === args.session, { link: s.link.phase, session: s.selectedSession, sessions: s.sessions })
    check('레포 등록됨', s.repos.some((repo) => repo.root === REPO), { roots: s.repos.map((repo) => repo.root) })
    check('dismissRetained API 있음(이 브랜치)', await evaluate('typeof window.corral.dismissRetained === "function"'))
    record.retainedBefore = s.retainedAgents.map((row) => ({ paneId: row.paneId, cwd: row.cwd }))
  },
  // ⓐ 관문용 worktree 에 셸 pane 을 done 으로 → worktree 를 셸에서 지움 → herdr CLI 로 workspace 닫기 → 「닫힌 탭」 행이 어느 카드에도 안 생김
  async a() {
    const logStart = args.log ? fs.statSync(args.log).size : 0 // 설치본 로그는 수 GB — 이 장면에서 늘어난 바이트만 읽는다
    const { wt, workspaceId, paneId } = await openCard('a')
    await makeDone(paneId)
    const removedAt = Date.now()
    git('worktree', 'remove', '--force', wt)
    step('git worktree remove (셸에서 지움)', { wt, exists: fs.existsSync(wt) })
    await waitFor(async () => (await cardOf(wt)) === null, { timeoutMs: 30_000, label: '카드 사라짐' })
    await treeBuiltAfter(removedAt)
    const r = await herdrCli(['workspace', 'close', workspaceId])
    step('herdr workspace close (corral 밖)', r)
    check('herdr CLI 닫기 exit 0', r.exit === 0, r)
    const closedAt = Date.now()
    await sleep(3000)
    check('ⓐ 공급에 그 pane 없음', !(await supplyHas(paneId)), { paneId })
    // 판정력 — 「없음」 이 보존 판정(정책 false)을 지나서인지 로그로 본다(재동기로 지워지면 로그가 없다 — 격리 g11).
    if (args.log) {
      const fd = fs.openSync(args.log, 'r')
      const size = fs.fstatSync(fd).size
      const buffer = Buffer.alloc(size - logStart)
      fs.readSync(fd, buffer, 0, buffer.length, logStart)
      fs.closeSync(fd)
      record.logBytes = { from: logStart, to: size }
      const skip = buffer.toString('utf8').split('\n').filter((line) => line.includes('"retained.skip_ownerless"')).map((line) => JSON.parse(line)).filter((entry) => entry.at >= closedAt - 500 && entry.workspaceId === workspaceId)
      check('ⓐ 로그 retained.skip_ownerless(그 workspace)', skip.length === 1, { skip })
    }
    const dom = await domRetained()
    check('ⓐ 「닫힌 탭」 행이 어느 카드에도 없음(main 포함)', !dom.some((item) => item.dismiss === paneId || (item.key ?? '').endsWith(paneId)), { dom })
    await capture('a-after-close')
  },
  // ⓑ 카드에 붙은 workspace 외부 닫기 → 보존 행 → ✕(DOM click) 로 걷음 → DOM·공급에서 빠짐
  async b() {
    const { wt, workspaceId, paneId } = await openCard('b')
    await makeDone(paneId)
    const r = await herdrCli(['workspace', 'close', workspaceId])
    step('herdr workspace close (corral 밖)', r)
    await waitFor(async () => supplyHas(paneId), { timeoutMs: 10_000, label: 'ⓑ 보존' })
    const row = await waitFor(async () => (await domRetained()).find((item) => item.dismiss === paneId) ?? null, { timeoutMs: 10_000, label: 'ⓑ 카드에 행' })
    check('ⓑ 보존 행이 그 카드에', row.worktree === wt, { row })
    await capture('b-before-dismiss')
    await evaluate(`document.querySelector('[data-dismiss-retained="${paneId}"]').click()`)
    step('✕ DOM click')
    await waitFor(async () => !(await supplyHas(paneId)), { timeoutMs: 5000, label: 'ⓑ 공급에서 빠짐' })
    await waitFor(async () => !(await domRetained()).some((item) => item.dismiss === paneId), { timeoutMs: 5000, label: 'ⓑ DOM 에서 빠짐' })
    check('ⓑ ✕ 로 걷음 — 공급·DOM 에서 빠짐', true)
    await capture('b-after-dismiss')
  },
  // ⓒ 폴더만 남은 자리(.git 없음·목록에 없음)의 카드 밖 줄 = 주인 없음(줄이 뜬 뒤 ≥3틱 뒤 읽음)
  async c() {
    const cwd = path.join(SLOTS, `${PREFIX}c`, 'apps')
    fs.mkdirSync(cwd, { recursive: true })
    const created = await rpc('workspace.create', { cwd, label: `${PREFIX}c`, focus: false })
    const workspaceId = created.workspace.workspace_id
    step('workspace.create', { cwd, workspaceId })
    record.workspaceC = workspaceId
    const open = await evaluate('!!document.querySelector("[data-statusbar-resource-panel]")')
    if (!open) await evaluate('document.querySelector("[data-statusbar-resource]").click()')
    const read = () => evaluate(`(() => { const row = document.querySelector('[data-statusbar-resource-orphan="${workspaceId}"]'); if (!row) return null; const b = row.querySelector('[data-statusbar-resource-orphan-owner]'); return { kind: b?.getAttribute('data-statusbar-resource-orphan-owner') ?? null, text: b?.textContent ?? null, tooltip: b?.getAttribute('title') ?? null, rowTooltip: row.querySelector('.statusbar-resource-orphan-line')?.getAttribute('title') ?? null } })()`)
    await waitFor(read, { timeoutMs: 30_000, label: 'ⓒ 카드 밖 줄 뜸' })
    await sleep(6500)
    const badge = await read()
    record.badge = badge
    check('ⓒ 폴더만 남은 자리 줄 = 주인 없음', badge?.kind === 'ownerless' && badge?.text === '주인 없음', { badge })
    check('ⓒ 툴팁에 「worktree 아님(폴더만 남음)」', (badge?.tooltip ?? '').includes('worktree 아님(폴더만 남음)'), { badge })
    await capture('c-badge')
    await evaluate('document.querySelector("[data-statusbar-resource]").click()') // 패널 닫기
  },
  // 정리 — 이름이 LIFE-694-c8- 로 시작하는 worktree·브랜치·폴더·workspace 만.
  async cleanup() {
    const workspaces = (await rpc('workspace.list')).workspaces ?? []
    const panes = (await rpc('pane.list')).panes ?? []
    for (const ws of workspaces) {
      const mine = (ws.label ?? '').startsWith(PREFIX) || panes.some((p) => p.workspace_id === ws.workspace_id && (p.cwd ?? '').includes(`/.claude/worktrees/${PREFIX}`))
      if (mine) step('workspace close', await herdrCli(['workspace', 'close', ws.workspace_id]))
    }
    for (const line of git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ') && l.includes(`/.claude/worktrees/${PREFIX}`))) {
      const wt = line.slice(9)
      git('worktree', 'remove', '--force', wt)
      step('worktree remove', { wt })
    }
    for (const name of fs.readdirSync(SLOTS).filter((n) => n.startsWith(PREFIX))) { fs.rmSync(path.join(SLOTS, name), { recursive: true, force: true }); step('rm folder', { name }) }
    for (const branch of git('branch', '--list', `${PREFIX}*`, '--format=%(refname:short)').split('\n').filter(Boolean)) { git('branch', '-D', branch); step('branch -D', { branch }) }
    await sleep(3000)
    const left = { worktrees: git('worktree', 'list').split('\n').filter((l) => l.includes(PREFIX)), folders: fs.readdirSync(SLOTS).filter((n) => n.startsWith(PREFIX)), branches: git('branch', '--list', `${PREFIX}*`).trim(), workspaces: ((await rpc('workspace.list')).workspaces ?? []).filter((w) => (w.label ?? '').startsWith(PREFIX)).map((w) => w.workspace_id) }
    record.left = left
    check('정리 — 남은 관문용 worktree·폴더·브랜치·workspace 0', left.worktrees.length === 0 && left.folders.length === 0 && left.branches === '' && left.workspaces.length === 0, left)
  },
}

let exit = 0
try {
  devtools = await connect()
  if (!(scene in scenes)) throw new Error(`장면? ${scene}`)
  await scenes[scene]()
} catch (error) {
  record.error = String(error?.stack ?? error)
  exit = 1
} finally { devtools?.close() }
record.failed = record.checks.filter((c) => !c.ok).map((c) => c.name)
if (record.checks.length === 0 || record.failed.length > 0) exit = 1
record.exit = exit
fs.writeFileSync(path.join(OUT, `${scene}.json`), `${JSON.stringify(record, null, 2)}\n`)
console.log(JSON.stringify({ scene, out: OUT, exit, checks: record.checks.length, failed: record.failed, error: record.error ?? null }))
process.exit(exit)
