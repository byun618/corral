// LIFE-496 K2ⓑ T1·T2 회귀 스모크 (LIFE-494 native-t2.mjs 복사 — 접두·환경변수만 바꿈) — 사용자 userData + 구현 브랜치 빌드 + herdr 정식 `default` 세션(LIFE-456 S9 B안, native-up.sh).
// **provider 를 띄우지 않는다** — 넘침은 셸 탭으로 만든다. 입력은 제어 소켓 `click`·`dblclick`·`raw-mouse`·`key`·`type`
// (Chromium `sendInputEvent` — 히트테스트를 크로미움이 한다). 휠만은 제어 소켓에 없어 렌더러에 `WheelEvent`(세로 delta)를 보낸다
// (LIFE-493 native-k5 와 같은 방법 — 제품의 휠 처리기를 탄다. 실제 CDP 휠은 측정 도구 `scene.tabStripEnd` 가 탔다).
// 배경 열림(U1)은 herdr CLI `tab create`(--focus 없음)로 만든다 — corral 밖에서 생긴 탭이 그 경로다.
//
// **원자료 경계**: 캡처는 fixture 탭바 영역만(`[data-group-header=…]` 선택자 캡처), 덤프는 fixture 워크스페이스의 탭만. 다른 탭이 탭바에 보이면 멈춘다.
//
// 사용: node native-t2.mjs <ROOT=/tmp/l496n*> <raw 폴더> <fixture 경로(realpath)>
// 격리 예행(iso-t2.mjs)은 ROOT=/tmp/l496i* 에 환경변수 L496_CTL(제어 소켓)·L496_HERDR_SESSION·L496_HERDR_HOME 을 준다 — 관문 근거가 아니다.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { BoundaryError, focusProbe, guardedSender } from './drive-guard.mjs'

const [root, rawd, fixture] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l496n') && !root?.startsWith('/tmp/l496i')) throw new Error('ROOT 는 /tmp/l496n* (예행 /tmp/l496i*)')
const ctl = process.env.L496_CTL ?? path.join(root, 'ctl.sock')
const herdrSession = process.env.L496_HERDR_SESSION ?? 'default'
const herdrEnv = process.env.L496_HERDR_HOME
  ? { ...process.env, XDG_CONFIG_HOME: process.env.L496_HERDR_HOME, HERDR_CONFIG_PATH: path.join(process.env.L496_HERDR_HOME, 'config.toml') }
  : process.env
const HERDR = '/opt/homebrew/bin/herdr'
const shotsOut = path.join(rawd, 'shots')
fs.mkdirSync(shotsOut, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = []
const record = (step, ok, detail) => {
  log.push({ step, ok, at: new Date().toISOString(), ...detail })
  console.log(`[t2] ${ok === null ? '…' : ok ? '✔' : '✘'} ${step}`, JSON.stringify(detail).slice(0, 260))
  fs.writeFileSync(path.join(rawd, 't2-log.json'), `${JSON.stringify(log, null, 1)}\n`)
}
const control = (request, timeout = 20_000) => rpc(ctl, request, timeout)
const herdr = (...args) => execFileSync(HERDR, ['--session', herdrSession, ...args], { encoding: 'utf8', env: herdrEnv })
/** 렌더러에서 함수 하나를 돌린다 — 인자는 JSON 으로 넘긴다. */
const run = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` })).result
async function until(fn, label, timeout = 30_000, every = 200) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${label}`)
    await pause(every)
  }
}
const center = (box) => ({ x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) })
const mouse = (type, point, button) => control({ cmd: 'raw-mouse', type, x: point.x, y: point.y, ...(button ? { button } : {}) })

async function fixtureWorkspace() {
  const res = await control({ cmd: 'state' })
  for (const repo of res.state.repos) for (const row of repo.worktrees) if (row.path === fixture) return row.workspace ?? null
  return null
}
const fixtureTabIds = async () => ((await fixtureWorkspace())?.tabs ?? []).map((tab) => tab.tabId)

/** 페이지 안 — 영역마다 넘침 표면 전부(fixture 탭만). */
function readPage(mineList) {
  const mine = new Set(mineList)
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }
  }
  return [...document.querySelectorAll('[data-tab-group]')].map((group) => {
    const bar = group.querySelector('[data-main-tabbar]')
    const strip = bar?.querySelector('[data-main-tab-strip]') ?? null
    const sr = strip?.getBoundingClientRect() ?? null
    const chevron = (side) => {
      const el = bar?.querySelector(`[data-tab-strip-chevron="${side}"]`)
      return el ? { disabled: el.disabled, ariaDisabled: el.getAttribute('aria-disabled'), opacity: getComputedStyle(el).opacity, box: box(el) } : null
    }
    const track = bar?.querySelector('[data-tab-strip-scroll-indicator]') ?? null
    const thumb = track?.querySelector('[data-tab-strip-scroll-thumb]') ?? null
    const all = [...(bar?.querySelectorAll('[data-main-tab]') ?? [])]
    const tabs = all.filter((tab) => mine.has(tab.dataset.mainTab)).map((tab) => {
      const r = tab.getBoundingClientRect()
      return {
        id: tab.dataset.mainTab,
        active: tab.dataset.active === 'true',
        dock: tab.hasAttribute('data-active-tab-dock'),
        position: getComputedStyle(tab).position,
        seam: tab.hasAttribute('data-active-tab-dock') ? getComputedStyle(tab, '::before').content : null,
        label: tab.querySelector('.main-tab-label')?.textContent ?? null,
        x: Math.round(r.left * 10) / 10,
        w: Math.round(r.width * 10) / 10,
        inView: sr !== null && r.left >= sr.left - 0.5 && r.right <= sr.right + 0.5,
      }
    })
    return {
      group: group.getAttribute('data-tab-group'),
      header: box(bar),
      body: box(group.querySelector('[data-term-group], [data-empty-group]')),
      strip: strip && {
        box: box(strip),
        scrollLeft: Math.round(strip.scrollLeft * 10) / 10,
        max: strip.scrollWidth - strip.clientWidth,
        clientWidth: strip.clientWidth,
        docked: strip.getAttribute('data-active-tab-docked'),
        mask: [...strip.classList].filter((name) => name.startsWith('is-fade')).join(' '),
        maskImage: getComputedStyle(strip).maskImage || getComputedStyle(strip).webkitMaskImage,
      },
      chevrons: { start: chevron('start'), end: chevron('end') },
      track: track && { classes: track.className, opacity: getComputedStyle(track).opacity, height: getComputedStyle(track).height, background: getComputedStyle(track).backgroundColor, box: box(track) },
      thumb: thumb && { box: box(thumb), background: getComputedStyle(thumb).backgroundColor },
      dragging: document.body.classList.contains('is-tab-drag'),
      foreign: all.length - tabs.length,
      tabs,
    }
  })
}
async function read() {
  const seen = await run(readPage, await fixtureTabIds())
  if (seen.some((group) => group.foreign > 0)) throw new BoundaryError('탭바에 fixture 밖 탭이 있다 — 멈춘다')
  return seen
}
/** fix2 R2-03 — 전역 입력(key·type)은 보내기 직전에 확인한다: 화면이 fixture 탭만 · 포커스가 영역 안. */
const sendGuarded = guardedSender({
  check: async () => {
    await read()
    const focus = await run(focusProbe)
    return focus.inArea ? { ok: true } : { ok: false, reason: `포커스가 fixture 영역 밖 ${focus.tag}.${focus.className}` }
  },
  send: (request) => control(request),
})
/** 기다림 실패를 false 로 — 경계 위반은 삼키지 않는다. */
const falseUnlessBoundary = (error) => {
  if (error instanceof BoundaryError) throw error
  return false
}
async function dump(tag) {
  const seen = await read()
  fs.writeFileSync(path.join(rawd, `state-${tag}.json`), `${JSON.stringify(seen, null, 1)}\n`)
  return seen
}
async function shot(tag) {
  const files = []
  for (const group of await read()) {
    const res = await control({ cmd: 'shot', name: `l496-${tag}-${group.group}`, selector: `[data-group-header="${group.group}"]` })
    if (!res.ok) throw new Error(`shot 실패 ${JSON.stringify(res).slice(0, 200)}`)
    const target = path.join(shotsOut, `${tag}-${group.group}.png`)
    fs.copyFileSync(res.file, target)
    files.push(path.relative(rawd, target))
  }
  return files
}
/**
 * 누를 수 있는 비활성 탭 — 가운데가 스트립 안이고, 붙은(dock) 활성 탭에 가려지지 않은 것. 붙은 탭은 이웃 탭 위에 그려지므로
 * 그 자리를 누르면 붙은 탭을 잡는다(격리 예행 k4-iso/3: 분할 스모크가 가려진 t8 대신 붙은 t1 을 끌었다).
 */
const freeTabs = (group) => {
  const active = activeOf(group)
  const covered = (tab) => active !== null && tab.x + tab.w / 2 >= active.x && tab.x + tab.w / 2 <= active.x + active.w
  const box = group.strip.box
  return group.tabs.filter((tab) => !tab.active && tab.x + tab.w / 2 > box.x + 4 && tab.x + tab.w / 2 < box.x + box.w - 4 && !covered(tab))
}
const groupById = (seen, id) => seen.find((group) => group.group === id)
const activeOf = (group) => group.tabs.find((tab) => tab.active) ?? null
const atEnd = (group) => group.strip.max - group.strip.scrollLeft <= 2
/** 지금 스크롤·dock 으로 기대하는 마스크 클래스 — 제품 `tabStripMaskClassName` 과 독립으로 다시 계산한다. */
const expectedMask = (group) => {
  if (group.strip.max <= 1) return ''
  const classes = []
  if (group.strip.scrollLeft > 1 && group.strip.docked !== 'start') classes.push('is-fade-start')
  if (group.strip.scrollLeft < group.strip.max - 1 && group.strip.docked !== 'end') classes.push('is-fade-end')
  return classes.join(' ')
}
const chevronSel = (group, side) => `[data-group-chevron="${group}"][data-tab-strip-chevron="${side}"]`
async function wheel({ group, deltaY, times }) {
  return run(({ group, deltaY, times }) => {
    const strip = document.querySelector(`[data-main-tab-strip="${group}"]`)
    const before = strip.scrollLeft
    for (let i = 0; i < times; i += 1) strip.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))
    return { before, after: strip.scrollLeft }
  }, { group, deltaY, times })
}
async function plus(group) {
  const before = new Set(await fixtureTabIds())
  const res = await control({ cmd: 'click', selector: `[data-main-tabbar-add="${group}"]` })
  if (!res.ok) throw new Error(`+ 클릭 실패 ${JSON.stringify(res).slice(0, 200)}`)
  // LIFE-496: `+` 는 메뉴를 연다 — 「새 터미널」 항목으로 만든다.
  await until(async () => ((await control({ cmd: 'query', selector: '[data-tab-create-item="new-terminal"]' })).found ?? []).length > 0, '+ 메뉴', 5_000)
  const item = await control({ cmd: 'click', selector: '[data-tab-create-item="new-terminal"]' })
  if (!item.ok) throw new Error(`새 터미널 클릭 실패 ${JSON.stringify(item).slice(0, 200)}`)
  return until(async () => (await fixtureTabIds()).find((id) => !before.has(id)) ?? null, '새 탭', 20_000)
}
const AWAY = async () => {
  const seen = await read()
  return center(seen[0].body)
}
/** 스트립 scrollLeft 를 시간 순으로 — 자동 스크롤·멈춤을 본다. */
async function sample({ group, ms, every = 90 }) {
  const out = []
  const start = Date.now()
  while (Date.now() - start < ms) {
    out.push({ t: Date.now() - start, scrollLeft: await run((g) => Math.round(document.querySelector(`[data-main-tab-strip="${g}"]`).scrollLeft), group) })
    await pause(every)
  }
  return out
}

async function main() {
  // ① fixture 레포를 더하고 카드를 눌러 연다 (493 native-k5 와 같은 길).
  await control({ cmd: 'add-repo', root: fixture })
  await control({ cmd: 'rebuild-tree' })
  await until(async () => ((await control({ cmd: 'query', selector: `[data-worktree="${fixture}"]` })).found ?? []).length > 0, 'fixture 카드', 30_000)
  const ws = await until(async () => {
    await control({ cmd: 'click', selector: `[data-worktree="${fixture}"] [data-worktree-card-surface]` })
    await pause(1500)
    const row = await fixtureWorkspace()
    if (!row || row.tabs.length === 0) return null
    const dom = await run(() => [...document.querySelectorAll('[data-main-tab]')].map((tab) => tab.dataset.mainTab))
    return dom.length > 0 && dom.every((id) => row.tabs.some((tab) => tab.tabId === id)) ? row : null
  }, 'fixture 화면', 30_000, 500)
  const g1 = (await read())[0].group
  let seen = await dump('01-one-tab')
  record('one-tab-no-chevron', seen.length === 1 && seen[0].chevrons.start === null && seen[0].chevrons.end === null && seen[0].track === null, { workspace: ws.workspaceId, shots: await shot('01-one-tab') })

  // ② `+` 로 넘칠 때까지 + 4개. 매번: 새 탭 = 활성·마지막·다 보임·끝. 넘치기 전엔 chevron 없음, 넘친 뒤엔 있음.
  const created = []
  let firstOverflow = null
  for (let index = 0; index < 48; index += 1) {
    const id = await plus(g1)
    created.push(id)
    await until(async () => activeOf(groupById(await read(), g1))?.id === id, '새 탭 활성', 10_000)
    await pause(250)
    const group = groupById(await read(), g1)
    const last = group.tabs.at(-1)
    const overflow = group.strip.max > 1
    if (overflow && firstOverflow === null) firstOverflow = index
    const addOk = last.id === id && last.active && last.inView && (!overflow || atEnd(group)) && (overflow ? group.chevrons.start !== null : group.chevrons.start === null)
    // LIFE-496 fix4 R4-02 — 실패한 회차만 500·1000ms 에 다시 읽는다(판정은 250ms 값 그대로). 「스크롤이 늦게 끝남」과 「멈춤」을 가른다.
    // 통과 회차의 타이밍은 바꾸지 않으려고 실패 때만 기다린다.
    const series = [{ ms: 250, scrollLeft: group.strip.scrollLeft, max: group.strip.max }]
    if (!addOk) {
      for (const ms of [500, 1000]) {
        await pause(ms - series.at(-1).ms)
        const later = groupById(await read(), g1)
        series.push({ ms, scrollLeft: later.strip.scrollLeft, max: later.strip.max, lastInView: later.tabs.at(-1)?.inView ?? null })
      }
    }
    record(`add-${index}`, addOk, {
      tab: id, overflow, scrollLeft: group.strip.scrollLeft, max: group.strip.max, lastInView: last.inView, chevrons: Boolean(group.chevrons.start), docked: group.strip.docked, series,
    })
    // 드래그 자동 스크롤이 스텝 여러 번을 보이도록 넘침 폭 ≥ 스텝 2.2배(최소 4탭 더)까지 만든다.
    if (firstOverflow !== null && index >= firstOverflow + 4 && group.strip.max >= 2.2 * Math.max(120, group.strip.clientWidth * 0.75)) break
  }
  // 그린 뒤 스트립 폭이 줄어드는 경우(493 k5/r3 — 39px 잘림): 800ms 뒤 다시 본다.
  await pause(800)
  seen = await dump('02-overflow-end')
  let group = groupById(seen, g1)
  record('overflow-end-last-active-settled', activeOf(group)?.id === created.at(-1) && group.tabs.at(-1).inView && atEnd(group), { strip: group.strip, last: group.tabs.at(-1) })
  record('chevrons-at-end', group.chevrons.end?.disabled === true && group.chevrons.start?.disabled === false && Number(group.chevrons.end.opacity) < 0.5, { chevrons: group.chevrons })
  record('mask-start-only', group.strip.mask === 'is-fade-start' && group.strip.docked === null, { mask: group.strip.mask, maskImage: group.strip.maskImage, docked: group.strip.docked })
  const disabledClick = await control({ cmd: 'click', selector: chevronSel(g1, 'end') })
  record('disabled-chevron-not-clickable', disabledClick.ok === false, { reply: { ok: disabledClick.ok, hit: disabledClick.hit, blockedBy: disabledClick.blockedBy ?? null } })
  const shots02 = await shot('02-overflow-end')

  // ③ ‹ 클릭 = 폭 75% 스텝(최소 120) → 활성(마지막) 탭이 시야 밖 → 오른쪽에 붙는다(dock end, 이음매) · 그쪽 페이드 꺼짐.
  const beforeStep = group.strip.scrollLeft
  await control({ cmd: 'click', selector: chevronSel(g1, 'start') })
  await pause(700)
  seen = await dump('03-dock-end')
  group = groupById(seen, g1)
  const step = Math.max(120, group.strip.clientWidth * 0.75)
  const docked = activeOf(group)
  const stripRight = group.strip.box.x + group.strip.box.w
  record('chevron-step', Math.abs(beforeStep - group.strip.scrollLeft - Math.min(step, beforeStep)) <= 2, { before: beforeStep, after: group.strip.scrollLeft, expectedStep: step })
  record('dock-end', group.strip.docked === 'end' && docked?.dock === true && docked.position === 'sticky' && Math.abs(docked.x + docked.w - stripRight) <= 1.5 && docked.seam === '""', {
    docked: group.strip.docked, active: docked, stripRight, mask: group.strip.mask, shots: await shot('03-dock-end'),
  })
  // 붙은 쪽(end) 페이드는 꺼진다 — 기대 마스크는 스크롤·dock 에서 다시 계산한다(스텝이 맨 앞까지 닿으면 '').
  record('mask-dock-side-suppressed', group.strip.mask === expectedMask(group) && !group.strip.mask.includes('is-fade-end'), { mask: group.strip.mask, expected: expectedMask(group), scrollLeft: group.strip.scrollLeft })

  // ④ 스트립 가운데로 휠 → 보이는 가운데 탭을 활성(제자리라 dock 없음) → 양쪽 페이드 · chevron 둘 다 활성.
  const toMiddle = Math.round(group.strip.max / 2 - group.strip.scrollLeft)
  if (toMiddle !== 0) await wheel({ group: g1, deltaY: toMiddle, times: 1 })
  await pause(300)
  group = groupById(await read(), g1)
  const visible = freeTabs(group).filter((tab) => tab.inView)
  const middle = visible[Math.floor(visible.length / 2)]
  await control({ cmd: 'click', selector: `[data-main-tab="${middle.id}"]` })
  await pause(500)
  seen = await dump('04-mask-both')
  group = groupById(seen, g1)
  record('mask-both', group.strip.mask === 'is-fade-start is-fade-end' && group.strip.docked === null && activeOf(group)?.id === middle.id && group.chevrons.start.disabled === false && group.chevrons.end.disabled === false, {
    mask: group.strip.mask, maskImage: group.strip.maskImage, strip: group.strip, active: activeOf(group), shots: await shot('04-mask-both'),
  })

  // ⑤ ‹ 를 끝까지 → ‹ 비활성. 첫 탭 활성 → 뒤 페이드만.
  for (let i = 0; i < 20; i += 1) {
    const now = groupById(await read(), g1)
    if (now.chevrons.start.disabled) break
    await control({ cmd: 'click', selector: chevronSel(g1, 'start') })
    await pause(600)
  }
  const firstTab = groupById(await read(), g1).tabs[0].id
  await control({ cmd: 'click', selector: `[data-main-tab="${firstTab}"]` })
  await pause(500)
  seen = await dump('05-mask-end-only')
  group = groupById(seen, g1)
  record('chevrons-at-start', group.strip.scrollLeft === 0 && group.chevrons.start.disabled === true && group.chevrons.end.disabled === false, { chevrons: group.chevrons, scrollLeft: group.strip.scrollLeft })
  record('mask-end-only', group.strip.mask === 'is-fade-end' && group.strip.docked === null, { mask: group.strip.mask, maskImage: group.strip.maskImage, shots: await shot('05-mask-end-only') })

  // ⑥ 첫 탭 활성인 채 휠로 끝까지 → 첫 탭이 왼쪽에 붙는다(dock start) · 앞 페이드 꺼짐.
  const wheelEnd = await wheel({ group: g1, deltaY: 120, times: 40 })
  await pause(400)
  seen = await dump('06-dock-start')
  group = groupById(seen, g1)
  const dockedStart = activeOf(group)
  record('wheel-vertical-to-horizontal', wheelEnd.after > wheelEnd.before, { ...wheelEnd, method: 'WheelEvent dispatch (deltaY only)' })
  record('dock-start', group.strip.docked === 'start' && dockedStart?.id === firstTab && Math.abs(dockedStart.x - group.strip.box.x) <= 1.5 && group.strip.mask === '' && atEnd(group), {
    docked: group.strip.docked, active: dockedStart, stripX: group.strip.box.x, mask: group.strip.mask, shots: await shot('06-dock-start'),
  })

  // ⑦ 썸 — 평소 안 보임 → 스트립 hover 때 보임 → 트랙 hover 때 4px·트랙 칠 → 썸 드래그 → 트랙 클릭 점프 → 떠나면 숨음.
  const away = await AWAY()
  await mouse('mouseMove', away)
  await pause(1100)
  const idle = groupById(await read(), g1)
  await mouse('mouseMove', center(idle.strip.box))
  await pause(350)
  const onStrip = groupById(await read(), g1)
  const trackPoint = { x: Math.round(onStrip.track.box.x + onStrip.track.box.w * 0.15), y: Math.round(onStrip.track.box.y + onStrip.track.box.h / 2) }
  await mouse('mouseMove', trackPoint)
  await pause(350)
  const onTrack = groupById(await read(), g1)
  const hoverShots = await shot('07-thumb-hover')
  record('thumb-visibility', Number(idle.track.opacity) === 0 && Number(onStrip.track.opacity) === 1 && onStrip.track.height === '3px' && onTrack.track.height === '4px' && onTrack.track.classes.includes('is-expanded'), {
    idle: idle.track, onStrip: onStrip.track, onTrack: { track: onTrack.track, thumb: onTrack.thumb }, shots: hoverShots,
  })
  const thumbStart = center(onTrack.thumb.box)
  const scrollBeforeThumb = onTrack.strip.scrollLeft
  await mouse('mouseMove', thumbStart)
  await mouse('mouseDown', thumbStart)
  for (let i = 1; i <= 8; i += 1) {
    await mouse('mouseMove', { x: thumbStart.x - i * 15, y: thumbStart.y })
    await pause(30)
  }
  const midDrag = groupById(await read(), g1)
  await mouse('mouseUp', { x: thumbStart.x - 120, y: thumbStart.y })
  await pause(300)
  const afterThumb = groupById(await read(), g1)
  record('thumb-drag', afterThumb.strip.scrollLeft < scrollBeforeThumb - 50 && midDrag.thumb.background !== onTrack.thumb.background, {
    before: scrollBeforeThumb, after: afterThumb.strip.scrollLeft, thumbColorHover: onTrack.thumb.background, thumbColorDragging: midDrag.thumb.background,
  })
  // 트랙 맨 오른쪽 끝을 누르면 끝으로(부드럽게) 점프한다 — 썸이 아닌 트랙 자리.
  const trackNow = groupById(await read(), g1)
  const jumpPoint = { x: Math.round(trackNow.track.box.x + trackNow.track.box.w - 3), y: Math.round(trackNow.track.box.y + trackNow.track.box.h / 2) }
  const onThumbAlready = jumpPoint.x >= trackNow.thumb.box.x && jumpPoint.x <= trackNow.thumb.box.x + trackNow.thumb.box.w
  await mouse('mouseMove', jumpPoint)
  await pause(200)
  await mouse('mouseDown', jumpPoint)
  await mouse('mouseUp', jumpPoint)
  await pause(900)
  const afterJump = groupById(await read(), g1)
  record('track-click-jump', !onThumbAlready && atEnd(afterJump), { before: trackNow.strip.scrollLeft, after: afterJump.strip.scrollLeft, max: afterJump.strip.max, point: jumpPoint })
  await mouse('mouseMove', away)
  await pause(1100)
  const left = groupById(await read(), g1)
  record('thumb-hides-after-leave', Number(left.track.opacity) === 0, { track: left.track })

  // ⑧ 끝에 붙은 채로 스트립 폭이 줄어든다(pane 분할 → 꼬리에 ⤢·✕ 가 생김) → 끝에 그대로. 가운데서 폭이 늘어난다(pane 닫기) → 위치 그대로(활성 탭으로 안 튄다).
  await wheel({ group: g1, deltaY: 120, times: 40 })
  await pause(300)
  const preSplit = groupById(await read(), g1)
  await control({ cmd: 'click', selector: `[data-group-split-right="${g1}"]` })
  await until(async () => (await control({ cmd: 'query', selector: `[data-group-close-pane="${g1}"]` })).found?.length > 0, 'pane 2개', 15_000)
  await pause(600)
  const postSplit = groupById(await dump('08a-split-narrower'), g1)
  record('stick-to-end-on-narrower', postSplit.strip.clientWidth < preSplit.strip.clientWidth && atEnd(postSplit), { before: preSplit.strip, after: postSplit.strip })
  await wheel({ group: g1, deltaY: -120, times: 3 })
  await pause(300)
  const browsing = groupById(await read(), g1)
  await control({ cmd: 'click', selector: `[data-group-close-pane="${g1}"]` })
  await until(async () => ((await control({ cmd: 'query', selector: `[data-group-close-pane="${g1}"]` })).found ?? []).length === 0, 'pane 1개', 15_000)
  await pause(600)
  const wider = groupById(await dump('08b-close-pane-wider'), g1)
  record('no-snap-on-wider-while-browsing', wider.strip.clientWidth > browsing.strip.clientWidth && !atEnd(browsing) && Math.abs(wider.strip.scrollLeft - browsing.strip.scrollLeft) <= 1 && activeOf(wider)?.id === activeOf(browsing)?.id, {
    before: browsing.strip, after: wider.strip, active: activeOf(wider)?.id, activeDock: activeOf(wider)?.dock,
  })

  // ⑨ 배경 열림(U1) — herdr CLI 로 --focus 없이 탭을 만든다. 포인터가 스트립 밖이면 화면 밖에 열린 새 탭을 보이게 스크롤,
  // 스트립 위면 나갈 때까지 미룬다. 활성 탭은 그대로(시야 밖이면 붙는다).
  await wheel({ group: g1, deltaY: -120, times: 40 })
  await mouse('mouseMove', away)
  await pause(400)
  const bgBefore = groupById(await read(), g1)
  const known = new Set(await fixtureTabIds())
  herdr('tab', 'create', '--workspace', ws.workspaceId, '--cwd', fixture)
  const bg1 = await until(async () => (await fixtureTabIds()).find((id) => !known.has(id)) ?? null, '배경 탭', 20_000)
  await until(async () => groupById(await read(), g1).tabs.some((tab) => tab.id === bg1), '배경 탭 그려짐', 10_000)
  await pause(600)
  const bgAfter = groupById(await dump('09a-background-open'), g1)
  const bgTab = bgAfter.tabs.find((tab) => tab.id === bg1)
  record('background-open-reveal', activeOf(bgAfter)?.id === activeOf(bgBefore)?.id && bgTab?.inView === true && bgAfter.strip.scrollLeft > bgBefore.strip.scrollLeft, {
    before: bgBefore.strip, after: bgAfter.strip, bgTab, active: activeOf(bgAfter), shots: await shot('09a-background-open'),
  })
  await wheel({ group: g1, deltaY: -120, times: 40 })
  await pause(300)
  const hoverPoint = center(groupById(await read(), g1).strip.box)
  await mouse('mouseMove', hoverPoint)
  await pause(300)
  const hoverBefore = groupById(await read(), g1)
  const known2 = new Set(await fixtureTabIds())
  herdr('tab', 'create', '--workspace', ws.workspaceId, '--cwd', fixture)
  const bg2 = await until(async () => (await fixtureTabIds()).find((id) => !known2.has(id)) ?? null, '배경 탭 2', 20_000)
  await until(async () => groupById(await read(), g1).tabs.some((tab) => tab.id === bg2), '배경 탭 2 그려짐', 10_000)
  await pause(600)
  const hoverHeld = groupById(await read(), g1)
  await mouse('mouseMove', away)
  await pause(600)
  const hoverLeft = groupById(await dump('09b-background-open-deferred'), g1)
  record('background-open-deferred-while-hovered', Math.abs(hoverHeld.strip.scrollLeft - hoverBefore.strip.scrollLeft) <= 1 && hoverLeft.tabs.find((tab) => tab.id === bg2)?.inView === true, {
    before: hoverBefore.strip.scrollLeft, whileHovered: hoverHeld.strip.scrollLeft, afterLeave: hoverLeft.strip.scrollLeft, bg2: hoverLeft.tabs.find((tab) => tab.id === bg2),
  })

  // ⑩ 드래그 중 chevron hover 자동 스크롤(180ms) — 맨 앞에서 보이는 비활성 탭을 끌어 › 위에 머문다 → 스텝으로 밀린다.
  // 끝에선 › 가 비활성이 아니다(드래그 중 예외). › 를 떠나면 멈춘다. 스크롤된 스트립 안에 놓아 재정렬(K2ⓑ).
  await wheel({ group: g1, deltaY: -120, times: 40 })
  await pause(300)
  const dragStart = groupById(await read(), g1)
  const mover = freeTabs(dragStart)[1]
  const from = { x: Math.round(mover.x + mover.w / 2), y: Math.round(dragStart.strip.box.y + dragStart.strip.box.h / 2) }
  const under = await run((p) => document.elementFromPoint(p.x, p.y)?.closest('[data-main-tab]')?.dataset.mainTab ?? null, from)
  if (under !== mover.id) throw new Error(`누를 점의 탭이 ${under} — ${mover.id} 가 아니다`)
  const orderBefore = dragStart.tabs.map((tab) => tab.id)
  await mouse('mouseMove', from)
  await mouse('mouseDown', from)
  await mouse('mouseMove', { x: from.x + 10, y: from.y + 2 })
  const chevronEnd = center(dragStart.chevrons.end.box)
  for (let i = 1; i <= 8; i += 1) {
    await mouse('mouseMove', { x: Math.round(from.x + ((chevronEnd.x - from.x) * i) / 8), y: Math.round(from.y + ((chevronEnd.y - from.y) * i) / 8) })
    await pause(25)
  }
  const duringDrag = groupById(await read(), g1)
  const autoEnd = [{ t: -1, scrollLeft: dragStart.strip.scrollLeft }, ...(await sample({ group: g1, ms: 1300, every: 40 }))]
  const atChevronEnd = groupById(await dump('10a-drag-chevron-end'), g1)
  const dragShots = await shot('10a-drag-chevron-end')
  // › 를 떠나 스트립 가운데로 — 멈춘다.
  const stripMid = center(atChevronEnd.strip.box)
  await mouse('mouseMove', stripMid)
  const afterLeave = await sample({ group: g1, ms: 600 })
  // ‹ 위로 잠깐(첫 스텝 즉시 + 180ms 한 번 남짓) — 반대로 밀린다. 맨 앞까지 가기 전에 떠나 스크롤된 채로 놓는다.
  const chevronStart = center(atChevronEnd.chevrons.start.box)
  await mouse('mouseMove', chevronStart)
  const autoStart = await sample({ group: g1, ms: 260, every: 40 })
  await mouse('mouseMove', stripMid)
  await pause(200)
  const dropAt = groupById(await read(), g1)
  await mouse('mouseUp', stripMid)
  await pause(800)
  const afterDrop = groupById(await dump('10b-drop-in-scrolled-strip'), g1)
  const orderAfter = afterDrop.tabs.map((tab) => tab.id)
  // 늘어난 시점들 — 첫 스텝은 hover 즉시, 그 뒤는 180ms 간격(샘플 40ms 라 ±40ms), 끝에 닿으면 멈춘다.
  const rises = autoEnd.filter((entry, index) => index > 0 && entry.scrollLeft > autoEnd[index - 1].scrollLeft).map((entry) => entry.t)
  const gaps = rises.slice(1).map((t, index) => t - rises[index])
  record('drag-chevron-autoscroll', duringDrag.dragging && duringDrag.strip.docked === null && !duringDrag.tabs.some((tab) => tab.dock) && duringDrag.track.classes.includes('is-disabled') && rises.length >= 3 && gaps.every((gap) => gap >= 130 && gap <= 260) && atEnd(atChevronEnd), {
    dragging: duringDrag.dragging, dockDuringDrag: duringDrag.tabs.filter((tab) => tab.dock).map((tab) => tab.id), track: duringDrag.track.classes, rises, gaps, autoEnd, shots: dragShots,
  })
  record('drag-chevron-enabled-at-end', atChevronEnd.chevrons.end.disabled === false && atChevronEnd.chevrons.end.ariaDisabled === 'true' && atEnd(atChevronEnd), { chevron: atChevronEnd.chevrons.end, strip: atChevronEnd.strip })
  record('drag-autoscroll-stops-on-leave', afterLeave.every((entry) => entry.scrollLeft === afterLeave[0].scrollLeft), { afterLeave })
  record('drag-chevron-start-autoscroll', autoStart.at(-1).scrollLeft < autoStart[0].scrollLeft, { autoStart })
  record('drag-reorder-in-scrolled-strip', dropAt.strip.scrollLeft > 0 && orderAfter.join() !== orderBefore.join() && orderAfter.includes(mover.id) && !afterDrop.dragging, {
    scrollLeftAtDrop: dropAt.strip.scrollLeft, mover: mover.id, indexBefore: orderBefore.indexOf(mover.id), indexAfter: orderAfter.indexOf(mover.id),
  })
  const postDrop = await sample({ group: g1, ms: 500 })
  record('drag-end-stops-autoscroll', postDrop.every((entry) => entry.scrollLeft === postDrop[0].scrollLeft) && afterDrop.tabs.some((tab) => tab.dock), { postDrop })

  // ⑩b (r1 R1-01) dock 된 활성 탭을 끌어 문턱(6px)을 넘는 첫 mousemove 직후 그대로 놓는다 — 드롭 인덱스가 dock 끈(제자리) 계산과 같아야 한다.
  // 첫 탭 활성 → 휠로 끝까지 → 첫 탭이 앞 가장자리에 붙는다. 붙은 탭 가운데를 눌러 7px 왼쪽으로 한 번 움직이고 놓는다.
  // 기대는 두 가지로 미리 계산해 서로 달라야 판별력이 있다: dock 켠 사각형(누르기 전 화면) / dock 끈 사각형(문턱 직후 화면 — 드래그 중엔 제자리).
  const tabbarIndex = (centers, x) => { const at = centers.findIndex((c) => x < c); return at === -1 ? centers.length : at }
  const predictOrder = (order, tabId, index) => { const without = order.filter((id) => id !== tabId); const at = Math.max(0, Math.min(index, without.length)); return [...without.slice(0, at), tabId, ...without.slice(at)] }
  await wheel({ group: g1, deltaY: -120, times: 40 })
  await pause(300)
  const headTab = groupById(await read(), g1).tabs[0].id
  await control({ cmd: 'click', selector: `[data-main-tab="${headTab}"]` })
  await pause(400)
  await wheel({ group: g1, deltaY: 120, times: 40 })
  await mouse('mouseMove', await AWAY())
  await pause(500)
  const dockPre = groupById(await dump('10c-dock-before-drag'), g1)
  const dockTab = activeOf(dockPre)
  const press = { x: Math.round(dockTab.x + dockTab.w / 2), y: Math.round(dockPre.strip.box.y + dockPre.strip.box.h / 2) }
  const underDock = await run((p) => document.elementFromPoint(p.x, p.y)?.closest('[data-main-tab]')?.dataset.mainTab ?? null, press)
  const release = { x: press.x - 7, y: press.y }
  await mouse('mouseMove', press)
  await mouse('mouseDown', press)
  await mouse('mouseMove', release)
  // raw-mouse 는 렌더러 입력 큐에 넣고 돌아온다 — 문턱 이동이 처리돼 드래그가 선(=dock 이 풀린) 화면을 기다린다(k4/r3: 처리 전에 읽어 sticky 를 봤다).
  const dockMid = await until(async () => { const now = groupById(await read(), g1); return now.dragging && !now.tabs.some((tab) => tab.dock) ? now : null }, '문턱 뒤 드래그 화면', 3_000, 50)
    .catch(async (error) => {
      if (error instanceof BoundaryError) throw error
      return groupById(await read(), g1)
    })
  await mouse('mouseUp', release)
  await pause(800)
  const dockDrop = groupById(await dump('10d-dock-threshold-release'), g1)
  const dockOrderBefore = dockPre.tabs.map((tab) => tab.id)
  const dockOnIndex = tabbarIndex(dockPre.tabs.map((tab) => tab.x + tab.w / 2), release.x)
  const dockOffIndex = tabbarIndex(dockMid.tabs.map((tab) => tab.x + tab.w / 2), release.x)
  // 교차 확인 — 누르기 전 화면에서 붙은 탭만 제자리(앞 탭 오른쪽 끝, 첫 탭이면 스트립 x − scrollLeft)로 옮겨 다시 셈한다.
  const dockAt = dockPre.tabs.indexOf(dockTab)
  const dockNaturalX = dockAt === 0 ? dockPre.strip.box.x - dockPre.strip.scrollLeft : dockPre.tabs[dockAt - 1].x + dockPre.tabs[dockAt - 1].w
  const dockOffIndexPre = tabbarIndex(dockPre.tabs.map((tab) => (tab === dockTab ? dockNaturalX : tab.x) + tab.w / 2), release.x)
  const expectOff = predictOrder(dockOrderBefore, dockTab.id, dockOffIndex)
  const expectOn = predictOrder(dockOrderBefore, dockTab.id, dockOnIndex)
  record('drag-dock-threshold-release', dockPre.strip.docked === 'start' && dockTab.dock && underDock === dockTab.id && dockMid.dragging && !dockMid.tabs.some((tab) => tab.dock) && dockOffIndex === dockOffIndexPre && expectOff.join() !== expectOn.join() && dockDrop.tabs.map((tab) => tab.id).join() === expectOff.join() && !dockDrop.dragging, {
    docked: dockPre.strip.docked, tab: dockTab.id, underDock, press, release, dockOnIndex, dockOffIndex, dockOffIndexPre, midDragging: dockMid.dragging, indexAfter: dockDrop.tabs.findIndex((tab) => tab.id === dockTab.id),
    dockMidPosition: dockMid.tabs.find((tab) => tab.id === dockTab.id)?.position, discriminates: expectOff.join() !== expectOn.join(),
  })

  // ⑩c (r1 R1-02) 드래그 중 › 위에서 멈춘 채 자동 스크롤을 기다렸다가 그대로 놓는다 — 드롭 인덱스가 스크롤 **뒤** 위치여야 한다.
  // 기대: 놓기 직전 화면(드래그 중 = dock 없음)의 탭 중점으로 계산 / 대조: › 에 닿은 직후 화면으로 계산(스크롤 전) — 둘이 달라야 판별력이 있다.
  await wheel({ group: g1, deltaY: -120, times: 40 })
  await mouse('mouseMove', await AWAY())
  await pause(500)
  const holdStart = groupById(await read(), g1)
  const holder = freeTabs(holdStart)[1]
  const hFrom = { x: Math.round(holder.x + holder.w / 2), y: Math.round(holdStart.strip.box.y + holdStart.strip.box.h / 2) }
  const underHold = await run((p) => document.elementFromPoint(p.x, p.y)?.closest('[data-main-tab]')?.dataset.mainTab ?? null, hFrom)
  const hTo = center(holdStart.chevrons.end.box)
  await mouse('mouseMove', hFrom)
  await mouse('mouseDown', hFrom)
  await mouse('mouseMove', { x: hFrom.x + 10, y: hFrom.y + 2 })
  for (let i = 1; i <= 8; i += 1) {
    await mouse('mouseMove', { x: Math.round(hFrom.x + ((hTo.x - hFrom.x) * i) / 8), y: Math.round(hFrom.y + ((hTo.y - hFrom.y) * i) / 8) })
    await pause(25)
  }
  const holdArrive = groupById(await read(), g1)
  await pause(450)
  const holdRelease = groupById(await dump('10e-chevron-hold-before-release'), g1)
  await mouse('mouseUp', hTo)
  await pause(800)
  const holdDrop = groupById(await dump('10f-chevron-hold-release'), g1)
  const holdOrderBefore = holdStart.tabs.map((tab) => tab.id)
  const freshIndex = tabbarIndex(holdRelease.tabs.map((tab) => tab.x + tab.w / 2), hTo.x)
  const staleIndex = tabbarIndex(holdArrive.tabs.map((tab) => tab.x + tab.w / 2), hTo.x)
  const expectFresh = predictOrder(holdOrderBefore, holder.id, freshIndex)
  const expectStale = predictOrder(holdOrderBefore, holder.id, staleIndex)
  record('drag-chevron-hold-release', underHold === holder.id && holdRelease.dragging && holdRelease.strip.scrollLeft > holdArrive.strip.scrollLeft && expectFresh.join() !== expectStale.join() && holdDrop.tabs.map((tab) => tab.id).join() === expectFresh.join() && !holdDrop.dragging, {
    tab: holder.id, underHold, chevron: hTo, scrollAtArrive: holdArrive.strip.scrollLeft, scrollAtRelease: holdRelease.strip.scrollLeft, staleIndex, freshIndex,
    indexAfter: holdDrop.tabs.findIndex((tab) => tab.id === holder.id), discriminates: expectFresh.join() !== expectStale.join(),
  })
  await wheel({ group: g1, deltaY: -120, times: 40 })
  await pause(300)

  // ⑪ 영역 2개 — 활성 탭 우클릭 → 「오른쪽 영역」. 둘째 영역에도 탭을 늘려 넘치게 한다.
  const preMenu = groupById(await read(), g1)
  const mainAct = activeOf(preMenu)
  await control({ cmd: 'click', selector: `[data-main-tab="${freeTabs(preMenu)[0].id}"]` })
  await pause(400)
  const toMove = activeOf(groupById(await read(), g1))
  const mr = groupById(await read(), g1).tabs.find((tab) => tab.id === toMove.id)
  const rightPoint = { x: Math.round(mr.x + 20), y: Math.round(groupById(await read(), g1).strip.box.y + 10) }
  await mouse('mouseDown', rightPoint, 'right')
  await mouse('mouseUp', rightPoint, 'right')
  await pause(300)
  const menuShown = (await control({ cmd: 'query', selector: '[data-tab-menu-move-right]' })).found?.length > 0
  const moveClick = await control({ cmd: 'click', selector: '[data-tab-menu-move-right]' })
  record('context-menu-move-right', menuShown && moveClick.ok === true, { menuShown, moveClick: { ok: moveClick.ok, hit: moveClick.hit ?? null, blockedBy: moveClick.blockedBy ?? null, error: moveClick.error ?? null }, rightPoint, tab: toMove.id })
  const two = await until(async () => { const now = await read(); return now.length === 2 ? now : null }, '영역 2개', 15_000)
  const g2 = two.find((one) => one.group !== g1).group
  for (let i = 0; i < 6; i += 1) {
    await plus(g2)
    await pause(200)
  }
  await pause(800)
  seen = await dump('11-two-areas')
  record('smoke-context-menu', menuShown, { moved: toMove.id, previousActive: mainAct?.id })
  record('two-areas-overflow', seen.length === 2 && seen.every((one) => one.strip.max > 1 && one.chevrons.start !== null && one.chevrons.end !== null) && groupById(seen, g2).tabs.at(-1).inView && atEnd(groupById(seen, g2)), {
    groups: seen.map((one) => ({ group: one.group, tabs: one.tabs.length, strip: one.strip, chevrons: { start: one.chevrons.start?.disabled, end: one.chevrons.end?.disabled } })), shots: await shot('11-two-areas'),
  })

  // ⑫ 스모크 (K2ⓑ) — 스크롤된 넘침 스트립에서 분할 · 병합 · 중클릭 닫기 · × 닫기 · 실행 중 닫기 확인 모달 · 더블클릭 이름 바꾸기.
  await wheel({ group: g1, deltaY: 120, times: 3 })
  await pause(300)
  const s1 = await read()
  const a = groupById(s1, g1)
  const splitter = freeTabs(a)[0]
  const target2 = groupById(s1, g2)
  const splitTo = { x: Math.round(target2.body.x + target2.body.w * 0.92), y: center(target2.body).y }
  await mouse('mouseMove', { x: Math.round(splitter.x + splitter.w / 2), y: center(a.strip.box).y })
  await mouse('mouseDown', { x: Math.round(splitter.x + splitter.w / 2), y: center(a.strip.box).y })
  await mouse('mouseMove', { x: Math.round(splitter.x + splitter.w / 2) + 10, y: center(a.strip.box).y + 2 })
  for (let i = 1; i <= 12; i += 1) {
    await mouse('mouseMove', { x: Math.round(splitter.x + ((splitTo.x - splitter.x) * i) / 12), y: Math.round(center(a.strip.box).y + ((splitTo.y - center(a.strip.box).y) * i) / 12) })
    await pause(30)
  }
  await pause(150)
  await mouse('mouseUp', splitTo)
  await pause(900)
  const s2 = await dump('12a-split-from-scrolled-strip')
  const splitGroup = s2.find((one) => one.tabs.some((tab) => tab.id === splitter.id))?.group
  record('smoke-split-from-scrolled-strip', a.strip.scrollLeft > 0 && s2.length === 3 && splitGroup !== g1 && splitGroup !== g2, { scrollLeftAtPress: a.strip.scrollLeft, tab: splitter.id, to: splitGroup, groups: s2.map((one) => ({ group: one.group, tabs: one.tabs.length })) })

  // 병합 — 첫 영역(넓은 스트립)의 탭을 ①에서 생긴 영역 본문 가운데로. (영역 3개면 둘째·셋째 스트립은 좁아 누를 탭이 없을 수 있다)
  const g3 = splitGroup
  const b = groupById(s2, g1)
  const merger = freeTabs(b)[0]
  const mergeTo = center(groupById(s2, g3).body)
  const mFrom = { x: Math.round(merger.x + merger.w / 2), y: center(b.strip.box).y }
  await mouse('mouseMove', mFrom)
  await mouse('mouseDown', mFrom)
  await mouse('mouseMove', { x: mFrom.x + 10, y: mFrom.y + 2 })
  for (let i = 1; i <= 12; i += 1) {
    await mouse('mouseMove', { x: Math.round(mFrom.x + ((mergeTo.x - mFrom.x) * i) / 12), y: Math.round(mFrom.y + ((mergeTo.y - mFrom.y) * i) / 12) })
    await pause(30)
  }
  await pause(150)
  await mouse('mouseUp', mergeTo)
  await pause(900)
  const s3 = await dump('12b-merge')
  record('smoke-merge', s3.find((one) => one.tabs.some((tab) => tab.id === merger.id))?.group === g3 && groupById(s3, g3)?.tabs.length === 2, { tab: merger.id, groups: s3.map((one) => ({ group: one.group, tabs: one.tabs.length })) })

  // 중클릭 닫기 — 첫 영역의 보이는 비활성 탭.
  const c1 = groupById(await read(), g1)
  const midTarget = freeTabs(c1)[0]
  const midPoint = { x: Math.round(midTarget.x + midTarget.w / 2), y: center(c1.strip.box).y }
  await mouse('mouseDown', midPoint, 'middle')
  await mouse('mouseUp', midPoint, 'middle')
  const midClosed = await until(async () => !(await fixtureTabIds()).includes(midTarget.id), '중클릭 닫기', 15_000).then(() => true, falseUnlessBoundary)
  record('smoke-middle-click-close', midClosed, { tab: midTarget.id })

  // × 닫기 — 활성 탭의 × (활성은 상시 노출).
  const c2 = groupById(await read(), g1)
  const xTarget = activeOf(c2)
  const xClick = await control({ cmd: 'click', selector: `[data-main-tab-close="${xTarget.id}"]` })
  const xClosed = await until(async () => !(await fixtureTabIds()).includes(xTarget.id), '× 닫기', 15_000).then(() => true, falseUnlessBoundary)
  await pause(500)
  const afterClose = groupById(await dump('12c-after-active-close'), g1)
  record('smoke-x-close-active', xClick.ok && xClosed, { tab: xTarget.id })
  record('active-close-holds-strip', activeOf(afterClose) !== null && (activeOf(afterClose).inView || activeOf(afterClose).dock), { strip: afterClose.strip, active: activeOf(afterClose) })

  // 실행 중 닫기 확인 모달 — 셸 pane 에 `sleep 600`(전경 프로세스) → × → 모달 → 취소(탭 남음).
  const c3 = groupById(await read(), g1)
  const busy = activeOf(c3)
  const busyPane = (await fixtureWorkspace()).tabs.find((tab) => tab.tabId === busy.id)?.panes[0]?.paneId
  herdr('pane', 'run', busyPane, 'sleep 600')
  await pause(1200)
  await control({ cmd: 'click', selector: `[data-main-tab-close="${busy.id}"]` })
  const modal = await until(async () => (await run(() => document.querySelector('[data-confirm-close-modal]') !== null)), '닫기 확인 모달', 10_000).catch(() => false)
  const modalShots = []
  if (modal) {
    const res = await control({ cmd: 'shot', name: 'l496-12d-close-confirm', selector: '[data-confirm-close-modal]' })
    const target = path.join(shotsOut, '12d-close-confirm-modal.png')
    fs.copyFileSync(res.file, target)
    modalShots.push(path.relative(rawd, target))
    await control({ cmd: 'click', selector: '[data-close-confirm-cancel]' })
  }
  await pause(400)
  record('smoke-close-confirm-modal', modal === true && (await fixtureTabIds()).includes(busy.id), { tab: busy.id, shots: modalShots })

  // 더블클릭 이름 바꾸기 — 보이는 탭(493 미완 2: 막 누른 탭은 터미널 마운트 포커스와 경합 — 기존 결함, 결과만 적는다).
  const c4 = groupById(await read(), g1)
  const renameTarget = freeTabs(c4)[0]
  await control({ cmd: 'dblclick', selector: `[data-main-tab="${renameTarget.id}"] .main-tab-label` })
  await pause(300)
  await sendGuarded({ cmd: 'key', keyCode: 'a', modifiers: ['meta'] })
  await sendGuarded({ cmd: 'type', text: 'l496-renamed' })
  await sendGuarded({ cmd: 'key', keyCode: 'Enter' })
  const renamed = await until(async () => groupById(await read(), g1).tabs.find((tab) => tab.id === renameTarget.id)?.label === 'l496-renamed', '이름 바꾸기', 10_000).then(() => true, falseUnlessBoundary)
  // 비활성 탭 직접 더블클릭은 LIFE-493 미완 2 / LIFE-501(탭 누름 → 터미널 마운트 포커스가 입력칸을 뺏는 기존 결함, 범위 밖) — 판정 대상이 아니라 관측으로 남긴다.
  record('observe-rename-dblclick-inactive', null, { renamed, tab: renameTarget.id, label: groupById(await read(), g1).tabs.find((tab) => tab.id === renameTarget.id)?.label, note: 'LIFE-501 기존 결함 경로(비활성 탭 직접 더블클릭) — 판정 밖' })
  await sendGuarded({ cmd: 'key', keyCode: 'Escape' })
  await pause(300)
  // 판정: 활성 탭(가려지지 않은 자리) 더블클릭 이름 바꾸기 — 선택이 안 바뀌는 경로(493 대조군, base·T1 10/10).
  // 바로 위 관측이 그 탭을 막 활성으로 만들었을 수 있다 — 터미널 마운트 포커스(LIFE-501 경합)가 지나가도록 기다린다(k4/r3: 0.3초 뒤 더블클릭이 경합에 졌다).
  await pause(1500)
  const c5 = groupById(await read(), g1)
  const activeRename = activeOf(c5)
  await control({ cmd: 'dblclick', selector: `[data-main-tab="${activeRename.id}"] .main-tab-label` })
  await pause(300)
  await sendGuarded({ cmd: 'key', keyCode: 'a', modifiers: ['meta'] })
  await sendGuarded({ cmd: 'type', text: 'l496-renamed-active' })
  await sendGuarded({ cmd: 'key', keyCode: 'Enter' })
  const renamedActive = await until(async () => groupById(await read(), g1).tabs.find((tab) => tab.id === activeRename.id)?.label === 'l496-renamed-active', '활성 탭 이름 바꾸기', 10_000).then(() => true, falseUnlessBoundary)
  record('smoke-rename-dblclick-active', renamedActive, { tab: activeRename.id, label: groupById(await read(), g1).tabs.find((tab) => tab.id === activeRename.id)?.label })

  // 끝: 마지막 탭 활성 — `+` 한 번(새 탭 = 마지막·활성) → 다 보임·끝.
  const lastId = await plus(g1)
  await pause(900)
  const fin = groupById(await dump('13-last-active-final'), g1)
  record('final-last-tab-active-reachable', activeOf(fin)?.id === lastId && fin.tabs.at(-1).inView && atEnd(fin) && fin.tabs.every((tab) => tab.w >= 71.5), { strip: fin.strip, last: fin.tabs.at(-1), minW: Math.min(...fin.tabs.map((tab) => tab.w)), shots: await shot('13-last-active-final') })
  fs.writeFileSync(path.join(rawd, 't2-tabs.json'), `${JSON.stringify({ workspace: ws.workspaceId, g1, g2, g3, created, bg1, bg2, busy: busy.id }, null, 1)}\n`)
}

main().then(
  () => {
    const failed = log.filter((entry) => entry.ok === false).map((entry) => entry.step)
    record('end', failed.length === 0, { failed })
    process.exit(failed.length === 0 ? 0 : 1)
  },
  (error) => {
    record('error', false, { message: String(error?.stack ?? error).slice(0, 600) })
    process.exit(2)
  },
)
