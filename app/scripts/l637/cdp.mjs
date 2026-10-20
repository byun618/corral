/* global fetch, WebSocket */
// LIFE-637 최종 관문 CDP 운전 — up.sh 가 띄운 격리 앱의 렌더러(--remote-debugging-port)와 main(--inspect)에 붙는다. 입력은 CDP 로만(OS 입력 없음).
//   node scripts/l637/cdp.mjs <root> eval  <renderer JS 식>        → 값 JSON
//   node scripts/l637/cdp.mjs <root> main  <main JS 식>            → 값 JSON (globalThis.__l637 = { electron, require })
//   node scripts/l637/cdp.mjs <root> key   <key> [code] [vk] [modifiers]   (modifiers: 1 Alt 2 Ctrl 4 Meta 8 Shift)
//   node scripts/l637/cdp.mjs <root> click <CSS 선택자>             → 그 요소 중심에 마우스 눌림·뗌(Chromium 기본 동작 — 포커스 이동 포함)
//   node scripts/l637/cdp.mjs <root> shot  <png 경로> [CSS 선택자 — 그 영역만]
import fs from 'node:fs'

const [root, cmd, ...args] = process.argv.slice(2)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id === undefined) return
    const p = pending.get(data.id); pending.delete(data.id)
    if (data.error) p.reject(new Error(JSON.stringify(data.error))); else p.resolve(data.result)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  return { ws, send }
}
async function renderer() {
  const port = fs.readFileSync(`${root}/cdp.port`, 'utf8').trim()
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page) return connect(page.webSocketDebuggerUrl)
    } catch { /* 아직 */ }
    await sleep(200)
  }
  throw new Error('renderer page 없음')
}
async function main() {
  const port = fs.readFileSync(`${root}/inspect.port`, 'utf8').trim()
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  return connect(targets[0].webSocketDebuggerUrl)
}
async function evaluate(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true })
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}
let c
try {
  switch (cmd) {
    case 'eval': c = await renderer(); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }); console.log(JSON.stringify(await evaluate(c, args[0]))); break
    case 'main': c = await main(); console.log(JSON.stringify(await evaluate(c, args[0]))); break
    case 'key': {
      c = await renderer(); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      const [key, code = key, vk = '0', modifiers = '0'] = args
      const base = { key, code, windowsVirtualKeyCode: Number(vk), modifiers: Number(modifiers) }
      await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      if (key.length === 1 && Number(modifiers) === 0) await c.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: key })
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await sleep(150)
      console.log(JSON.stringify(await evaluate(c, `(() => { const a = document.activeElement; return a ? { tag: a.tagName.toLowerCase(), data: Object.fromEntries(Object.entries(a.dataset)), text: (a.textContent ?? '').slice(0, 60) } : null })()`)))
      break
    }
    case 'click': {
      c = await renderer(); await c.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      const box = await evaluate(c, `(() => { const el = document.querySelector(${JSON.stringify(args[0])}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
      if (box === null) throw new Error(`요소 없음 ${args[0]}`)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 })
      await sleep(150)
      console.log(JSON.stringify(await evaluate(c, `(() => { const a = document.activeElement; return { at: ${JSON.stringify(box)}, active: a ? { tag: a.tagName.toLowerCase(), data: Object.fromEntries(Object.entries(a.dataset)), text: (a.textContent ?? '').slice(0, 60) } : null } })()`)))
      break
    }
    case 'shot': {
      c = await renderer()
      let clip
      if (args[1]) {
        const b = await evaluate(c, `(() => { const el = document.querySelector(${JSON.stringify(args[1])}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`)
        if (b) clip = { ...b, scale: 2 }
      }
      const { data } = await c.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) })
      fs.writeFileSync(args[0], Buffer.from(data, 'base64'))
      console.log(JSON.stringify({ shot: args[0], clip: clip ?? null }))
      break
    }
    default: console.error('cmd?'); process.exit(2)
  }
} catch (error) { console.error(String(error)); process.exitCode = 1 } finally { c?.ws.close() }
