// LIFE-493 수정 r2 G1 — 네이티브 rename 시퀀스 A/B (사용자 userData + herdr default, native-up.sh 가 띄운 앱).
// 걸음은 iso-seq.mjs·native-k5.mjs ⑧ 과 같다: 스트립을 처음으로 → 첫 탭 클릭 → 대상 탭 클릭 → scrollIntoView → 라벨 더블클릭
// → 0/100/300ms document.activeElement → ⌘A · 입력 · Enter → 라벨이 바뀌었나.
//   --mode plain    : fixture 워크스페이스를 영역 1개·셸 탭 4개로 만들고 잰 뒤, 탭을 1개로 되돌린다(뒤이은 native-k5 가 r4·r5 모양을 만든다)
//   --mode overflow : native-k5 가 남긴 상태에서 가장 넘친 영역을 잰다
//   --mode built    : native-k5 없이 영역 2개 + 둘째 영역 탭 21개를 직접 만들고 잰다(세 빌드 공통 넘침 조건)
// 원자료 경계: fixture 워크스페이스 탭만 다룬다 — 화면에 fixture 밖 탭이 보이면 멈춘다. 입력이 새도 fixture 셸 pane 이다.
//
// 사용: node native-seq.mjs <ROOT> <raw 폴더> <fixture 경로(realpath)> <plain|overflow|built> <회수> [--trace]
//   --trace: scrollIntoView 호출·focusin 대상과 호출 스택·스트립 scroll 을 회차마다 events 칸에 적는다(읽기 전용 계측)
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [root, rawd, fixture, mode, runsArg] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l493n')) throw new Error('ROOT 는 /tmp/l493n*')
const ctl = path.join(root, 'ctl.sock')
const runs = Number(runsArg ?? 10)
fs.mkdirSync(rawd, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const call = (request) => rpc(ctl, request, 20_000)
const evaluate = async (code) => (await call({ cmd: 'eval', code })).result
const result = { mode, startedAt: new Date().toISOString(), runs: [] }
const outFile = path.join(rawd, `seq-${mode}.json`)
const save = () => fs.writeFileSync(outFile, `${JSON.stringify(result, null, 1)}\n`)

async function until(fn, label, timeout = 30_000, every = 200) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${label}`)
    await pause(every)
  }
}
async function fixtureTabs() {
  const state = (await call({ cmd: 'state' })).state
  for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === fixture) return (row.workspace?.tabs ?? []).map((tab) => tab.tabId)
  return []
}
async function assertOnlyFixture() {
  const mine = new Set(await fixtureTabs())
  const dom = await evaluate(`[...document.querySelectorAll('[data-main-tab]')].map((tab) => tab.dataset.mainTab)`)
  if (dom.length === 0 || !dom.every((id) => mine.has(id))) throw new Error('화면에 fixture 밖 탭이 있다 — 멈춘다')
}
async function addTab(selector) {
  const before = new Set(await fixtureTabs())
  await call({ cmd: 'click', selector })
  return until(async () => (await fixtureTabs()).find((id) => !before.has(id)) ?? null, '새 탭')
}

async function openFixture() {
  await call({ cmd: 'add-repo', root: fixture })
  await call({ cmd: 'rebuild-tree' })
  await until(async () => ((await call({ cmd: 'query', selector: `[data-worktree="${fixture}"]` })).found ?? []).length > 0, 'fixture 카드')
  let clicks = 0
  await until(async () => {
    const mine = new Set(await fixtureTabs())
    const dom = await evaluate(`[...document.querySelectorAll('[data-main-tab]')].map((tab) => tab.dataset.mainTab)`)
    if (mine.size > 0 && dom.length > 0 && dom.every((id) => mine.has(id))) return true
    if (clicks < 6) {
      clicks += 1
      await call({ cmd: 'click', selector: `[data-worktree="${fixture}"] [data-worktree-card-surface]` })
      await pause(1500)
    }
    return false
  }, 'fixture 화면', 40_000, 500)
  return clicks
}

async function main() {
  let group
  if (mode === 'plain') {
    result.cardClicks = await openFixture()
    while ((await fixtureTabs()).length < 4) await addTab('[data-main-tabbar-add]')
    group = await evaluate(`document.querySelector('[data-group-header]')?.dataset.groupHeader`)
  } else if (mode === 'built') {
    // native-k5 없이 넘침을 직접 만든다 — base 는 `data-main-tab-strip` 이 없어 native-k5 가 돌지 않는다(r6 base 회차).
    // 셸 탭 4개 → 첫 탭 우클릭 「오른쪽 영역」 → 그 영역에 `+` 20번. 세 빌드 모두 같은 걸음.
    result.cardClicks = await openFixture()
    while ((await fixtureTabs()).length < 4) await addTab('[data-main-tabbar-add]')
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
  } else {
    await assertOnlyFixture()
    group = await evaluate(`[...document.querySelectorAll('[data-main-tab-strip]')].map((s) => ({ g: s.dataset.mainTabStrip, over: s.scrollWidth - s.clientWidth })).sort((a, b) => b.over - a.over)[0]?.g`)
  }
  await assertOnlyFixture()
  await pause(1000)
  const stripRead = `(() => { const s = document.querySelector('[data-main-tab-strip="${group}"]'); return s ? s.scrollLeft : null })()`
  result.setup = await evaluate(`({ w: innerWidth, h: innerHeight, focus: document.hasFocus(), areas: document.querySelectorAll('[data-group-header]').length, group: '${group}', tabs: document.querySelectorAll('[data-group-header="${group}"] [data-main-tab]').length, compact: document.querySelectorAll('.main-tab.is-compact').length, strip: (() => { const s = document.querySelector('[data-main-tab-strip="${group}"]'); return s ? { sw: s.scrollWidth, cw: s.clientWidth } : null })() })`)
  save()
  // --trace: 페이지에 계측을 건다(읽기 전용 관측) — scrollIntoView 호출·focusin 대상과 그 순간의 호출 스택(focus() 는 focusin 을
  // 동기로 쏘므로 스택에 부른 쪽이 남는다)·스트립 scroll 이벤트. 회차마다 거둬 원자료에 넣는다.
  const trace = process.argv.includes('--trace')
  if (trace) await evaluate(`(() => {
    if (window.__l493) return
    window.__l493 = []
    const t0 = () => Math.round(performance.now())
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (...a) { window.__l493.push({ t: t0(), kind: 'scrollIntoView', el: this.dataset?.mainTab ?? this.className?.toString().slice(0, 30), stack: new Error().stack.split('\\n').slice(2, 6).join(' | ') }); return orig.apply(this, a) }
    document.addEventListener('focusin', (e) => window.__l493.push({ t: t0(), kind: 'focusin', el: e.target.tagName + '.' + (e.target.className ?? '').toString().slice(0, 30), stack: new Error().stack.split('\\n').slice(2, 9).join(' | ') }), true)
    const s = document.querySelector('[data-main-tab-strip="${group}"]')
    if (s) s.addEventListener('scroll', () => window.__l493.push({ t: t0(), kind: 'scroll', left: s.scrollLeft }))
  })()`)
  const groupTabs = async () => evaluate(`[...document.querySelectorAll('[data-group-header="${group}"] [data-main-tab]')].map((tab) => tab.dataset.mainTab)`)

  for (let run = 0; run < runs; run += 1) {
    await assertOnlyFixture()
    const tabs = await groupTabs()
    await evaluate(`(() => { const s = document.querySelector('[data-main-tab-strip="${group}"]'); if (s) for (let i = 0; i < 40; i += 1) s.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })) })()`)
    const firstClick = await call({ cmd: 'click', selector: `[data-main-tab="${tabs[0]}"]` })
    await pause(400)
    const target = tabs[1 + (run % 3)]
    const label = `l493-r${run}`
    const targetClick = await call({ cmd: 'click', selector: `[data-main-tab="${target}"]` })
    const scrollBefore = await evaluate(stripRead)
    await evaluate(`document.querySelector('[data-main-tab="${target}"]')?.scrollIntoView({inline:'nearest'})`)
    if (trace) await evaluate(`window.__l493.push({ t: Math.round(performance.now()), kind: 'mark-before-dblclick' })`)
    const dbl = await call({ cmd: 'dblclick', selector: `[data-main-tab="${target}"] .main-tab-label` })
    if (trace) await evaluate(`window.__l493.push({ t: Math.round(performance.now()), kind: 'mark-after-dblclick' })`)
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
    const events = trace ? await evaluate(`window.__l493.splice(0)`) : undefined
    const row = {
      run, target, events, dblAt: dbl.at ?? null,
      firstClick: { ok: firstClick.ok, hit: firstClick.hit ?? null, blockedBy: firstClick.blockedBy ?? null },
      targetClick: { ok: targetClick.ok, hit: targetClick.hit ?? null, blockedBy: targetClick.blockedBy ?? null },
      scrollBefore, dblclick: { ok: dbl.ok, hit: dbl.hit ?? null, blockedBy: dbl.blockedBy ?? null },
      samples, labelAfter: after, ok: after === label,
    }
    result.runs.push(row)
    console.log('[seq]', JSON.stringify(row).slice(0, 400))
    save()
    await evaluate(`document.querySelector('.main-tab-rename.is-editing')?.focus()`)
    await call({ cmd: 'key', keyCode: 'Escape' })
    await pause(300)
  }

  if (mode === 'plain') {
    // 뒤이은 native-k5 가 r4·r5 와 같은 모양을 만들도록 첫 탭만 남기고 닫는다(셸 탭 — 확인 모달 없음, 있으면 확인).
    for (const tabId of (await fixtureTabs()).slice(1)) {
      await call({ cmd: 'click', selector: `[data-main-tab-close="${tabId}"]` })
      await pause(400)
      if (await evaluate(`document.querySelector('[data-confirm-close-modal]') !== null`)) await call({ cmd: 'click', selector: '[data-close-confirm-ok]' })
      await until(async () => !(await fixtureTabs()).includes(tabId), `탭 닫기 ${tabId}`, 15_000)
    }
    result.leftTabs = await fixtureTabs()
  }
  result.endedAt = new Date().toISOString()
  save()
}

main().then(
  () => { console.log('[seq] done', JSON.stringify({ mode, ok: result.runs.filter((row) => row.ok).length, runs: result.runs.length })) },
  (error) => { result.error = String(error?.stack ?? error); save(); console.log('[seq] error', result.error.slice(0, 400)); process.exit(2) },
)
