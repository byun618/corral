// LIFE-493 수정 r2 G1 — 네이티브 rename 시퀀스(native-k5.mjs ⑧ 와 같은 걸음)를 격리 인스턴스에서 빌드별로 잰다.
// 시퀀스 한 회: (전제) 대상 영역 스트립을 처음으로 돌리고 첫 탭 클릭 → 대상 탭 클릭 → scrollIntoView → `.main-tab-label` 더블클릭
// → 0/100/300ms document.activeElement → ⌘A · 입력 · Enter → 라벨이 바뀌었나.
// 조건: `--layout overflow` = 영역 2개(첫 영역 탭 4 · 둘째 영역에 탭 1 + 20 — r4·r5 fixture 모양) / `--layout plain` = 영역 1개 탭 4.
// 입력은 제어 소켓 sendInputEvent 경로(click·dblclick·key·type), 셸 탭만 — 입력이 새도 fixture 셸 pane 이다.
//
// 사용: node iso-seq.mjs --app <app 폴더> --work /tmp/l493sX --port 94NN --out <raw 폴더> --layout overflow|plain --runs N
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchCorral, rpc } from '../gui-diff/lib/corral.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const appRoot = path.resolve(args.app)
const work = args.work
if (!work?.startsWith('/tmp/l493s')) throw new Error('--work 는 /tmp/l493s*')
const out = path.resolve(args.out)
const layoutKind = args.layout ?? 'overflow'
const runs = Number(args.runs ?? 10)
fs.mkdirSync(out, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const owned = []
const result = { app: appRoot, commit: execFileSync('git', ['-C', appRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['-C', appRoot, 'status', '--short', '--', 'src'], { encoding: 'utf8' }).trim(), layout: layoutKind, startedAt: new Date().toISOString(), runs: [], owned }
const save = () => fs.writeFileSync(path.join(out, 'seq.json'), `${JSON.stringify(result, null, 1)}\n`)

async function until(fn, label, timeout = 30_000, every = 200) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${label}`)
    await pause(every)
  }
}

let control = null
const call = (request) => rpc(control, request, 20_000)
const evaluate = async (code) => (await call({ cmd: 'eval', code })).result

async function main() {
  fs.mkdirSync(work, { recursive: true })
  const fixture = path.join(work, 'fx')
  if (!fs.existsSync(fixture)) {
    fs.mkdirSync(fixture)
    execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })
  }
  const real = fs.realpathSync(fixture)
  const handle = await launchCorral({ appRoot, workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  control = handle.control
  save()

  await call({ cmd: 'add-repo', root: real })
  await call({ cmd: 'rebuild-tree' })
  await until(async () => ((await call({ cmd: 'query', selector: `[data-worktree="${real}"]` })).found ?? []).length > 0, 'fixture 카드')
  const fixtureTabs = async () => {
    const state = (await call({ cmd: 'state' })).state
    for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === real) return (row.workspace?.tabs ?? []).map((tab) => tab.tabId)
    return []
  }
  let clicks = 0
  await until(async () => {
    const dom = await evaluate(`[...document.querySelectorAll('[data-main-tab]')].map((tab) => tab.dataset.mainTab)`)
    const mine = new Set(await fixtureTabs())
    if (dom.length > 0 && dom.every((id) => mine.has(id))) return true
    if (clicks < 6) {
      clicks += 1
      await call({ cmd: 'click', selector: `[data-worktree="${real}"] [data-worktree-card-surface]` })
      await pause(1500)
    }
    return false
  }, 'fixture 화면', 30_000, 500)
  const addTab = async (selector) => {
    const before = new Set(await fixtureTabs())
    await call({ cmd: 'click', selector })
    return until(async () => (await fixtureTabs()).find((id) => !before.has(id)) ?? null, '새 탭')
  }
  while ((await fixtureTabs()).length < 4) await addTab('[data-main-tabbar-add]')
  let group = (await evaluate(`document.querySelector('[data-group-header]')?.dataset.groupHeader`)) ?? 'g1'
  if (layoutKind === 'overflow') {
    // 첫 탭을 우클릭 → 「오른쪽 영역」 (native-k5 ⑥ 과 같은 걸음) → 둘째 영역에 `+` 20번.
    const first = (await fixtureTabs())[0]
    const rect = (await call({ cmd: 'rect', selector: `[data-main-tab="${first}"]` })).rect
    const x = Math.round(rect.left + 20)
    const y = Math.round(rect.top + 10)
    await call({ cmd: 'raw-mouse', type: 'mouseDown', x, y, button: 'right' })
    await call({ cmd: 'raw-mouse', type: 'mouseUp', x, y, button: 'right' })
    await pause(300)
    await call({ cmd: 'click', selector: '[data-tab-menu-move-right]' })
    await until(async () => (await evaluate(`document.querySelectorAll('[data-group-header]').length`)) === 2, '영역 2개')
    group = await evaluate(`[...document.querySelectorAll('[data-group-header]')].find((header) => header.querySelector('[data-main-tab="${first}"]'))?.dataset.groupHeader`)
    for (let index = 0; index < 20; index += 1) await addTab(`[data-main-tabbar-add="${group}"]`)
  }
  await pause(1500)
  const groupTabs = async () => evaluate(`[...document.querySelectorAll('[data-group-header="${group}"] [data-main-tab]')].map((tab) => tab.dataset.mainTab)`)
  result.setup = await evaluate(`({ w: innerWidth, h: innerHeight, focus: document.hasFocus(), areas: document.querySelectorAll('[data-group-header]').length, group: '${group}', tabs: document.querySelectorAll('[data-group-header="${group}"] [data-main-tab]').length, compact: document.querySelectorAll('.main-tab.is-compact').length, strip: (() => { const s = document.querySelector('[data-main-tab-strip="${group}"]'); return s ? { sw: s.scrollWidth, cw: s.clientWidth } : null })() })`)
  save()

  const stripRead = `(() => { const s = document.querySelector('[data-main-tab-strip="${group}"]'); return s ? s.scrollLeft : null })()`
  for (let run = 0; run < runs; run += 1) {
    const tabs = await groupTabs()
    // 전제: native-k5 의 first-tab-after-wheel 처럼 스트립을 처음으로 돌리고 첫 탭을 누른다.
    await evaluate(`(() => { const s = document.querySelector('[data-main-tab-strip="${group}"]'); if (s) for (let i = 0; i < 40; i += 1) s.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })) })()`)
    const firstClick = await call({ cmd: 'click', selector: `[data-main-tab="${tabs[0]}"]` })
    await pause(400)
    const target = tabs[1 + (run % 3)]
    const label = `l493-r${run}`
    // native-k5 ⑧ 그대로: 대상 클릭(실패해도 계속) → scrollIntoView → 라벨 더블클릭 → 300ms → ⌘A → 입력 → Enter
    const targetClick = await call({ cmd: 'click', selector: `[data-main-tab="${target}"]` })
    const scrollBefore = await evaluate(stripRead)
    await evaluate(`document.querySelector('[data-main-tab="${target}"]')?.scrollIntoView({inline:'nearest'})`)
    const dbl = await call({ cmd: 'dblclick', selector: `[data-main-tab="${target}"] .main-tab-label` })
    const startedAt = Date.now()
    const samples = []
    for (const at of [0, 100, 300]) {
      const wait = startedAt + at - Date.now()
      if (wait > 0) await pause(wait)
      samples.push({ at, ...(await evaluate(`({ el: document.activeElement?.tagName + '.' + (document.activeElement?.className ?? '').toString().slice(0, 40), editing: document.querySelector('[data-main-tab="${target}"]')?.dataset.tabEditing ?? null, active: document.querySelector('[data-main-tab="${target}"]')?.classList.contains('is-active') ?? null, scrollLeft: ${stripRead} })`)) })
    }
    await call({ cmd: 'key', keyCode: 'a', modifiers: ['meta'] })
    await call({ cmd: 'type', text: label })
    await call({ cmd: 'key', keyCode: 'Enter' })
    await pause(600)
    const after = await evaluate(`document.querySelector('[data-main-tab="${target}"] .main-tab-label')?.textContent ?? null`)
    const row = {
      run, target,
      firstClick: { ok: firstClick.ok, hit: firstClick.hit ?? null, blockedBy: firstClick.blockedBy ?? null },
      targetClick: { ok: targetClick.ok, hit: targetClick.hit ?? null, blockedBy: targetClick.blockedBy ?? null },
      scrollBefore, dblclick: { ok: dbl.ok, hit: dbl.hit ?? null, blockedBy: dbl.blockedBy ?? null, x: dbl.x ?? null },
      samples, labelAfter: after, ok: after === label,
    }
    result.runs.push(row)
    console.log('[seq]', JSON.stringify(row))
    save()
    // 정리 — 남은 입력칸이 있으면 포커스를 돌려 Escape.
    await evaluate(`document.querySelector('.main-tab-rename.is-editing')?.focus()`)
    await call({ cmd: 'key', keyCode: 'Escape' })
    await pause(300)
  }
}

async function cleanup() {
  for (const entry of [...owned].reverse()) {
    if (!entry.pid) continue
    try { process.kill(entry.pid, 'SIGTERM') } catch {}
  }
  await pause(2000)
  result.survivors = owned.filter((entry) => entry.pid).filter((entry) => { try { process.kill(entry.pid, 0); return true } catch { return false } }).map((entry) => entry.pid)
  result.endedAt = new Date().toISOString()
  save()
}

main().then(
  async () => { await cleanup(); console.log('[seq] done', JSON.stringify({ ok: result.runs.filter((row) => row.ok).length, runs: result.runs.length, survivors: result.survivors })) },
  async (error) => { result.error = String(error?.stack ?? error); await cleanup(); console.log('[seq] error', result.error.slice(0, 400)); process.exit(2) },
)
