// LIFE-493 수정 r1 — 격리 인스턴스 탐침 (F1 hover 닫기 노출 · F2 더블클릭 rename 포커스).
// 같은 하네스로 **빌드만 바꿔** A/B 를 잰다: `--app` 이 가리키는 app 폴더의 빌드 산출물·Electron 을 띄운다.
// 환경은 /tmp/l493i* 아래 격리(userData·herdr 세션 `l443-gui-diff`·제어 소켓) — 사용자 userData·herdr default 와 겹치지 않는다.
// 입력은 전부 제어 소켓의 `sendInputEvent` 경로(raw-mouse·dblclick)다. 탭은 fixture 레포의 셸 탭뿐이다.
//
// 사용: node iso-probe.mjs --app <app 폴더> --work /tmp/l493iX --port 94NN --out <raw 폴더> --hover N --rename N
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchCorral, rpc } from '../gui-diff/lib/corral.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const appRoot = path.resolve(args.app)
const work = args.work
if (!work?.startsWith('/tmp/l493i')) throw new Error('--work 는 /tmp/l493i*')
const out = path.resolve(args.out)
const hoverRuns = Number(args.hover ?? 0)
const renameRuns = Number(args.rename ?? 0)
// base 는 탭이 헤더 폭을 넘으면 비활성 탭을 26px 로 접어 라벨을 숨긴다(compact) — A/B 는 두 빌드 다 접히지 않는 탭 수로 맞춘다.
const tabTarget = Number(args.tabs ?? 6)
// `--target active` 면 활성 탭 라벨을 더블클릭한다(선택이 바뀌지 않는 경로 — 비활성 탭과 가르는 대조군).
const renameTarget = args.target ?? 'inactive'
fs.mkdirSync(out, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const owned = []
const result = { app: appRoot, commit: execFileSync('git', ['-C', appRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), startedAt: new Date().toISOString(), hover: [], rename: [], owned }
const save = () => fs.writeFileSync(path.join(out, 'probe.json'), `${JSON.stringify(result, null, 1)}\n`)

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

  // fixture 를 열고 셸 탭 `--tabs` 개를 `+` 로 만든다(제품 경로).
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
  result.cardClicks = clicks
  while ((await fixtureTabs()).length < tabTarget) {
    const before = (await fixtureTabs()).length
    await call({ cmd: 'click', selector: '[data-main-tabbar-add]' })
    await until(async () => (await fixtureTabs()).length > before, '새 탭')
  }
  await pause(1500)
  result.window = await evaluate(`({ w: innerWidth, h: innerHeight, focus: document.hasFocus(), visibility: document.visibilityState, tabs: document.querySelectorAll('[data-main-tab]').length, compact: document.querySelectorAll('.main-tab.is-compact').length })`)
  save()

  const rectOf = async (selector) => (await call({ cmd: 'rect', selector })).rect
  const inactiveTabs = async () => evaluate(`[...document.querySelectorAll('[data-main-tab]')].filter((tab) => !tab.classList.contains('is-active')).map((tab) => tab.dataset.mainTab)`)

  // F1 — 비활성 탭 위로 포인터(sendInputEvent mouseMove) → 닫기 계산 색 → 포인터를 탭바 밖으로 → 다시 계산 색.
  for (let run = 0; run < hoverRuns; run += 1) {
    const ids = await inactiveTabs()
    const tabId = ids[run % ids.length]
    const rect = await rectOf(`[data-main-tab="${tabId}"]`)
    const away = await rectOf('[data-main-tabbar]')
    const awayPoint = { x: Math.round(away.left + away.width / 2), y: Math.round(away.top + away.height + 120) }
    await call({ cmd: 'raw-mouse', type: 'mouseMove', ...awayPoint })
    await pause(150)
    const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    await call({ cmd: 'raw-mouse', type: 'mouseMove', ...point })
    const read = `(() => { const tab = document.querySelector('[data-main-tab="${tabId}"]'); const close = tab.querySelector('[data-tab-close-button], [data-main-tab-close]'); return { hover: tab.matches(':hover'), close: close ? getComputedStyle(close).color : null, at: document.elementFromPoint(${point.x}, ${point.y})?.closest('[data-main-tab]')?.dataset.mainTab ?? null, focus: document.hasFocus(), visibility: document.visibilityState } })()`
    await pause(200)
    const on = await evaluate(read)
    await call({ cmd: 'raw-mouse', type: 'mouseMove', ...awayPoint })
    await pause(200)
    const off = await evaluate(read)
    const row = { run, tabId, point, on, off, ok: on.close !== 'rgba(0, 0, 0, 0)' && off.close === 'rgba(0, 0, 0, 0)' }
    result.hover.push(row)
    console.log('[hover]', JSON.stringify(row))
    save()
  }

  // F2 — 비활성 탭 라벨 더블클릭(sendInputEvent clickCount 1·2) → 0/100/300ms 의 document.activeElement.
  for (let run = 0; run < renameRuns; run += 1) {
    const ids = renameTarget === 'active' ? await evaluate(`[...document.querySelectorAll('[data-main-tab].is-active')].map((tab) => tab.dataset.mainTab)`) : await inactiveTabs()
    const tabId = ids[run % ids.length]
    const reply = await call({ cmd: 'dblclick', selector: `[data-main-tab="${tabId}"] .main-tab-label` })
    const samples = []
    const startedAt = Date.now()
    for (const at of [0, 100, 300]) {
      const wait = startedAt + at - Date.now()
      if (wait > 0) await pause(wait)
      samples.push({ at, ...(await evaluate(`({ el: document.activeElement?.tagName + '.' + (document.activeElement?.className ?? '').toString().slice(0, 40), input: !!document.querySelector('.main-tab-rename.is-editing') })`)) })
    }
    const ok = samples.every((sample) => sample.el.startsWith('INPUT.main-tab-rename'))
    const row = { run, target: renameTarget, tabId, dblclick: { ok: reply.ok, hit: reply.hit ?? null }, samples, ok }
    result.rename.push(row)
    console.log('[rename]', JSON.stringify(row))
    save()
    // 정리 — 열린 입력칸을 Escape 로 닫는다(포커스를 입력칸에 돌려놓은 뒤). 입력이 셸로 새도 fixture 셸 pane 이다.
    await evaluate(`document.querySelector('.main-tab-rename.is-editing')?.focus()`)
    await call({ cmd: 'key', keyCode: 'Escape' })
    await pause(400)
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
  async () => { await cleanup(); console.log('[iso] done', JSON.stringify({ hoverOk: result.hover.filter((row) => row.ok).length, hover: result.hover.length, renameOk: result.rename.filter((row) => row.ok).length, rename: result.rename.length, survivors: result.survivors })) },
  async (error) => { result.error = String(error?.stack ?? error); await cleanup(); console.log('[iso] error', result.error.slice(0, 400)); process.exit(2) },
)
