#!/usr/bin/env node
// LIFE-601 최종 관문 2단계 준비 — 설치본을 `--remote-debugging-port=<포트>` 로 띄운 회차에서 **CDP `Input.dispatchMouseEvent`** 로 끄는 코디 도구.
// LIFE-600 `specs/LIFE-600-provider-contract/raw/coordinator/cdp.mjs`(eval·shot·key·type)와 같은 연결 방식 — 마우스 끌기만 더한다. 토큰 입력칸 값은 읽지 않는다.
//
//   node scripts/l601/cdp-drag.mjs <포트> drag '<끌 요소 선택자>' '<놓을 요소 선택자>' [bottom|top|mid] [--up-outside] [--key-mid=Mod+I]
//     → 누름(끌 요소 위 왼쪽 120px 안 · 세로 가운데) → 문턱 이동 → 놓을 요소(기본 아래쪽 끝 −6px)로 이동(두 번 — 틈이 밀어낸 뒤 다시 잰다) → 놓음
//     `--up-outside` = 창 밖 좌표(-10,-10)에서 놓음(R3-F 취소) · `--key-mid=<키>` = 누른 채 그 키(예 ⌘I = Mod+I)를 누르고 놓음(R2-K)
//   결과 JSON 한 줄: 좌표 · 끄는 중 사본(`.tasks-drag-preview`) 보임 여부 · 놓을 칸의 흐림/이유.
// 실제 OS 커서가 아니라 렌더러 입력 이벤트다(Electron `sendInputEvent` 와 같은 층) — 격리 앱에서 판정 경로가 같은지 q-cdp.mjs 가 확인한다.
// 종료 코드: 0 보냄 · 2 사용법 · 3 대상 없음.
/* global fetch, WebSocket */ // Node 22+ 전역
const MOD = { Alt: 1, Control: 2, Mod: 4, Meta: 4, Shift: 8 }

export async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((target) => target.type === 'page' && !target.url.startsWith('devtools'))
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = (message) => { const data = JSON.parse(message.data); if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id) } }
  const send = (method, params = {}) => new Promise((resolve) => { const index = ++id; pending.set(index, resolve); ws.send(JSON.stringify({ id: index, method, params })) })
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value ?? null
  return { send, evaluate, close: () => ws.close() }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function pressKey(cdp, combo) {
  const parts = combo.split('+')
  const key = parts.pop()
  const modifiers = parts.reduce((sum, part) => sum | MOD[part], 0)
  const code = key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key) : key
  const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : key === 'Escape' ? 27 : 0
  for (const type of ['rawKeyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}

export async function drag(cdp, { from, to, where = 'bottom', upOutside = false, keyMid = null }) {
  const point = (selector, mode) => cdp.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 120)), y: Math.round(${mode === 'bottom' ? 'r.bottom - 6' : mode === 'top' ? 'r.top + 3' : 'r.y + Math.min(r.height / 2, 20)'}) } })()`)
  const start = await point(from, 'mid')
  if (start === null) return { ok: false, reason: `끌 요소 없음 ${from}` }
  const mouse = (type, { x, y }, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
  await mouse('mousePressed', start, 1)
  await mouse('mouseMoved', { x: start.x + 10, y: start.y }, 1)
  await sleep(700)
  const first = await point(to, where)
  if (first === null) { await mouse('mouseReleased', { x: -10, y: -10 }, 0); return { ok: false, reason: `놓을 요소 없음 ${to}` } }
  await mouse('mouseMoved', first, 1)
  await sleep(300)
  const end = (await point(to, where)) ?? first
  await mouse('mouseMoved', end, 1)
  await sleep(150)
  const during = await cdp.evaluate(`(() => { const z = document.querySelector(${JSON.stringify(to)}); const lane = z?.closest('[data-board-column], [data-backlog-section]'); return { preview: !!document.querySelector('.tasks-drag-preview'), lane: lane?.className ?? null, reason: lane?.querySelector('[data-column-reason]')?.textContent ?? null } })()`)
  if (keyMid !== null) { await pressKey(cdp, keyMid); await sleep(400) }
  const up = upOutside ? { x: -10, y: -10 } : end
  await mouse('mouseReleased', up, 0)
  await sleep(300)
  return { ok: true, start, end, up, keyMid, during }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [port, cmd, from, to, ...rest] = process.argv.slice(2)
  if (port === undefined || cmd !== 'drag' || from === undefined || to === undefined) {
    console.error("사용법: node scripts/l601/cdp-drag.mjs <포트> drag '<끌 요소>' '<놓을 요소>' [bottom|top|mid] [--up-outside] [--key-mid=Mod+I]")
    process.exit(2)
  }
  const where = rest.find((arg) => ['bottom', 'top', 'mid'].includes(arg)) ?? 'bottom'
  const keyMid = rest.find((arg) => arg.startsWith('--key-mid='))?.slice('--key-mid='.length) ?? null
  const cdp = await connect(port)
  const result = await drag(cdp, { from, to, where, upOutside: rest.includes('--up-outside'), keyMid })
  console.log(JSON.stringify(result))
  cdp.close()
  process.exit(result.ok ? 0 : 3)
}
