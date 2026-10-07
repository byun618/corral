// LIFE-491 K6ⓗ — Orca 1.4.198 개발 인스턴스(443 측정 도구 `gui-diff/lib/orca.mjs` — 버리는 HOME·격리 userData)에
// `detached-display.mjs` 와 같은 모양의 fixture 를 물려 detached 카드의 제목·배지 문구·툴팁을 덤프·캡처한다.
// 설치본 Orca(/Applications)는 건드리지 않는다 — 소스 사본 `/tmp/l443/orca-198` 를 `electron-vite dev` 로 띄운다.
// 사용: node <이 파일> --orca /tmp/l443/orca-198 --out <raw 폴더> [--work /tmp/l490o] [--port 9494]
// 결과: <out>/result.json · <out>/*.png. 끝에 프로세스 그룹을 SIGTERM 하고 살아남은 것을 적는다.

/* global document, window */
import fs from 'node:fs'
import path from 'node:path'
import { launchOrca, seedOrcaRepo } from '../gui-diff/lib/orca.mjs'
import { parseArgs, git, commit, until, pause } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const orcaRoot = path.resolve(String(args.orca ?? '/tmp/l443/orca-198'))
const work = path.resolve(String(args.work ?? '/tmp/l490o'))
if (!work.startsWith('/tmp/l490')) throw new Error(`--work 는 /tmp/l490* 아래: ${work}`)
const out = path.resolve(String(args.out))
const port = Number(args.port ?? 9494)
fs.mkdirSync(out, { recursive: true })
const log = (...parts) => console.log('[l490-orca198]', ...parts)
const result = { orcaRoot, orcaHead: null, steps: {} }
const groups = []
let handle = null

const shot = async (cdp, name, clip = null) => {
  const response = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip === null ? {} : { clip: { ...clip, scale: 1 } }) })
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(response.data, 'base64'))
  return `${name}.png`
}

async function main() {
  try {
    result.orcaHead = git(orcaRoot, 'rev-parse', 'HEAD')
    result.orcaDescribe = git(orcaRoot, 'describe', '--tags', '--always')
  } catch (error) {
    result.orcaHead = `git 실패: ${String(error?.message ?? error).slice(0, 200)}`
  }
  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true, mode: 0o700 })
  const fixtures = `${work}-repos`
  if (fs.existsSync(fixtures)) fs.rmSync(fixtures, { recursive: true, force: true })
  const root = path.join(fixtures, 'det-repo')
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  commit(root, 'c1')
  const c1 = git(root, 'rev-parse', 'HEAD')
  commit(root, 'c2')
  const c2 = git(root, 'rev-parse', 'HEAD')
  commit(root, 'c3')
  git(root, 'worktree', 'add', '-q', '-b', 'feat-x', path.join(fixtures, 'wt', 'feat'))
  git(root, 'worktree', 'add', '-q', '--detach', path.join(fixtures, 'wt', 'da'), c1)
  git(root, 'worktree', 'add', '-q', '--detach', path.join(fixtures, 'wt', 'db'), c2)
  const mainPath = fs.realpathSync(root)
  const wt = (name) => fs.realpathSync(path.join(fixtures, 'wt', name))
  result.fixture = { root: mainPath, heads: Object.fromEntries(['da', 'db', 'feat'].map((name) => [wt(name), git(wt(name), 'rev-parse', 'HEAD')])) }

  handle = await launchOrca({
    repoRoot: orcaRoot,
    workDir: work,
    port,
    logPath: path.join(out, 'orca-dev.log'),
    onSpawn: (entry) => {
      if (entry.pid !== undefined) groups.push({ pid: entry.pid, label: entry.label })
    },
  })
  const { cdp } = handle
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const repoId = await seedOrcaRepo(handle, mainPath, { expectedWorktrees: 4 })
  await pause(1500)
  result.steps.store = await cdp.evaluate((id) => (window.__store.getState().worktreesByRepo[id] ?? []).map((w) => ({ path: w.path, branch: w.branch, head: w.head, displayName: w.displayName, isMainWorktree: w.isMainWorktree })), repoId)
  result.steps.settings = await cdp.evaluate(() => {
    const s = window.__store.getState()
    return { compactCards: s.settings?.compactWorktreeCards ?? null, newCardStyle: s.settings?.newWorktreeCardStyle ?? null, cardLayout: s.worktreeCardLayout ?? null }
  })
  result.steps.cards = await cdp.evaluate(() => [...document.querySelectorAll('[data-worktree-id]')].map((row) => ({
    id: row.getAttribute('data-worktree-id'),
    text: row.textContent,
    badges: [...row.querySelectorAll('[aria-label^="Detached HEAD at"]')].map((el) => ({ text: el.textContent, ariaLabel: el.getAttribute('aria-label') })),
  })))
  const sidebar = await cdp.evaluate(() => {
    const first = document.querySelector('[data-worktree-id]')
    let el = first
    while (el && el.parentElement && el.getBoundingClientRect().width < 200) el = el.parentElement
    const r = (el ?? first)?.getBoundingClientRect()
    return r ? { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 40), width: r.width + 16, height: Math.min(900, r.height + 80) } : null
  })
  result.steps.shots = [await shot(cdp, 'k6h-orca198-sidebar', sidebar), await shot(cdp, 'k6h-orca198-window')]
  // 배지 hover → Radix 툴팁 문구.
  const badge = await cdp.evaluate(() => {
    const el = document.querySelector('[aria-label^="Detached HEAD at"]')
    el?.scrollIntoView({ block: 'center' })
    const r = el?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })
  if (badge !== null) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: badge.x, y: badge.y, button: 'none', buttons: 0 })
    // 화면에 다른 안내 툴팁(기능 공지)이 떠 있을 수 있다 — 배지 문구의 툴팁만 고른다(o01 은 공지를 집었다).
    const tip = await until(() => cdp.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].map((el) => el.textContent).find((text) => text?.startsWith('Detached HEAD at')) ?? null), 'tooltip', 5_000, 100).catch(() => null)
    result.steps.tooltip = tip
    result.steps.shots.push(await shot(cdp, 'k6h-orca198-tooltip'))
  } else result.steps.tooltip = '배지 없음'
}

let exitCode = 0
try {
  await main()
} catch (error) {
  exitCode = 2
  result.error = String(error?.stack ?? error)
} finally {
  await handle?.cdp?.close().catch(() => {})
  for (const group of groups) {
    try {
      process.kill(-group.pid, 'SIGTERM')
    } catch {
      // 이미 끝났다.
    }
  }
  await pause(3000)
  result.groups = groups
  result.aliveGroups = groups.filter((group) => {
    try {
      process.kill(-group.pid, 0)
      return true
    } catch {
      return false
    }
  })
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
  log(`done error=${result.error ? 'yes' : 'no'} aliveGroups=${JSON.stringify(result.aliveGroups)}`)
  process.exit(exitCode)
}
