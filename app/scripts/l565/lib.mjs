// LIFE-565 최종 관문 드라이버 공통 — 개발 앱 제어 소켓(/tmp/l565n/ctl.sock) + 관측(main 로그·localhost 접속 로그·CDP 대상 목록).
import fs from 'node:fs'
import { rpc } from '../gui-diff/lib/corral.mjs'

// C6 최종 관문은 L565_ROOT=/tmp/l565c6 로 같은 드라이버를 쓴다(코디의 /tmp/l565n 무접촉).
export const ROOT = process.env.L565_ROOT ?? '/tmp/l565n'
export const SOCK = `${ROOT}/ctl.sock`
export const PORT = fs.existsSync(`${ROOT}/http.port`) ? fs.readFileSync(`${ROOT}/http.port`, 'utf8').trim() : ''
export const CDP = fs.readFileSync(`${ROOT}/cdp.port`, 'utf8').trim()
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
export const termRead = async () => (await control({ cmd: 'term-read' })).term
/** main 로그의 window.open.* 행 */
export const openLog = () =>
  fs
    .readFileSync(`${ROOT}/corral.ndjson`, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"window.open.'))
export const httpLog = () => (fs.existsSync(`${ROOT}/http.ndjson`) ? fs.readFileSync(`${ROOT}/http.ndjson`, 'utf8').split('\n').filter(Boolean) : [])
export const cdpTargets = async () => (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).map((t) => ({ type: t.type, url: t.url.slice(0, 120) }))
/** 렌더러 계측 — confirm·window.open 호출을 센다(통과시킴). 한 번만 설치. */
export const installCounters = () =>
  evalJs(`(() => {
    if (window.__l565c) return window.__l565c
    window.__l565c = { confirm: 0, open: [] }
    const oc = window.confirm.bind(window); window.confirm = (m) => { window.__l565c.confirm++; return oc(m) }
    const oo = window.open.bind(window); window.open = (...a) => { window.__l565c.open.push(String(a[0])); return oo(...a) }
    return window.__l565c
  })()`)
export const counters = () => evalJs(`(() => ({ ...window.__l565c, l565: typeof window.__l565 === 'undefined' ? 'undefined' : String(window.__l565) }))()`)
/** 화면 행에서 글자열 위치(행·열, 0 기반). ASCII 전제 — 행 문자열 인덱스 = 열. */
export function locate(term, text, nth = 0) {
  let seen = 0
  for (let row = 0; row < term.lines.length; row++) {
    let from = 0
    for (;;) {
      const col = term.lines[row].indexOf(text, from)
      if (col < 0) break
      if (seen === nth) return { row, col }
      seen++
      from = col + 1
    }
  }
  return null
}
/**
 * 실제 xterm 경로로 셀을 클릭한다 — .xterm-screen 에 mousemove(→ Linkifier hover) 뒤 mousedown/mouseup.
 * 제어 eval 은 executeJavaScript(userGesture=true) 라 window.open 이 사용자 제스처 안에서 불린다.
 */
export async function clickCell({ row, col, meta }) {
  const move = await evalJs(`(() => {
    const screen = document.querySelector('.term-host .xterm-screen')
    const r = screen.getBoundingClientRect()
    const t = window.corralTermProbe.read()
    const cw = r.width / t.cols, ch = r.height / t.rows
    const x = Math.round(r.left + (${col} + 0.5) * cw), y = Math.round(r.top + (${row} + 0.5) * ch)
    screen.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y, metaKey: ${meta} }))
    return { x, y, cw, ch }
  })()`)
  await pause(150)
  const hover = await evalJs(`(() => { const s = document.querySelector('.term-host .xterm-screen'); return getComputedStyle(s).cursor + '|' + (document.querySelector('.term-host .xterm')?.classList.contains('xterm-cursor-pointer') ?? false) })()`)
  await evalJs(`(() => {
    const screen = document.querySelector('.term-host .xterm-screen')
    const o = { bubbles: true, cancelable: true, clientX: ${move.x}, clientY: ${move.y}, button: 0, buttons: 1, metaKey: ${meta} }
    screen.dispatchEvent(new MouseEvent('mousedown', o))
    screen.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }))
    return true
  })()`)
  return { ...move, hover }
}
/** 셸에 한 줄 보내기 */
export async function run(line) {
  await control({ cmd: 'type', text: line })
  await control({ cmd: 'key', keyCode: 'Return' })
}
/**
 * C1ⓒ — herdr 프레임 `hyperlinks` 관측. main 의 frame-to-ansi 는 frame.hyperlinks 가 가리키는 셀에만 OSC 8(`ESC ] 8 ; ; <uri>`)을 쓴다 —
 * 렌더러로 오는 프레임 바이트의 OSC 8 열기 개수·URI 목록이 그 프레임의 hyperlinks 사용분이다. 관측 리스너만 단다(읽기).
 */
export const installFrameWatch = () =>
  evalJs(`(() => {
    window.__l565f = { frames: 0, osc8Frames: 0, uris: {} }
    const dec = new TextDecoder()
    window.__l565fOff?.()
    window.__l565fOff = window.corral.onTermFrame((frame) => {
      const s = dec.decode(frame.data)
      window.__l565f.frames++
      const opens = [...s.matchAll(/\\x1b\\]8;[^;\\x07\\x1b]*;([^\\x07\\x1b]+)/g)].map((m) => m[1])
      if (opens.length > 0) window.__l565f.osc8Frames++
      for (const u of opens) window.__l565f.uris[u] = (window.__l565f.uris[u] ?? 0) + 1
      window.__l565f.mouseReporting = frame.mouseReporting
    })
    return true
  })()`)
export const frameWatch = () => evalJs('window.__l565f')
