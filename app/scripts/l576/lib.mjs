// LIFE-576 최종 관문 드라이버 공통 — 개발 앱 제어 소켓(/tmp/l576n/ctl.sock) · 격리 CLI(격리 userData 의 runtime/rpc.sock) · 사이드바 DOM.
// 입력 두 가지(회차마다 기록): `cdp` = 이 인스턴스 디버깅 포트의 `Input.dispatchMouseEvent`(+ 포커스 에뮬레이션 — 469 격리 틀과 같다. 실제
// Chromium 히트 테스트·document 리스너·`useSidebarReorder` 경로, OS 커서·OS 포커스는 안 건드린다) · OS = `cliclick`(os-drag.sh, 유휴 가드).
// 제어 채널 `raw-mouse`(sendInputEvent)는 쓰지 않는다 — 창이 뒤에 있으면 누른 채 이동이 놓을 때까지 밀려 끌기가 안 선다(1회차 관측, probe3).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { connect, pickTarget } from '../gui-diff/lib/cdp.mjs'

export const ROOT = '/tmp/l576n'
export const SOCK = `${ROOT}/ctl.sock`
export const RPC = `${ROOT}/ud/runtime/rpc.sock`
export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const control = (request, timeout = 20_000) => rpc(SOCK, request, timeout)
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function until(fn, label, timeout = 30_000, every = 250) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${label}`)
    await pause(every)
  }
}
export const state = async () => (await control({ cmd: 'state' })).state
export const evalJs = async (code) => {
  const res = await control({ cmd: 'eval', code })
  if (!res.ok) throw new Error(`eval 실패 ${JSON.stringify(res).slice(0, 300)}`)
  return res.result
}
/** 격리 CLI — 이 worktree 의 `cli/corral.mjs` 를 격리 소켓으로만. 설치본 소켓에는 붙지 않는다. */
export function cli(args) {
  // 이 셸(corral 워커)의 CORRAL_*·HERDR_* 를 지우고 격리 소켓만 준다 — 설치본 소켓으로 새지 않게.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CORRAL_|HERDR_)/.test(key)))
  const outText = execFileSync(process.execPath, [path.join(APP, 'cli/corral.mjs'), ...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, CORRAL_RUNTIME_SOCKET: RPC } })
  return JSON.parse(outText)
}
export function cliTry(args) {
  try {
    return { ok: true, value: cli(args) }
  } catch (error) {
    return { ok: false, status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}
export const show = (worktree) => cli(['worktree', 'show', '--worktree', `path:${worktree}`])
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
export const prefs = () => readJson(`${ROOT}/ud/ui-prefs.json`)
export const registry = () => readJson(`${ROOT}/ud/repos.json`)
export const shot = async (name) => (await control({ cmd: 'shot', name })).file
/** 사이드바 카드 — 화면 순서·깊이·중첩 소유·사각형(창 client 좌표)·표식. */
export const cards = () =>
  evalJs(`(() => [...document.querySelectorAll('[data-repo-list] [data-worktree]')].map((el) => {
    const r = el.getBoundingClientRect()
    const content = el.querySelector('[data-worktree-card-parent-content]')?.getBoundingClientRect() ?? r
    const owner = el.parentElement?.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null
    const section = el.closest('[data-pinned-section]') ? 'pinned' : (el.closest('[data-repo]')?.getAttribute('data-repo') ?? (el.closest('[data-reorder-all]') ? 'all' : null))
    return {
      path: el.getAttribute('data-worktree'), depth: Number(el.getAttribute('data-lineage-depth') ?? 0), owner, section,
      top: r.top, bottom: r.bottom, left: r.left, width: r.width, contentTop: content.top, contentBottom: content.bottom,
      chip: el.querySelector('[data-lineage-toggle="' + el.getAttribute('data-worktree') + '"]')?.textContent?.trim() ?? null,
      parentChip: [...el.querySelectorAll('*')].find((n) => n.children.length === 0 && /^↳ /.test(n.textContent ?? '') && n.closest('[data-worktree]') === el)?.textContent ?? null,
      dropTarget: el.querySelector('[data-lineage-drop-target]') !== null && el.querySelector('[data-lineage-drop-target]')?.closest('[data-worktree]') === el,
      source: el.classList.contains('is-reorder-source'),
    }
  }))()`)
/** 끌기 중 화면 상태 — 표시 줄·상위 지정 강조·사본. */
export const dragView = () =>
  evalJs(`(() => ({
    indicator: [...document.querySelectorAll('[data-reorder-indicator], .reorder-indicator')].map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, h: r.height, display: getComputedStyle(el).display } }),
    targets: [...document.querySelectorAll('[data-lineage-drop-target]')].map((el) => el.closest('[data-worktree]')?.getAttribute('data-worktree')),
    preview: [...document.querySelectorAll('[data-sidebar-drag-preview]')].map((el) => ({ kids: el.children.length, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })),
    sources: [...document.querySelectorAll('.is-reorder-source')].map((el) => el.getAttribute('data-worktree')),
  }))()`)
let session = null
async function cdp() {
  if (session !== null) return session
  const port = Number(fs.readFileSync(`${ROOT}/cdp.port`, 'utf8').trim())
  const { target } = await pickTarget(port, { label: 'corral l576', match: (entry) => /out\/renderer\/index\.html/.test(entry.url) })
  session = await connect(target.webSocketDebuggerUrl)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return session
}
export async function closeCdp() {
  await session?.close().catch(() => {})
  session = null
}
const TYPES = { mouseMove: 'mouseMoved', mouseDown: 'mousePressed', mouseUp: 'mouseReleased' }
let held = false
/** CDP 마우스 — 창 client 좌표. 누른 동안의 이동은 buttons=1. */
export async function mouse(type, x, y) {
  if (type === 'mouseDown') held = true
  if (type === 'mouseUp') held = false
  const cdpType = TYPES[type]
  return (await cdp()).send('Input.dispatchMouseEvent', { type: cdpType, x: Math.round(x), y: Math.round(y), button: cdpType === 'mouseMoved' ? (held ? 'left' : 'none') : 'left', buttons: held || cdpType === 'mousePressed' ? 1 : 0, clickCount: cdpType === 'mouseMoved' ? 0 : 1 })
}
const raw = mouse
/** CDP 클릭 — 요소 가운데. 제어 채널 `click`(sendInputEvent)은 CDP 입력과 섞이면 창이 뒤에 있을 때 순서가 엉켜 엉뚱한 끌기가 생긴다(k2active 1회차). */
export async function clickAt(selector) {
  const at = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (at === null) return { ok: false, selector }
  await pause(150)
  await mouse('mouseMove', at.x, at.y)
  await mouse('mouseDown', at.x, at.y)
  await mouse('mouseUp', at.x, at.y)
  await pause(200)
  return { ok: true, selector, ...at }
}
/** 재기동 뒤 첫 트리 조립까지 — 그 전 화면은 부트 스냅숏(앞 실행의 상태)이라 판정에 쓰지 않는다(k2after·k2activeafter 1회차). */
export async function untilTreeBuilt() {
  const started = Number(fs.readFileSync(`${ROOT}/app.started`, 'utf8').trim())
  return until(() => fs.readFileSync(`${ROOT}/corral.ndjson`, 'utf8').split('\n').some((line) => line.includes('"tag":"tree.built"') && Number(/"at":(\d+)/.exec(line)?.[1] ?? 0) > started), 'tree.built after start', 60_000, 300)
}
/** cdp 입력 끌기 — (x, fromY) 에서 눌러 ys 를 차례로 지나 마지막에서 놓는다. `during` 은 마지막 이동 뒤·놓기 전 관측. */
export async function rawDrag({ x, fromY, ys, during }) {
  await raw('mouseMove', x, fromY)
  await pause(60)
  await raw('mouseDown', x, fromY)
  await pause(60)
  for (const y of ys) {
    await raw('mouseMove', x, y)
    await pause(90)
  }
  await pause(250)
  const seen = during === undefined ? null : await during()
  await raw('mouseUp', x, ys.at(-1))
  await pause(400)
  return seen
}
export const write = (out, name, value) => fs.writeFileSync(path.join(out, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
