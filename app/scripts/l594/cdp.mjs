// LIFE-594 K2 — 렌더러 페이지에 raw CDP 로 붙는다(node ≥ 22 전역 WebSocket). 캡처·마우스·의사 클래스 강제·computed 읽기.
import fs from 'node:fs'
const PORT = fs.readFileSync('/tmp/l594e/cdp.port', 'utf8').trim()
export async function connect() {
  const targets = await (await globalThis.fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl)
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
  let id = 0
  const wait = new Map()
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id) } }
  const send = (method, params = {}) => new Promise((ok, no) => { const i = ++id; wait.set(i, (d) => (d.error ? no(new Error(`${method}: ${JSON.stringify(d.error)}`)) : ok(d.result))); ws.send(JSON.stringify({ id: i, method, params })) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value }
  const shot = async (file, clip) => { const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 2 } } : {}) }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file }
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra })
  return { send, evaluate, shot, mouse, close: () => ws.close(), url: page.url }
}
