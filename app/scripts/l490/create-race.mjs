// LIFE-490 K3 — 생성 모달로 새 링크 워크트리를 만들면 그 워크트리가 5초 안에 활성이 되고 5초 동안 유지되나(D3).
// 그리고 생성 실패(이미 있는 브랜치)면 활성이 그대로인가.
//
// 출발 상태는 `activate-race.mjs` 와 같은 방식으로 세운다(none ① · other ② · main ③). 생성은 실제 UI 로 한다 —
// 레포 행의 「워크트리 생성」 단추(`data-create-worktree`) → 브랜치 입력(`Input.insertText`) → 「생성」.
// 사용: node <이 파일> --app <앱 루트> --out <raw 폴더> [--work /tmp/l490c] [--port 9491] [--trials 2] [--starts none,main,other]
// 결과: <out>/result.json — 회차별 {start, kind:'create'|'fail', target, reachedAt, held, activeAfter, note}. 종료코드 0 = 완주.

/* global document */
import fs from 'node:fs'
import path from 'node:path'
import {
  parseArgs, git, commit, buildIdentity, launchIsolated, rpc, until, pause, appState, openWorkspaceOf,
  instrument, drainEvents, pageNow, readMark, readTriple, tripleAgrees, clickTitle, clickAt, judgeActivation, closeAllWorkspaces,
} from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const appRoot = path.resolve(String(args.app))
const work = path.resolve(String(args.work ?? '/tmp/l490c'))
const out = path.resolve(String(args.out))
const port = Number(args.port ?? 9491)
const trials = Number(args.trials ?? 2)
const starts = String(args.starts ?? 'none,main,other').split(',')
fs.mkdirSync(out, { recursive: true })
const log = (...parts) => console.log('[l490-create]', ...parts)
const identity = buildIdentity(appRoot)
const rows = []
let handle = null
let alive = []

async function main() {
  const fixtures = `${work}-repos`
  if (fs.existsSync(fixtures)) fs.rmSync(fixtures, { recursive: true, force: true })
  const root = path.join(fixtures, 'mk')
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  commit(root, 'init')
  git(root, 'worktree', 'add', '-q', '-b', 'anchor', path.join(fixtures, 'mk-wt', 'anchor'))
  const mainPath = fs.realpathSync(root)
  const anchor = fs.realpathSync(path.join(fixtures, 'mk-wt', 'anchor'))

  handle = await launchIsolated({ appRoot, work, out, port, session: 'l490-create' })
  const { cdp } = handle
  await rpc(handle.control, { cmd: 'add-repo', root: mainPath })
  await until(async () => {
    await rpc(handle.control, { cmd: 'rebuild-tree' }, 30_000)
    return (await cdp.evaluate(() => document.querySelectorAll('[data-worktree]').length)) === 2 ? true : null
  }, 'rendered', 60_000, 500)
  await instrument(cdp)

  const makeActive = async (wtPath) => {
    if (openWorkspaceOf(await appState(handle), wtPath) === null) {
      await clickTitle(cdp, wtPath)
      await until(async () => (openWorkspaceOf(await appState(handle), wtPath) !== null ? true : null), `open ${wtPath}`, 20_000, 200)
      await pause(1500)
    }
    await clickTitle(cdp, wtPath)
    await until(async () => ((await readMark(cdp)) === wtPath ? true : null), `active ${wtPath}`, 10_000, 100).catch(() => null)
    await pause(800)
  }
  const setupStart = async (start) => {
    if (start === 'none') {
      await closeAllWorkspaces(handle)
      await until(async () => ((await readMark(cdp)) === null ? true : null), 'no mark', 10_000, 100).catch(() => null)
      await pause(800)
      return null
    }
    const target = start === 'main' ? mainPath : anchor
    await makeActive(target)
    return target
  }
  /** 모달을 띄우고 브랜치를 넣고 「생성」. 경로는 모달이 브랜치에서 만든다(`<root>/.claude/worktrees/<slug>`). */
  const createViaModal = async (branch) => {
    // 단추는 레포 행에 마우스가 있을 때만 펴진다(`.repo-row.is-active .is-reveal`) — 행 위로 먼저 옮긴다.
    const rowPoint = await cdp.evaluate((r) => {
      const el = document.querySelector(`[data-create-worktree="${r}"]`)?.closest('.repo-row')
      el?.scrollIntoView({ block: 'center' })
      const rect = el?.getBoundingClientRect()
      return rect ? { x: rect.left + 30, y: rect.top + rect.height / 2 } : null
    }, mainPath)
    if (rowPoint === null) throw new Error('레포 행 없음')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowPoint.x, y: rowPoint.y, button: 'none', buttons: 0 })
    const button = await until(() => cdp.evaluate((r) => {
      const rect = document.querySelector(`[data-create-worktree="${r}"]`)?.getBoundingClientRect()
      return rect && rect.width > 8 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    }, mainPath), 'create button revealed', 5_000, 50)
    await clickAt(cdp, button)
    await until(async () => (await cdp.evaluate(() => document.querySelector('[data-create-worktree-modal]') !== null)) || null, 'modal', 5_000, 50)
    const input = await cdp.evaluate(() => {
      const el = document.querySelector('[data-worktree-branch-input]')
      const rect = el.getBoundingClientRect()
      return { x: rect.left + 10, y: rect.top + rect.height / 2 }
    })
    await clickAt(cdp, input)
    await cdp.send('Input.insertText', { text: branch })
    const submit = await cdp.evaluate(() => {
      const rect = document.querySelector('[data-worktree-create-submit]').getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })
    const t0 = await pageNow(cdp)
    await clickAt(cdp, submit)
    return t0
  }

  let serial = 0
  for (const start of starts) {
    for (let index = 0; index < trials; index++) {
      const expected = await setupStart(start)
      const before = await readTriple(cdp)
      const branch = `mk-${start}-${serial++}`
      const target = path.join(mainPath, '.claude/worktrees', branch)
      const t0 = await createViaModal(branch)
      const verdict = await judgeActivation(cdp, { wtPath: target, t0 })
      const state = await appState(handle)
      const triple = await readTriple(cdp)
      const agree = tripleAgrees({ triple, state, wtPath: target })
      const modalOpen = await cdp.evaluate(() => document.querySelector('[data-create-worktree-modal]') !== null)
      const row = {
        trial: rows.length, kind: 'create', start, setupOk: before.mark === expected, before: { mark: before.mark, active: before.active.id ?? null },
        target, created: state.repos.flatMap((repo) => repo.worktrees).some((item) => item.path === target), opened: openWorkspaceOf(state, target) !== null,
        reachedAt: verdict.reachedAt, held: verdict.held, leftAt: verdict.leftAt, leftTo: verdict.leftTo, modalOpenAfter: modalOpen,
        pass: before.mark === expected && verdict.reachedAt !== null && verdict.held && agree.all,
        triple: { ...agree, mark: triple.mark, active: triple.active.id ?? null, tabs: triple.tabs },
        events: (await drainEvents(cdp, t0)).map((event) => ({ ...event, dt: event.t - t0 })),
      }
      rows.push(row)
      log(JSON.stringify({ trial: row.trial, start, setupOk: row.setupOk, created: row.created, reachedAt: row.reachedAt, held: row.held, pass: row.pass }))
      if (modalOpen) await cdp.evaluate(() => document.querySelector('[data-create-worktree-cancel]')?.click())
      await pause(500)
    }
  }

  // 실패 회차 — 이미 있는 브랜치(`anchor`)로 만든다. main 을 활성으로 세우고, 실패 뒤 5초 동안 활성이 그대로인가.
  const expected = await setupStart('main')
  const before = await readTriple(cdp)
  const t0 = await createViaModal('anchor')
  await until(async () => (await cdp.evaluate(() => document.querySelector('[data-worktree-create-note]')?.textContent ?? null)) || null, 'failure note', 15_000, 100).catch(() => null)
  const marks = []
  const holdStart = Date.now()
  while (Date.now() - holdStart < 5000) {
    marks.push(await readMark(cdp))
    await pause(200)
  }
  const triple = await readTriple(cdp)
  const note = await cdp.evaluate(() => document.querySelector('[data-worktree-create-note]')?.textContent ?? null)
  rows.push({
    trial: rows.length, kind: 'fail', start: 'main', setupOk: before.mark === expected, before: { mark: before.mark, active: before.active.id ?? null },
    note, marksDuring: [...new Set(marks)], activeAfter: triple.active.id ?? null,
    pass: before.mark === expected && note !== null && marks.every((mark) => mark === expected) && triple.active.id === before.active.id,
    events: (await drainEvents(cdp, t0)).map((event) => ({ ...event, dt: event.t - t0 })),
  })
  log(JSON.stringify({ trial: rows.at(-1).trial, kind: 'fail', note, marks: rows.at(-1).marksDuring, pass: rows.at(-1).pass }))
  await cdp.evaluate(() => document.querySelector('[data-create-worktree-cancel]')?.click())
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
  const run = rows.filter((row) => row.trial !== undefined)
  const creates = run.filter((row) => row.kind === 'create')
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ identity, creates: creates.length, createPass: creates.filter((row) => row.pass).length, failPass: run.filter((row) => row.kind === 'fail' && row.pass).length, spawned: handle?.spawned ?? [], alive, rows }, null, 2))
  log(`create ${creates.filter((row) => row.pass).length}/${creates.length}; fail-case ${run.filter((row) => row.kind === 'fail' && row.pass).length}/${run.filter((row) => row.kind === 'fail').length}; alive ${JSON.stringify(alive)}`)
  process.exit(exitCode)
}
