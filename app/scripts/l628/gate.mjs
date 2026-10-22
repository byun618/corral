/* global fetch, WebSocket */
// LIFE-628 최종 관문 CDP 운전 — up.sh 가 띄운 격리 앱 렌더러에 붙는다. 입력은 CDP·preload API·DOM 만(OS 입력 없음).
//   node scripts/l628/gate.mjs <root> snap                        → 한 표본 JSON (카드 밖 줄·사유·카드 workspace id·stats)
//   node scripts/l628/gate.mjs <root> poll <ms> <간격ms> <out.jsonl> → 페이지 안에서 간격마다 표본, 줄마다 JSON
//   node scripts/l628/gate.mjs <root> eval <JS 식 | @파일>          → 값 JSON
import fs from 'node:fs'

const [root, cmd, ...args] = process.argv.slice(2)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function renderer() {
  const port = fs.readFileSync(`${root}/cdp.port`, 'utf8').trim()
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
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
    } catch { /* 아직 */ }
    await sleep(200)
  }
  throw new Error('renderer page 없음')
}
async function evaluate(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true })
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}
// 표본 — 스냅숏의 카드 밖 줄과 같은 때의 카드(열린 workspace) id. 패널 DOM 이 열려 있으면 그 줄 id·문구도.
const SAMPLE = `async () => {
  const [snap, state] = await Promise.all([window.corral.getResourceSnapshot(), window.corral.getState()])
  const cards = []
  for (const repo of state.repos ?? []) for (const w of repo.worktrees ?? []) if (w.openWorkspaceId) cards.push({ id: w.openWorkspaceId, path: w.path })
  const dom = [...document.querySelectorAll('[data-statusbar-resource-orphan]')].map((el) => ({ id: el.getAttribute('data-statusbar-resource-orphan'), text: (el.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 300) }))
  const unknown = document.querySelector('[data-statusbar-resource-orphans-unknown]')
  return {
    t: new Date().toISOString(),
    link: state.link?.phase ?? null,
    orphans: snap?.orphans === null || snap?.orphans === undefined ? null : snap.orphans.map((o) => ({ id: o.workspaceId, label: o.label, ownerless: o.ownerless, paths: o.paths, agents: o.agents, stopped: o.stoppedAgents, panes: o.paneIds, measure: o.measure })),
    reason: snap?.orphansReason ?? null,
    cards,
    stats: snap?.stats ?? null,
    dom: document.querySelector('[data-statusbar-resource-panel]') ? { rows: dom, unknown: unknown ? (unknown.textContent ?? '').replace(/\\s+/g, ' ') : null } : null,
  }
}`
let c
try {
  c = await renderer()
  switch (cmd) {
    case 'snap': console.log(JSON.stringify(await evaluate(c, `(${SAMPLE})()`))); break
    case 'poll': {
      const [ms, every, out] = args
      const end = Date.now() + Number(ms)
      const fd = fs.openSync(out, 'a')
      while (Date.now() < end) {
        const started = Date.now()
        try { fs.writeSync(fd, `${JSON.stringify(await evaluate(c, `(${SAMPLE})()`))}\n`) } catch (error) { fs.writeSync(fd, `${JSON.stringify({ t: new Date().toISOString(), error: String(error) })}\n`) }
        await sleep(Math.max(0, Number(every) - (Date.now() - started)))
      }
      fs.closeSync(fd)
      console.log(JSON.stringify({ out, ms: Number(ms), every: Number(every) }))
      break
    }
    case 'eval': {
      const src = args[0].startsWith('@') ? fs.readFileSync(args[0].slice(1), 'utf8') : args[0]
      console.log(JSON.stringify(await evaluate(c, src)))
      break
    }
    default: console.error('cmd?'); process.exitCode = 2
  }
} catch (error) { console.error(String(error)); process.exitCode = 1 } finally { c?.ws.close() }
