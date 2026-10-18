/* global fetch */
// LIFE-589 E10·E9 — 비교 대상(VS Code·Orca)을 **이 작업이 띄운 격리 인스턴스**의 원격 디버깅 포트(CDP)로 조작·캡처한다.
// OS 화면 캡처(screencapture)는 이 pane 에 화면 기록 권한이 없어 실패한다("could not create image from window") — 그래서 앱 안에서 찍는다.
// 사용: node scripts/l589/cdp-shot.mjs --port <포트> --out <png> [--title <창 제목 일부>] [--eval <js>] [--click-text <행 글자>,…] [--wait <ms>]
//   --click-text: 보이는 트리 행 중 글자가 정확히 같은 첫 행의 가운데를 CDP 마우스로 누른다(차례로). 행 선택자는 --row-selector(기본 VS Code).
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { WebSocket } from 'ws'

const { values } = parseArgs({ options: { port: { type: 'string' }, out: { type: 'string' }, title: { type: 'string', default: '' }, eval: { type: 'string' }, 'click-text': { type: 'string' }, 'row-selector': { type: 'string', default: '.explorer-folders-view .monaco-list-row' }, wait: { type: 'string', default: '600' }, json: { type: 'string' } } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const targets = await (await fetch(`http://127.0.0.1:${values.port}/json/list`)).json()
const page = targets.find((target) => target.type === 'page' && target.title.includes(values.title))
if (page === undefined) throw new Error(`page 없음: ${targets.map((t) => `${t.type}:${t.title}`).join(' | ')}`)
const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
let id = 0
const pending = new Map()
socket.on('message', (raw) => {
  const message = JSON.parse(String(raw))
  if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  id += 1
  pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)))
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
const result = { page: page.title, clicks: [] }
for (const text of (values['click-text'] ?? '').split(',').filter((item) => item.length > 0)) {
  const box = await evaluate(`(() => { const row = [...document.querySelectorAll(${JSON.stringify(values['row-selector'])})].find((el) => el.textContent.trim() === ${JSON.stringify(text)}); if (!row) return null; const r = row.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  result.clicks.push({ text, box })
  if (box === null) continue
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(Number(values.wait))
}
if (values.eval !== undefined) result.eval = await evaluate(values.eval)
if (values.out !== undefined) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync(path.dirname(values.out), { recursive: true })
  fs.writeFileSync(values.out, Buffer.from(shot.data, 'base64'))
  result.out = values.out
}
if (values.json !== undefined) fs.writeFileSync(values.json, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
socket.close()
