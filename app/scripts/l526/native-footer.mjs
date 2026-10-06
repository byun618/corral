/* global document, window, getComputedStyle -- eval 로 렌더러 안에서 도는 클로저가 쓴다 */
// LIFE-526 K4ⓐ **네이티브 관문** — native-up.sh 가 띄운 사용자 userData + 구현 빌드 + herdr 정식 `default` 세션(LIFE-456 S9 B안).
//
// 입력 경로 — 판정 걸음은 전부 제품 경로: 클릭 = 제어 소켓 click(`webContents.sendInputEvent` 좌표, 가려져 있으면 누르지 않는다) ·
// hover = 제어 소켓 raw-mouse mouseMove(같은 sendInputEvent 좌표). 버튼 onClick 을 직접 부르지 않는다. 덤프(eval)는 읽기만.
//
// **원자료 경계(사용자 데이터 비공개)**: 캡처는 하단 바(`[data-sidebar-footer]`)와 도움말 메뉴(`[data-help-menu]`)만 — 레포·카드·탭 이름이 안 들어간다.
// 설정 페이지는 열림 여부만 DOM 으로 적고 캡처하지 않는다. 복구된 사용자 세션 pane 에는 입력·포커스 조작을 하지 않는다.
//
// ① 하단 바 줄·묶음·버튼·아이콘 computed box·색 덤프 + 기본 캡처
// ② 네 버튼 hover(⚙·?·⌖·↻) — 포인터 이동 → computed color·background → 캡처 → 캡처 뒤 다시 computed(hover 가 캡처에 남았나)
// ③ ? 실제 클릭 → 메뉴 열림(버튼 위) 캡처 → 다시 클릭 → 닫힘
// ④ ⚙ 실제 클릭 → 설정 페이지 열림 → 「앱으로 돌아가기」 실제 클릭 → 닫힘
// 사용(저장소 루트): node app/scripts/l526/native-footer.mjs <ROOT=/tmp/l526n*> <raw 폴더>
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [root, rawd] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l526n')) throw new Error('ROOT 는 /tmp/l526n*')
fs.mkdirSync(rawd, { recursive: true })
const ctl = path.join(root, 'ctl.sock')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const control = (request) => rpc(ctl, request, 20_000)
const evaluate = async ({ fn, arg = null }) => (await rpc(ctl, { cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result

const result = { startedAt: new Date().toISOString(), appPid: Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8')), input: 'control socket sendInputEvent (click·raw-mouse mouseMove)', steps: {}, checks: [] }
const save = () => fs.writeFileSync(path.join(rawd, 'native-footer.json'), `${JSON.stringify(result, null, 1)}\n`)
const check = (id, label, pass, detail) => {
  result.checks.push({ id, label, pass, detail })
  console.log(`[l526n] ${pass ? '통과' : '실패'} ${id} — ${label}`)
}
const until = async ({ label, probe, timeout = 10_000 }) => {
  const t0 = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - t0 > timeout) throw new Error(`시간초과: ${label}`)
    await pause(120)
  }
}

const UNITS = {
  row: '[data-sidebar-footer]',
  groupLeft: '[data-sidebar-footer] > .sidebar-footer-group:first-child',
  groupRight: '[data-sidebar-footer] > .sidebar-footer-group:last-child',
  settings: '[data-settings-open]',
  settingsIcon: '[data-settings-open] > svg',
  help: '[data-help-menu-toggle]',
  helpIcon: '[data-help-menu-toggle] > svg',
  reveal: '[data-reveal-active]',
  revealIcon: '[data-reveal-active] > svg',
  refresh: '[data-refresh-tree]',
  refreshIcon: '[data-refresh-tree] > svg',
}
/** 렌더러 안 — 단위별 box(사이드바 기준·창 기준)·computed 선별. */
function dumpPage(units) {
  const sidebar = document.querySelector('[data-sidebar]')?.getBoundingClientRect() ?? null
  const props = ['display', 'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap', 'alignItems', 'justifyContent',
    'borderTopWidth', 'borderTopColor', 'borderTopLeftRadius', 'color', 'backgroundColor', 'opacity']
  // 색 표기 정규화 — 측정 도구(lib/probe.mjs)와 같은 방식: 1×1 캔버스에 칠하고 8비트 rgba 로 읽는다(color-mix 는 `color(srgb …)` 로 나온다).
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const scratch = canvas.getContext('2d', { willReadFrequently: true })
  const rgba = (value) => {
    scratch.clearRect(0, 0, 1, 1)
    scratch.fillStyle = 'rgba(0, 0, 0, 0)'
    scratch.fillStyle = value
    scratch.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = scratch.getImageData(0, 0, 1, 1).data
    return a === 0 ? 'rgba(0, 0, 0, 0)' : `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`
  }
  const out = { dpr: window.devicePixelRatio, sidebar: sidebar && { x: sidebar.x, y: sidebar.y, w: sidebar.width, h: sidebar.height }, units: {} }
  for (const [key, selector] of Object.entries(units)) {
    const el = document.querySelector(selector)
    if (!el) { out.units[key] = null; continue }
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    out.units[key] = {
      selector,
      box: { x: r.x, y: r.y, w: r.width, h: r.height },
      fromSidebarBottom: sidebar ? sidebar.y + sidebar.height - r.y : null,
      style: Object.fromEntries(props.map((p) => [p, style[p]])),
      rgba: { color: rgba(style.color), backgroundColor: rgba(style.backgroundColor), borderTopColor: rgba(style.borderTopColor) },
      attrs: Object.fromEntries(el.getAttributeNames().filter((n) => n.startsWith('data-') || n.startsWith('aria-') || n === 'title').map((n) => [n, el.getAttribute(n)])),
      text: el.textContent,
      hovered: el.matches(':hover'),
    }
  }
  return out
}
const dump = () => evaluate({ fn: dumpPage, arg: UNITS })
const shot = async (name, selector) => {
  const reply = await control({ cmd: 'shot', name, selector })
  if (reply.ok && reply.file && fs.existsSync(reply.file)) {
    const dest = path.join(rawd, path.basename(reply.file))
    fs.copyFileSync(reply.file, dest)
    return path.basename(dest)
  }
  return { error: reply }
}
const center = async (selector) => {
  const reply = await control({ cmd: 'rect', selector })
  if (!reply.ok) throw new Error(`rect 없음: ${selector}`)
  return { x: Math.round(reply.rect.left + reply.rect.width / 2), y: Math.round(reply.rect.top + reply.rect.height / 2) }
}
const move = async ({ x, y }) => control({ cmd: 'raw-mouse', type: 'mouseMove', x, y })
const snap = () => evaluate({ fn: () => ({
  settingsOpen: document.querySelector('[data-settings-page]') !== null,
  helpMenu: (() => { const el = document.querySelector('[data-help-menu]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, items: [...el.querySelectorAll('[data-menu-action]')].map((i) => i.getAttribute('data-menu-action')) } })(),
  helpButton: (() => { const r = document.querySelector('[data-help-menu-toggle]')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null })(),
  helpExpanded: document.querySelector('[data-help-menu-toggle]')?.getAttribute('aria-expanded') ?? null,
}) })

let exitCode = 0
try {
  await until({ label: '하단 바', probe: async () => (await control({ cmd: 'rect', selector: '[data-sidebar-footer]' })).ok, timeout: 30_000 })
  await pause(1500)
  // 포인터를 하단 바 밖(사이드바 위쪽 빈 곳이 아닌 창 왼쪽 위 모서리)으로 — 시작 상태에 hover 가 없게.
  await move({ x: 2, y: 2 })
  await pause(300)

  // ①
  const base = await dump()
  result.steps.default = { dump: base, shot: await shot('l526n-footer-default', '[data-sidebar-footer]') }
  const u = base.units
  const btns = ['settings', 'help', 'reveal', 'refresh']
  check('K1b-box', '네 버튼 24×24 · 아이콘 14×14 · 아이콘 가운데(버튼 안 5px) · 둥글기 8px · 글자색 rgb(161,161,161)',
    btns.every((k) => u[k] && u[k].box.w === 24 && u[k].box.h === 24 && u[k].style.borderTopLeftRadius === '8px' && u[k].style.color === 'rgb(161, 161, 161)'
      && u[`${k}Icon`] && u[`${k}Icon`].box.w === 14 && u[`${k}Icon`].box.h === 14 && u[`${k}Icon`].box.x - u[k].box.x === 5 && u[`${k}Icon`].box.y - u[k].box.y === 5),
    Object.fromEntries(btns.map((k) => [k, { box: u[k]?.box, icon: u[`${k}Icon`]?.box, radius: u[k]?.style.borderTopLeftRadius, color: u[k]?.style.color }])))
  check('K2a-row', '하단 바 줄 높이 37 · padding 6/8 · 위 테두리 1px · 묶음 gap 4px · 좌우 끝(왼 버튼 x=사이드바+8, 오른 버튼 끝=사이드바 오른끝−8)',
    u.row.box.h === 37 && u.row.style.paddingTop === '6px' && u.row.style.paddingLeft === '8px' && u.row.style.borderTopWidth === '1px'
      && u.groupLeft.style.gap === '4px' && u.groupRight.style.gap === '4px'
      && u.settings.box.x - base.sidebar.x === 8 && base.sidebar.x + base.sidebar.w - (u.refresh.box.x + u.refresh.box.w) === 8,
    { row: u.row.box, padding: [u.row.style.paddingTop, u.row.style.paddingLeft], border: u.row.style.borderTopWidth, gaps: [u.groupLeft.style.gap, u.groupRight.style.gap], sidebar: base.sidebar })
  check('K1-glyph', '유니코드 글자 버튼 0개(버튼 글자 내용 빈 칸) · aria-label 4개', btns.every((k) => u[k].text === '' && u[k].attrs['aria-label']), Object.fromEntries(btns.map((k) => [k, { text: u[k].text, attrs: u[k].attrs }])))

  // ②
  result.steps.hover = {}
  for (const key of btns) {
    await move(await center(UNITS[key]))
    await pause(350)
    const before = await dump()
    const file = await shot(`l526n-footer-hover-${key}`, '[data-sidebar-footer]')
    const after = await dump()
    result.steps.hover[key] = { before: before.units[key], afterShot: after.units[key], shot: file }
  }
  // 기대값 = Orca 198 ghost icon-xs hover 측정값(measure after-526 footer-hover-*: color rgba(250, 250, 250, 1) · bg rgba(64, 64, 64, 0.502)).
  check('K1c-hover', '네 버튼 hover: 글자색 rgba(250,250,250,1) · 배경 rgba(64,64,64,0.502)(Orca 198 측정값) — 캡처 앞·뒤 모두',
    btns.every((k) => ['before', 'afterShot'].every((when) => { const s = result.steps.hover[k][when]; return s.hovered && s.rgba.color === 'rgba(250, 250, 250, 1)' && s.rgba.backgroundColor === 'rgba(64, 64, 64, 0.502)' })),
    Object.fromEntries(btns.map((k) => [k, ['before', 'afterShot'].map((w) => ({ hovered: result.steps.hover[k][w].hovered, color: result.steps.hover[k][w].rgba.color, bg: result.steps.hover[k][w].rgba.backgroundColor, raw: result.steps.hover[k][w].style.backgroundColor }))])))
  await move({ x: 2, y: 2 })
  await pause(300)

  // ③
  const c1 = await control({ cmd: 'click', selector: '[data-help-menu-toggle]' })
  await until({ label: '도움말 메뉴', probe: async () => (await snap()).helpMenu !== null })
  await pause(300)
  const opened = await snap()
  result.steps.help = { click: c1, opened, shotMenu: await shot('l526n-help-menu', '[data-help-menu]'), shotFooter: await shot('l526n-help-open-footer', '[data-sidebar-footer]') }
  check('K4a-help-open', '? 실제 클릭 → 메뉴가 버튼 위로 열림(메뉴 아랫변 ≤ 버튼 윗변) · aria-expanded=true',
    c1.ok === true && opened.helpMenu !== null && opened.helpMenu.y + opened.helpMenu.h <= opened.helpButton.y + 0.5 && opened.helpExpanded === 'true', { click: c1.ok, menu: opened.helpMenu, button: opened.helpButton })
  const c2 = await control({ cmd: 'click', selector: '[data-help-menu-toggle]' })
  await pause(400)
  const closed = await snap()
  result.steps.help.closeClick = c2
  result.steps.help.closed = closed
  check('K4a-help-close', '? 다시 실제 클릭 → 닫힘', c2.ok === true && closed.helpMenu === null && closed.helpExpanded === 'false', { click: c2.ok, menu: closed.helpMenu })

  // ④
  const c3 = await control({ cmd: 'click', selector: '[data-settings-open]' })
  await until({ label: '설정 열림', probe: async () => (await snap()).settingsOpen })
  result.steps.settings = { click: c3, open: (await snap()).settingsOpen }
  check('K4a-settings', '⚙ 실제 클릭 → 설정 페이지 열림', c3.ok === true && result.steps.settings.open, result.steps.settings)
  const c4 = await control({ cmd: 'click', selector: '[data-settings-back]' })
  await until({ label: '설정 닫힘', probe: async () => !(await snap()).settingsOpen })
  result.steps.settings.backClick = c4
  result.steps.settings.closedAfterBack = !(await snap()).settingsOpen
  await move({ x: 2, y: 2 })
  exitCode = result.checks.every((row) => row.pass) ? 0 : 1
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[l526n] 오류', result.error)
  exitCode = 2
} finally {
  result.finishedAt = new Date().toISOString()
  result.exitCode = exitCode
  save()
}
process.exit(exitCode)
