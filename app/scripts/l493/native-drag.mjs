// LIFE-493 수정 r1 F3·F1 — 네이티브 드래그 분할·병합 스모크 + 비활성 탭 hover 닫기 노출.
// native-k5.mjs 다음에 **같은 네이티브 세션**(native-up.sh 가 띄운 사용자 userData + herdr default)에서 돈다 — native-k5 가 남긴
// fixture 워크스페이스(영역 2개, 둘째 영역 탭 넘침)를 그대로 쓴다. 입력은 전부 제어 소켓 `raw-mouse`(sendInputEvent)다.
// 원자료 경계는 native-k5 와 같다: fixture 워크스페이스의 영역·탭만 적고, 캡처는 탭바 선택자 캡처만.
//
// 사용: node native-drag.mjs <ROOT> <raw 폴더> <fixture 경로(realpath)> [hover 회수=5]
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [root, rawd, fixture, hoverArg] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l493n')) throw new Error('ROOT 는 /tmp/l493n*')
const ctl = path.join(root, 'ctl.sock')
const hoverRuns = Number(hoverArg ?? 5)
const shotsOut = path.join(rawd, 'shots')
fs.mkdirSync(shotsOut, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const control = (request) => rpc(ctl, request, 20_000)
const evaluate = async (code) => (await control({ cmd: 'eval', code })).result
const log = []
const record = (step, ok, detail) => {
  log.push({ step, ok, at: new Date().toISOString(), ...detail })
  console.log(`[drag] ${ok === null ? '…' : ok ? '✔' : '✘'} ${step}`, JSON.stringify(detail).slice(0, 300))
  fs.writeFileSync(path.join(rawd, 'drag-log.json'), `${JSON.stringify(log, null, 1)}\n`)
}
async function until(fn, label, timeout = 15_000, every = 200) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${label}`)
    await pause(every)
  }
}

async function fixtureTabIds() {
  const state = (await control({ cmd: 'state' })).state
  for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === fixture) return (row.workspace?.tabs ?? []).map((tab) => tab.tabId)
  return []
}

/** 영역 배치 덤프 — fixture 탭만. 영역마다 탭 순서·본문 사각형·스트립 스크롤. fixture 밖 탭이 보이면 멈춘다. */
async function layout() {
  const mine = await fixtureTabIds()
  const seen = await evaluate(`(() => {
    const mine = new Set(${JSON.stringify(mine)})
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
    return [...document.querySelectorAll('[data-tab-group]')].map((group) => {
      const strip = group.querySelector('[data-main-tab-strip]')
      const tabs = [...group.querySelectorAll('[data-main-tab]')]
      return {
        group: group.getAttribute('data-tab-group'),
        header: box(group.querySelector('[data-group-header]')),
        body: box(group.querySelector('[data-term-group], [data-empty-group]')),
        empty: group.querySelector('[data-empty-group]') !== null,
        stripBox: box(strip),
        strip: strip ? { scrollLeft: Math.round(strip.scrollLeft), scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth } : null,
        tabs: tabs.filter((tab) => mine.has(tab.dataset.mainTab)).map((tab) => ({ id: tab.dataset.mainTab, active: tab.dataset.active === 'true', box: box(tab) })),
        foreign: tabs.filter((tab) => !mine.has(tab.dataset.mainTab)).length,
      }
    })
  })()`)
  if (seen.some((group) => group.foreign > 0)) throw new Error('영역에 fixture 밖 탭이 있다 — 멈춘다')
  return seen
}
const dump = async (tag) => {
  const seen = await layout()
  fs.writeFileSync(path.join(rawd, `layout-${tag}.json`), `${JSON.stringify(seen, null, 1)}\n`)
  return seen
}
async function shot(tag) {
  const files = []
  for (const group of await layout()) {
    const res = await control({ cmd: 'shot', name: `l493-drag-${tag}-${group.group}`, selector: `[data-group-header="${group.group}"]` })
    if (!res.ok) continue
    const target = path.join(shotsOut, `${tag}-${group.group}.png`)
    fs.copyFileSync(res.file, target)
    files.push(path.relative(rawd, target))
  }
  return files
}

/** 실제 포인터 드래그: 누름 → 문턱(6px) 넘는 이동 → 목표까지 12걸음 → 뗌. */
async function drag(from, to) {
  await control({ cmd: 'raw-mouse', type: 'mouseMove', x: from.x, y: from.y })
  await control({ cmd: 'raw-mouse', type: 'mouseDown', x: from.x, y: from.y })
  await control({ cmd: 'raw-mouse', type: 'mouseMove', x: from.x + 10, y: from.y + 2 })
  for (let step = 1; step <= 12; step += 1) {
    await control({ cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(from.x + ((to.x - from.x) * step) / 12), y: Math.round(from.y + ((to.y - from.y) * step) / 12) })
    await pause(30)
  }
  await pause(150)
  await control({ cmd: 'raw-mouse', type: 'mouseUp', x: to.x, y: to.y })
  await pause(800)
}
const center = (box) => ({ x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) })
const groupOf = (seen, tabId) => seen.find((group) => group.tabs.some((tab) => tab.id === tabId))?.group ?? null

async function main() {
  const start = await dump('00-start')
  record('start', start.length >= 2, { groups: start.map((group) => ({ group: group.group, tabs: group.tabs.length, strip: group.strip })) })

  // F1 — 비활성 탭 hover 닫기 노출 (네이티브). 포인터를 비활성 탭 위로 → 닫기 계산 색 → 탭바 밖으로 → 다시 계산 색.
  for (let run = 0; run < hoverRuns; run += 1) {
    const seen = await layout()
    const group = seen[0]
    const inactive = group.tabs.filter((tab) => !tab.active && tab.box.w > 0)
    const tab = inactive[run % inactive.length]
    const away = { x: center(group.body).x, y: center(group.body).y }
    await control({ cmd: 'raw-mouse', type: 'mouseMove', ...away })
    await pause(150)
    const point = center(tab.box)
    await control({ cmd: 'raw-mouse', type: 'mouseMove', ...point })
    const read = `(() => { const tab = document.querySelector('[data-main-tab="${tab.id}"]'); return { hover: tab.matches(':hover'), close: getComputedStyle(tab.querySelector('[data-tab-close-button]')).color, focus: document.hasFocus(), visibility: document.visibilityState } })()`
    await pause(200)
    const on = await evaluate(read)
    await control({ cmd: 'raw-mouse', type: 'mouseMove', ...away })
    await pause(200)
    const off = await evaluate(read)
    record(`hover-${run}`, on.close !== 'rgba(0, 0, 0, 0)' && off.close === 'rgba(0, 0, 0, 0)', { tab: tab.id, on, off })
  }

  // ① 분할 — 넘친 둘째 영역을 **스크롤해 둔 채로**(세로 휠 → 가로) 보이는 탭 하나를 첫 영역 본문 오른쪽 가장자리(25% 띠 안)로 끈다.
  const before = await layout()
  const overflowed = before.find((group) => group.strip && group.strip.scrollWidth > group.strip.clientWidth)
  if (!overflowed) throw new Error('넘친 영역이 없다')
  const stripSel = `[data-main-tab-strip="${overflowed.group}"]`
  const scrolled = await evaluate(`(() => { const s = document.querySelector('${stripSel}'); s.scrollLeft = 0; for (let i = 0; i < 6; i += 1) s.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })); return s.scrollLeft })()`)
  const afterWheel = (await layout()).find((group) => group.group === overflowed.group)
  const stripBox = afterWheel.stripBox
  const visible = afterWheel.tabs.filter((tab) => tab.box.x >= stripBox.x && tab.box.x + tab.box.w <= stripBox.x + stripBox.w && !tab.active)
  const mover = visible[0]
  const targetA = before.find((group) => group.group !== overflowed.group)
  const splitTo = { x: Math.round(targetA.body.x + targetA.body.w - targetA.body.w * 0.1), y: center(targetA.body).y }
  const groupsBefore = before.length
  await drag(center(mover.box), splitTo)
  const afterSplit = await dump('01-split-from-scrolled-strip')
  const moverGroup = groupOf(afterSplit, mover.id)
  record('split-from-scrolled-strip', afterSplit.length === groupsBefore + 1 && moverGroup !== overflowed.group && moverGroup !== targetA.group && afterSplit.find((group) => group.group === moverGroup)?.tabs.length === 1, {
    scrollLeftBeforeDrag: scrolled, mover: mover.id, from: overflowed.group, to: moverGroup, groups: afterSplit.map((group) => ({ group: group.group, tabs: group.tabs.map((tab) => tab.id), body: group.body })), shots: await shot('01-split'),
  })

  // ② 병합 — 첫 영역의 탭 하나를 ①에서 생긴 영역 본문 가운데로 끈다.
  const sourceA = afterSplit.find((group) => group.group === targetA.group)
  const mergeTab = sourceA.tabs.find((tab) => !tab.active) ?? sourceA.tabs[0]
  const newArea = afterSplit.find((group) => group.group === moverGroup)
  await drag(center(mergeTab.box), center(newArea.body))
  const afterMerge = await dump('02-merge')
  const mergedInto = groupOf(afterMerge, mergeTab.id)
  record('merge-into-area', mergedInto === moverGroup && afterMerge.length === afterSplit.length && afterMerge.find((group) => group.group === moverGroup)?.tabs.length === 2, {
    tab: mergeTab.id, from: targetA.group, to: mergedInto, groups: afterMerge.map((group) => ({ group: group.group, tabs: group.tabs.map((tab) => tab.id) })), shots: await shot('02-merge'),
  })

  // ③ 분할(자기 영역) — 첫 영역의 탭을 그 영역 본문 아래 가장자리로 끈다(탭 2개 이상이라 유효).
  const own = afterMerge.find((group) => group.group === targetA.group)
  const ownTab = own.tabs.find((tab) => !tab.active) ?? own.tabs[0]
  await drag(center(ownTab.box), { x: center(own.body).x, y: Math.round(own.body.y + own.body.h - own.body.h * 0.08) })
  const afterOwn = await dump('03-split-own-down')
  const ownGroup = groupOf(afterOwn, ownTab.id)
  const ownBody = afterOwn.find((group) => group.group === ownGroup)?.body
  const origBody = afterOwn.find((group) => group.group === targetA.group)?.body
  record('split-own-area-down', afterOwn.length === afterMerge.length + 1 && ownGroup !== targetA.group && ownBody && origBody && ownBody.y > origBody.y, {
    tab: ownTab.id, to: ownGroup, groups: afterOwn.map((group) => ({ group: group.group, tabs: group.tabs.length, body: group.body })), shots: await shot('03-split-own'),
  })
}

main().then(
  () => {
    const failed = log.filter((entry) => entry.ok === false).map((entry) => entry.step)
    record('end', failed.length === 0, { failed })
    process.exit(failed.length === 0 ? 0 : 1)
  },
  (error) => {
    record('error', false, { message: String(error?.stack ?? error).slice(0, 500) })
    process.exit(2)
  },
)
