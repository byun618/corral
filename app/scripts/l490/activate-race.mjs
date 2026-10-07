// LIFE-490 K1 — 안 연 링크 워크트리를 누르면 그 워크트리가 5초 안에 활성이 되고 5초 동안 유지되나.
//
// `l478/activate-race.mjs` 를 고친 것이다. 478 판은 「직전 회차 대상이 활성」 을 출발로 삼아, 결함이 있으면
// 출발이 늘 main 이고 고치면 늘 다른 워크트리라 출발 상태가 빌드에 따라 달라졌다(00-analysis F5).
// 여기서는 회차 **전에** 출발 상태를 명시적으로 세우고 원자료에 적는다:
//   none  ① 열린 workspace 0 (herdr `workspace.close` 로 전부 닫는다 — 링크 먼저, 주 체크아웃 나중)
//   other ② 다른 링크 워크트리(`anchor`)가 활성 (열려 있지 않으면 열고, 열린 행을 다시 눌러 활성)
//   main  ③ 주 체크아웃이 활성 (열려 있지 않으면 열고, 열린 행을 다시 눌러 활성)
// 출발 상태를 세우는 데는 「이미 열린 행 클릭 = activateWorkspace」 만 쓴다 — 결함과 무관한 경로라 기준 빌드에서도 선다.
// 세운 뒤 표식·활성 id 가 출발 대상과 같은지 확인하고, 못 세우면 그 회차는 `setupFailed` 로 적는다(판정에서 빼지 않는다).
//
// 사용: node <이 파일> --app <앱 루트> --out <raw 폴더> [--work /tmp/l490a] [--port 9490] [--trials 7] [--starts none,other,main]
// 결과: <out>/result.json — 회차별 {start, before, target, opened, reachedAt, held, triple, events}. 종료코드 0 = 완주(판정은 값으로).

/* global document */
import fs from 'node:fs'
import path from 'node:path'
import {
  parseArgs, git, commit, buildIdentity, launchIsolated, rpc, until, pause, appState, openWorkspaceOf,
  instrument, drainEvents, pageNow, readMark, readTriple, tripleAgrees, clickTitle, judgeActivation, closeAllWorkspaces,
} from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const appRoot = path.resolve(String(args.app))
const work = path.resolve(String(args.work ?? '/tmp/l490a'))
const out = path.resolve(String(args.out))
const port = Number(args.port ?? 9490)
const trials = Number(args.trials ?? 7)
const starts = String(args.starts ?? 'none,other,main').split(',')
fs.mkdirSync(out, { recursive: true })
const log = (...parts) => console.log('[l490-race]', ...parts)
const identity = buildIdentity(appRoot)
const rows = []
let handle = null
let alive = []
let wrap = null

async function main() {
  // fixture 는 work 밖 형제 폴더에 둔다 — launchIsolated 가 work 를 지우고 다시 만든다.
  const fixtures = `${work}-repos`
  if (fs.existsSync(fixtures)) fs.rmSync(fixtures, { recursive: true, force: true })
  const root = path.join(fixtures, 'race')
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  commit(root, 'init')
  const targets = starts.flatMap((start) => Array.from({ length: trials }, (_, index) => `${start}-${index}`))
  for (const name of ['anchor', ...targets]) git(root, 'worktree', 'add', '-q', '-b', name, path.join(fixtures, 'race-wt', name))
  const real = fs.realpathSync(fixtures)
  const wt = (name) => path.join(real, 'race-wt', name)
  const mainPath = fs.realpathSync(root)

  handle = await launchIsolated({ appRoot, work, out, port, session: 'l490-race' })
  const { cdp } = handle
  await rpc(handle.control, { cmd: 'add-repo', root: mainPath })
  await until(async () => {
    await rpc(handle.control, { cmd: 'rebuild-tree' }, 30_000)
    return (await cdp.evaluate(() => document.querySelectorAll('[data-worktree]').length)) === targets.length + 2 ? true : null
  }, 'rendered', 60_000, 500)
  wrap = (await instrument(cdp)).wrap

  /** 열린 행을 눌러 활성으로 세운다. 안 열렸으면 먼저 열고(눌러서) 열림을 기다린 뒤 다시 누른다. */
  const makeActive = async (wtPath) => {
    if (openWorkspaceOf(await appState(handle), wtPath) === null) {
      await clickTitle(cdp, wtPath)
      await until(async () => (openWorkspaceOf(await appState(handle), wtPath) !== null ? true : null), `open ${wtPath}`, 20_000, 200)
      await until(async () => (await cdp.evaluate((p) => document.querySelector(`[data-worktree="${p}"] [data-chip-value]`)?.getAttribute('data-chip-value') ?? null, wtPath)) === 'open' ? true : null, `rendered open ${wtPath}`, 20_000, 100)
      await pause(1500) // 열기 뒤 늦게 오는 push 가 가라앉게 — 출발 상태를 흔들지 않는다.
    }
    await clickTitle(cdp, wtPath)
    await until(async () => ((await readMark(cdp)) === wtPath ? true : null), `active ${wtPath}`, 10_000, 100).catch(() => null)
    await pause(800)
  }

  for (const start of starts) {
    for (let index = 0; index < trials; index++) {
      const target = wt(`${start}-${index}`)
      const setup = { start, closed: null, expected: null }
      try {
        if (start === 'none') {
          setup.closed = await closeAllWorkspaces(handle)
          await until(async () => ((await readMark(cdp)) === null ? true : null), 'no mark', 10_000, 100).catch(() => null)
          await pause(800)
          setup.expected = null
        } else if (start === 'other') {
          await makeActive(wt('anchor'))
          setup.expected = wt('anchor')
        } else if (start === 'main') {
          await makeActive(mainPath)
          setup.expected = mainPath
        }
      } catch (error) {
        setup.error = String(error?.message ?? error)
      }
      const beforeTriple = await readTriple(cdp)
      const beforeState = await appState(handle)
      const openBefore = beforeState.repos.flatMap((repo) => repo.worktrees).filter((row) => row.openWorkspaceId !== null).map((row) => row.path)
      const setupOk = setup.error === undefined && beforeTriple.mark === setup.expected &&
        (setup.expected === null ? beforeTriple.active.id === null && openBefore.length === 0 : tripleAgrees({ triple: beforeTriple, state: beforeState, wtPath: setup.expected }).activeOk)
      const t0 = await pageNow(cdp)
      await clickTitle(cdp, target)
      const verdict = await judgeActivation(cdp, { wtPath: target, t0 })
      const after = await appState(handle)
      const triple = await readTriple(cdp)
      const agree = tripleAgrees({ triple, state: after, wtPath: target })
      const events = (await drainEvents(cdp, t0)).map((event) => ({ ...event, dt: event.t - t0 }))
      const row = {
        trial: rows.length,
        start,
        setup: { ...setup, ok: setupOk, openBefore },
        before: { mark: beforeTriple.mark, active: beforeTriple.active.id ?? null },
        target,
        opened: openWorkspaceOf(after, target) !== null,
        reachedAt: verdict.reachedAt,
        held: verdict.held,
        leftAt: verdict.leftAt,
        leftTo: verdict.leftTo,
        pass: setupOk && verdict.reachedAt !== null && verdict.held && agree.all,
        triple: { ...agree, mark: triple.mark, active: triple.active.id ?? null, tabs: triple.tabs },
        events,
      }
      rows.push(row)
      log(JSON.stringify({ trial: row.trial, start, setupOk, before: row.before.mark, reachedAt: row.reachedAt, held: row.held, leftTo: row.leftTo, pass: row.pass, triple: agree.all }))
      await pause(500)
    }
  }
}

let exitCode = 0
try {
  await main()
} catch (error) {
  exitCode = 2
  rows.push({ error: String(error?.stack ?? error) })
  handle ??= error.handle ?? null
} finally {
  if (handle !== null) alive = await handle.stop()
  const trialsRun = rows.filter((row) => row.trial !== undefined)
  const byStart = Object.fromEntries(starts.map((start) => {
    const mine = trialsRun.filter((row) => row.start === start)
    return [start, { trials: mine.length, setupOk: mine.filter((row) => row.setup.ok).length, pass: mine.filter((row) => row.pass).length }]
  }))
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ identity, wrap, trials: trialsRun.length, pass: trialsRun.filter((row) => row.pass).length, byStart, spawned: handle?.spawned ?? [], alive, rows }, null, 2))
  log(`pass ${trialsRun.filter((row) => row.pass).length}/${trialsRun.length} ${JSON.stringify(byStart)}; alive ${JSON.stringify(alive)}`)
  process.exit(exitCode)
}
