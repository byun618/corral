// LIFE-490 K4 — 활성 규칙을 바꾼 뒤 기존 활성 경로가 그대로인가. 한 격리 인스턴스에서 차례로 각 1회:
//   ⓐ 이미 열린 워크트리 행 클릭 → 그 workspace 활성
//   ⓑ 세션 행 클릭 → 그 pane 선택 · 그 workspace 활성
//   ⓒ CLI `worktree create --activate`(데스크톱 activate 경로 — `main/index.ts` workspaceDesktop.activate) → 새 워크트리 활성
//   ⓓ 재기동(데스크톱만 내렸다 올림, herdr 서버·workspace 는 그대로) → focused workspace 로 승격
//   ⓔ 활성 workspace 닫기(herdr `workspace.close`) → 남은 열린 workspace 로 승격(죽은 id 아님)
//   ⓕ 안 연 워크트리를 눌러 활성이 된 뒤 ⌘T → 그 workspace 에 탭이 하나 는다(다른 workspace 는 그대로)
// 사용: node <이 파일> --app <앱 루트> --out <raw 폴더> [--work /tmp/l490r] [--port 9492]
// 결과: <out>/result.json — 항목별 {id, pass, detail}. 종료코드 0 = 완주.

/* global document */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  parseArgs, git, commit, buildIdentity, launchIsolated, openDesktop, closeDesktop, rpc, until, pause, appState, openWorkspaceOf,
  instrument, pageNow, readMark, readTriple, tripleAgrees, clickTitle, clickAt, judgeActivation, backend,
} from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const appRoot = path.resolve(String(args.app))
const work = path.resolve(String(args.work ?? '/tmp/l490r'))
const out = path.resolve(String(args.out))
const port = Number(args.port ?? 9492)
fs.mkdirSync(out, { recursive: true })
const log = (...parts) => console.log('[l490-regress]', ...parts)
const identity = buildIdentity(appRoot)
const items = []
let handle = null
let alive = []

const record = (id, pass, detail) => {
  items.push({ id, pass, detail })
  log(JSON.stringify({ id, pass }))
}

async function main() {
  const fixtures = `${work}-repos`
  if (fs.existsSync(fixtures)) fs.rmSync(fixtures, { recursive: true, force: true })
  const root = path.join(fixtures, 'rg')
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  commit(root, 'init')
  for (const name of ['x', 'y', 'z']) git(root, 'worktree', 'add', '-q', '-b', name, path.join(fixtures, 'rg-wt', name))
  const mainPath = fs.realpathSync(root)
  const wt = (name) => fs.realpathSync(path.join(fixtures, 'rg-wt', name))

  handle = await launchIsolated({ appRoot, work, out, port, session: 'l490-regress' })
  let { cdp } = handle
  await rpc(handle.control, { cmd: 'add-repo', root: mainPath })
  await until(async () => {
    await rpc(handle.control, { cmd: 'rebuild-tree' }, 30_000)
    return (await cdp.evaluate(() => document.querySelectorAll('[data-worktree]').length)) === 4 ? true : null
  }, 'rendered', 60_000, 500)
  await instrument(cdp)

  const ensureOpen = async (wtPath) => {
    if (openWorkspaceOf(await appState(handle), wtPath) !== null) return
    await clickTitle(cdp, wtPath)
    await until(async () => (openWorkspaceOf(await appState(handle), wtPath) !== null ? true : null), `open ${wtPath}`, 20_000, 200)
    await pause(1500)
  }
  const activeVia = async (wtPath, act) => {
    const t0 = await pageNow(cdp)
    await act()
    const verdict = await judgeActivation(cdp, { wtPath, t0 })
    const triple = await readTriple(cdp)
    const agree = tripleAgrees({ triple, state: await appState(handle), wtPath })
    return { ...verdict, agree, triple }
  }

  // ⓐ 이미 열린 워크트리 행 클릭 — x 를 열어 두고 main 을 활성으로 한 뒤 x 를 누른다.
  await ensureOpen(wt('x'))
  await ensureOpen(mainPath)
  await clickTitle(cdp, mainPath)
  await until(async () => ((await readMark(cdp)) === mainPath ? true : null), 'main active', 10_000, 100)
  {
    const result = await activeVia(wt('x'), () => clickTitle(cdp, wt('x')))
    record('K4a-open-row', result.reachedAt !== null && result.held && result.agree.all, { before: mainPath, ...result })
  }

  // ⓑ 세션 행 클릭 — main 을 활성으로 하고 x 의 세션 행(pane)을 누른다.
  await clickTitle(cdp, mainPath)
  await until(async () => ((await readMark(cdp)) === mainPath ? true : null), 'main active', 10_000, 100)
  {
    // 세션 행은 에이전트가 붙은 pane 에만 그려진다 — x 의 첫 pane 에 에이전트를 보고해 행을 세운다(실행 파일 없이, `pane.report_agent`).
    const xPane = (await appState(handle)).repos.flatMap((repo) => repo.worktrees).find((row) => row.path === wt('x'))?.workspace?.tabs[0]?.panes[0]?.paneId ?? null
    if (xPane !== null) await backend(handle, 'pane.report_agent', { pane_id: xPane, source: 'l490-regress', agent: 'claude', state: 'idle' })
    await until(async () => (await cdp.evaluate((p) => document.querySelector(`[data-worktree="${p}"] [data-pane]`) !== null, wt('x'))) || null, 'session row', 10_000, 100).catch(() => null)
    const pane = await cdp.evaluate((p) => {
      const el = document.querySelector(`[data-worktree="${p}"] [data-pane]`)
      el?.scrollIntoView({ block: 'center' })
      const rect = el?.getBoundingClientRect()
      return el ? { paneId: el.getAttribute('data-pane'), x: rect.left + 20, y: rect.top + rect.height / 2 } : null
    }, wt('x'))
    if (pane === null) record('K4b-session-row', false, { error: 'x 카드에 세션 행(data-pane)이 없다' })
    else {
      const result = await activeVia(wt('x'), () => clickAt(cdp, pane))
      const selectedPane = await cdp.evaluate(() => document.querySelector('[data-term-pane-box].is-selected')?.getAttribute('data-term-pane-box') ?? null)
      const focusedRow = await cdp.evaluate(() => document.querySelector('[data-focused-agent-pane="true"]')?.getAttribute('data-pane') ?? null)
      record('K4b-session-row', result.reachedAt !== null && result.held && result.agree.all && selectedPane === pane.paneId, { paneId: pane.paneId, selectedPane, focusedRow, ...result })
    }
  }

  // ⓒ CLI — main 을 활성으로 한 뒤 `worktree create --activate`. 명령이 끝난 시각부터 5초.
  await clickTitle(cdp, mainPath)
  await until(async () => ((await readMark(cdp)) === mainPath ? true : null), 'main active', 10_000, 100)
  {
    const t0 = await pageNow(cdp)
    const cli = spawnSync(process.execPath, [path.join(appRoot, 'cli/corral.mjs'), 'worktree', 'create', '--name', 'cli-a', '--repo', mainPath, '--activate', '--json'], { env: handle.env, encoding: 'utf8', timeout: 120_000 })
    fs.writeFileSync(path.join(out, 'k4c-cli.json'), JSON.stringify({ status: cli.status, stdout: cli.stdout, stderr: cli.stderr }, null, 2))
    let created = null
    try {
      const body = JSON.parse(cli.stdout)
      created = body.result?.worktree?.path ?? null
    } catch {
      created = null
    }
    const target = created === null ? null : fs.realpathSync(created)
    if (target === null) record('K4c-cli-activate', false, { error: 'CLI 결과에 worktree 경로가 없다', status: cli.status })
    else {
      const verdict = await judgeActivation(cdp, { wtPath: target, t0 })
      const triple = await readTriple(cdp)
      const agree = tripleAgrees({ triple, state: await appState(handle), wtPath: target })
      record('K4c-cli-activate', cli.status === 0 && verdict.reachedAt !== null && verdict.held && agree.all, { target, cliStatus: cli.status, ...verdict, agree, triple })
    }
  }

  // ⓓ 재기동 — 데스크톱만 내리고 다시 띄운다. 기대 = herdr 가 focused 로 표시한 workspace(없으면 첫 workspace).
  {
    await closeDesktop(handle)
    await openDesktop(handle, { appRoot, port })
    cdp = handle.cdp
    await until(async () => ((await cdp.evaluate(() => document.querySelectorAll('[data-worktree]').length)) >= 4 ? true : null), 'rendered after restart', 60_000, 300)
    await instrument(cdp)
    await until(async () => ((await readMark(cdp)) !== null ? true : null), 'mark after restart', 15_000, 100).catch(() => null)
    await pause(1500)
    const state = await appState(handle)
    const open = state.repos.flatMap((repo) => repo.worktrees).filter((row) => row.workspace !== null)
    const expected = open.find((row) => row.workspace.focused) ?? open[0] ?? null
    const triple = await readTriple(cdp)
    const agree = expected === null ? null : tripleAgrees({ triple, state, wtPath: expected.path })
    record('K4d-restart-focused', expected !== null && agree.all, { expected: expected?.path ?? null, focused: open.filter((row) => row.workspace.focused).map((row) => row.path), agree, triple })
  }

  // ⓔ 활성 workspace 닫기 — x 를 활성으로 하고 그 workspace 를 닫는다. 남은 열린 것 중 하나가 활성이어야 한다.
  {
    await ensureOpen(wt('x'))
    await clickTitle(cdp, wt('x'))
    await until(async () => ((await readMark(cdp)) === wt('x') ? true : null), 'x active', 10_000, 100)
    const closing = openWorkspaceOf(await appState(handle), wt('x'))
    await backend(handle, 'workspace.close', { workspace_id: closing })
    await until(async () => (openWorkspaceOf(await appState(handle), wt('x')) === null ? true : null), 'x closed', 20_000, 200)
    await until(async () => {
      const mark = await readMark(cdp)
      return mark !== null && mark !== wt('x') ? true : null
    }, 'mark moved', 10_000, 100).catch(() => null)
    await pause(1500)
    const state = await appState(handle)
    const openIds = state.repos.flatMap((repo) => repo.worktrees).filter((row) => row.workspace !== null).map((row) => row.workspace.workspaceId)
    const triple = await readTriple(cdp)
    const agree = triple.mark === null ? null : tripleAgrees({ triple, state, wtPath: triple.mark })
    record('K4e-close-active', triple.active.id !== closing && openIds.includes(triple.active.id) && agree?.all === true, { closing, openIds, triple, agree })
  }

  // ⓕ ⌘T — 안 연 y 를 눌러 활성이 된 뒤 ⌘T. y 의 탭 수가 하나 늘고 다른 workspace 의 탭 수는 그대로.
  {
    const result = await activeVia(wt('y'), () => clickTitle(cdp, wt('y')))
    const tabsOf = (state) => Object.fromEntries(state.repos.flatMap((repo) => repo.worktrees).filter((row) => row.workspace !== null).map((row) => [row.path, row.workspace.tabs.length]))
    const before = tabsOf(await appState(handle))
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: 4 })
    await until(async () => ((tabsOf(await appState(handle)))[wt('y')] === (before[wt('y')] ?? 0) + 1 ? true : null), 'y tab +1', 10_000, 200).catch(() => null)
    await pause(800)
    const after = tabsOf(await appState(handle))
    const others = Object.keys(before).filter((key) => key !== wt('y')).every((key) => after[key] === before[key])
    record('K4f-cmd-t', result.reachedAt !== null && result.held && after[wt('y')] === (before[wt('y')] ?? 0) + 1 && others, { activation: result, before, after })
  }
}

let exitCode = 0
try {
  await main()
} catch (error) {
  exitCode = 2
  items.push({ error: String(error?.stack ?? error) })
  handle ??= error.handle ?? null
} finally {
  if (handle !== null) alive = await handle.stop()
  const judged = items.filter((item) => item.id !== undefined)
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ identity, pass: judged.filter((item) => item.pass).length, total: judged.length, spawned: handle?.spawned ?? [], alive, items }, null, 2))
  log(`pass ${judged.filter((item) => item.pass).length}/${judged.length}; alive ${JSON.stringify(alive)}`)
  process.exit(exitCode)
}
