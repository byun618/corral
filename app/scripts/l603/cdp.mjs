#!/usr/bin/env node
// LIFE-603 최종 관문 (R3-L) — 격리 앱 CDP 드라이버. 앱은 `up.sh <ROOT> L603_EXTRA_ARGS=--remote-debugging-port=<PORT>` 로 띄운다.
//   node scripts/l603/cdp.mjs eval '<식>'      — 렌더러에서 식을 돌려(Promise 는 기다림) 값을 JSON 한 줄로
//   node scripts/l603/cdp.mjs shot <out.png>   — Page.captureScreenshot
// 값 입력은 식 안에서 DOM setter(네이티브 value setter + input 이벤트)로만 한다 — OS 키 입력 · CGEvent 없음.
// PORT = L603_CDP_PORT(기본 9603). 127.0.0.1 만. 실패 전파: 페이지 없음 · 식 예외 → exit 1, 출력 0줄 없음.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.L603_CDP_PORT ?? 9603)

export async function connect() {
  const pages = await (await globalThis.fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = pages.find((entry) => entry.type === 'page' && entry.url.includes('/renderer/index.html'))
  if (!page) throw new Error('renderer page 없음')
  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let next = 0
  const waiting = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const pending = waiting.get(message.id)
    if (!pending) return
    waiting.delete(message.id)
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
    else pending.resolve(message.result)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => { next += 1; waiting.set(next, { resolve, reject }); ws.send(JSON.stringify({ id: next, method, params })) })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  const shot = async (out) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(out, Buffer.from(data, 'base64'))
    return out
  }
  return { send, evaluate, shot, close: () => ws.close() }
}

async function main([command, argument]) {
  const cdp = await connect()
  try {
    if (command === 'eval') console.log(JSON.stringify(await cdp.evaluate(argument)) ?? 'undefined')
    else if (command === 'shot') console.log(JSON.stringify({ ok: true, out: await cdp.shot(argument) }))
    else { console.log(JSON.stringify({ ok: false, code: 'usage' })); return 2 }
    return 0
  } finally { cdp.close() }
}

const invokedDirectly = () => { try { return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } }
if (invokedDirectly()) main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) })); process.exit(1) })
