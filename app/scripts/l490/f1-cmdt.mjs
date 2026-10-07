// LIFE-490 fix1 F1 (r1 G-1) — 안 연 링크 워크트리를 누르고 **응답 뒤·도착 전**에 ⌘T. 활성이 새 워크트리로 남고 새 탭이 그 워크트리에 생기나.
//
// 창을 잡는 법: 클릭 뒤 페이지 안 계측(`instrument`)을 짧게 훑어, React activeWorkspaceId 가 「마지막 state 의 열린 목록에 없는 id」 로
// 바뀐 순간(= openWorktree 응답의 활성 — IPC 는 감쌀 수 없다, K1 과 같은 추론)에 CDP 키 이벤트로 ⌘T 를 보낸다.
// 회차마다 ⌘T 가 실제로 창 안이었는지(⌘T 시각 < 새 workspace 가 state 에 처음 실린 시각)를 원자료에 적는다 — 창 밖이면 그 회차는 `inWindow:false`.
// 출발은 ③ main 활성(옛 규칙이 승격하는 곳). 대상 = 안 연 링크 `t-<n>`.
// 판정(회차): 5초 안 활성·5초 유지(표식) + 세 축 일치 + 대상 탭 수 = 열기 1 + ⌘T 1 + 다른 workspace 탭 수 불변.
// 사용: node <이 파일> --app <앱 루트> --out <raw 폴더> [--work /tmp/l490f] [--port 9496] [--trials 5]
// 결과: <out>/result.json. 종료코드 0 = 완주(판정은 값으로).

/* global document, window */
import fs from 'node:fs'
import path from 'node:path'
import {
  parseArgs, git, commit, buildIdentity, launchIsolated, rpc, until, pause, appState, openWorkspaceOf,
  instrument, drainEvents, pageNow, readMark, readTriple, tripleAgrees, clickTitle, judgeActivation,
} from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const appRoot = path.resolve(String(args.app))
const work = path.resolve(String(args.work ?? '/tmp/l490f'))
const out = path.resolve(String(args.out))
const port = Number(args.port ?? 9496)
const trials = Number(args.trials ?? 5)
fs.mkdirSync(out, { recursive: true })
const log = (...parts) => console.log('[l490-f1]', ...parts)
const identity = buildIdentity(appRoot)
const rows = []
let handle = null
let alive = []

const tabsOf = (state) => Object.fromEntries(state.repos.flatMap((repo) => repo.worktrees).filter((row) => row.workspace !== null).map((row) => [row.path, row.workspace.tabs.length]))

async function main() {
  const fixtures = `${work}-repos`
  if (fs.existsSync(fixtures)) fs.rmSync(fixtures, { recursive: true, force: true })
  const root = path.join(fixtures, 'f1')
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  commit(root, 'init')
  const names = Array.from({ length: trials }, (_, index) => `t-${index}`)
  for (const name of names) git(root, 'worktree', 'add', '-q', '-b', name, path.join(fixtures, 'f1-wt', name))
  const real = fs.realpathSync(fixtures)
  const wt = (name) => path.join(real, 'f1-wt', name)
  const mainPath = fs.realpathSync(root)

  handle = await launchIsolated({ appRoot, work, out, port, session: 'l490-f1' })
  const { cdp } = handle
  await rpc(handle.control, { cmd: 'add-repo', root: mainPath })
  await until(async () => {
    await rpc(handle.control, { cmd: 'rebuild-tree' }, 30_000)
    return (await cdp.evaluate(() => document.querySelectorAll('[data-worktree]').length)) === names.length + 1 ? true : null
  }, 'rendered', 60_000, 500)
  await instrument(cdp)

  for (const name of names) {
    const target = wt(name)
    // 출발 ③ — main 을 열고(처음 한 번) 열린 행을 눌러 활성.
    if (openWorkspaceOf(await appState(handle), mainPath) === null) {
      await clickTitle(cdp, mainPath)
      await until(async () => (openWorkspaceOf(await appState(handle), mainPath) !== null ? true : null), 'open main', 20_000, 200)
      await pause(1500)
    }
    await clickTitle(cdp, mainPath)
    await until(async () => ((await readMark(cdp)) === mainPath ? true : null), 'main active', 10_000, 100).catch(() => null)
    await pause(800)
    const before = await readTriple(cdp)
    const tabsBefore = tabsOf(await appState(handle))

    const t0 = await pageNow(cdp)
    await clickTitle(cdp, target)
    // 응답(활성 id 가 state 에 아직 없는 id 로 바뀜)을 짧게 훑는다 — 보이면 곧바로 ⌘T.
    let respAt = null
    let respId = null
    const pollStart = Date.now()
    while (Date.now() - pollStart < 5000) {
      const seen = await cdp.evaluate(() => {
        const states = window.__l490.events.filter((event) => event.kind === 'state')
        const open = states.length === 0 ? [] : states[states.length - 1].open
        const id = window.__l490.readActive().id ?? null
        return id !== null && !open.includes(id) ? { id, t: Date.now() } : null
      })
      if (seen !== null) {
        respAt = seen.t - t0
        respId = seen.id
        break
      }
    }
    let cmdTAt = null
    if (respId !== null) {
      for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: 4 })
      cmdTAt = (await pageNow(cdp)) - t0
    }
    const verdict = await judgeActivation(cdp, { wtPath: target, t0 })
    await until(async () => ((tabsOf(await appState(handle)))[target] === 2 ? true : null), 'target tabs 2', 10_000, 200).catch(() => null)
    await pause(800)
    const after = await appState(handle)
    const tabsAfter = tabsOf(after)
    const triple = await readTriple(cdp)
    const agree = tripleAgrees({ triple, state: after, wtPath: target })
    const events = (await drainEvents(cdp, t0)).map((event) => ({ ...event, dt: event.t - t0 }))
    const arriveAt = events.find((event) => event.kind === 'state' && respId !== null && event.open.includes(respId))?.dt ?? null
    const othersSame = Object.keys(tabsBefore).every((key) => tabsAfter[key] === tabsBefore[key])
    const row = {
      trial: rows.length,
      target,
      before: { mark: before.mark, active: before.active.id ?? null },
      respAt,
      respId,
      cmdTAt,
      arriveAt,
      inWindow: cmdTAt !== null && arriveAt !== null && cmdTAt < arriveAt,
      reachedAt: verdict.reachedAt,
      held: verdict.held,
      leftAt: verdict.leftAt,
      leftTo: verdict.leftTo,
      tabsBefore,
      tabsAfter,
      targetTabs: tabsAfter[target] ?? 0,
      othersSame,
      triple: { ...agree, mark: triple.mark, active: triple.active.id ?? null, tabs: triple.tabs },
      pass: before.mark === mainPath && verdict.reachedAt !== null && verdict.held && agree.all && tabsAfter[target] === 2 && othersSame,
      events,
    }
    rows.push(row)
    log(JSON.stringify({ trial: row.trial, respAt, cmdTAt, arriveAt, inWindow: row.inWindow, reachedAt: row.reachedAt, held: row.held, leftTo: row.leftTo, targetTabs: row.targetTabs, othersSame, pass: row.pass }))
    await pause(500)
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
  const run = rows.filter((row) => row.trial !== undefined)
  const summary = {
    trials: run.length,
    pass: run.filter((row) => row.pass).length,
    inWindow: run.filter((row) => row.inWindow).length,
    passInWindow: run.filter((row) => row.inWindow && row.pass).length,
  }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ identity, summary, spawned: handle?.spawned ?? [], alive, rows }, null, 2))
  log(`summary ${JSON.stringify(summary)}; alive ${JSON.stringify(alive)}`)
  process.exit(exitCode)
}
