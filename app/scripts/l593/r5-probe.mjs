// 리뷰 r5 독립 프로브 사본(작업 worktree specs/LIFE-593-quick-open/raw/review/claude-r5-raw/probe.mjs) — 바꾼 것: lib 경로(상대)·ROOT 패턴(/tmp/l593g-*)·lint 두 곳(동작 같음)·A2 뒤 입력칸 값 기록은 원본 그대로. 더한 것: A2b(ctl type 으로 글자 — key() 는 char 를 만들지 않는다) · 끝의 verdict(A: 전이 뒤 입력칸 포커스·글자 들어감·Esc / B: Esc / C: Esc) → 하나라도 거짓이면 종료 1.
// R5-C 리뷰어 독립 프로브 — 대화상자가 열린 채 root null↔값 전이 시 포커스·키. 격리 /tmp/l593g-r5c-* 에서만.
/* global fetch, WebSocket */
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, giveBack } from './lib.mjs'
const [root, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '')) throw new Error('ROOT')
const q = (js) => evalJs(root, js)
let sent = 0
const key = (k, m = []) => { sent += 1; return ctl(root, { cmd: 'key', keyCode: k, modifiers: m }) }
const res = { steps: [] }
const rec = (name, data) => { res.steps.push({ name, ...data }); console.log('#', name, JSON.stringify(data).slice(0, 400)) }
const info = () => q(`(() => { const a = document.activeElement; const d = document.querySelector('[data-quick-open]'); const i = document.querySelector('[data-quick-open-input]'); return { open: !!d, state: d?.dataset.quickOpenState ?? null, tag: a?.tagName ?? null, cls: String(a?.className ?? '').slice(0, 50), inDialog: !!a?.closest?.('[data-quick-open]'), isInput: a === i, inputDisabled: i?.disabled ?? null, inputValue: i?.value ?? null, ua: navigator.userAgent.match(/(Electron|Chrome)\\/[\\d.]+/g) } })()`)
let cdpSocket = null, seq = 0; const pend = new Map()
async function cdp(method, params = {}) {
  if (!cdpSocket) {
    const port = Number(fs.readFileSync(path.join(root, 'ud/DevToolsActivePort'), 'utf8').split('\n')[0])
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = pages.find((p) => p.type === 'page' && p.url.includes('/out/renderer/'))
    cdpSocket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r, j) => ((cdpSocket.onopen = r), (cdpSocket.onerror = j)))
    cdpSocket.onmessage = ({ data }) => { const m = JSON.parse(data); const w = pend.get(m.id); if (w) { pend.delete(m.id); if (m.error) w.j(new Error(JSON.stringify(m.error))); else w.r(m.result) } }
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  }
  return new Promise((r, j) => { seq += 1; pend.set(seq, { r, j }); cdpSocket.send(JSON.stringify({ id: seq, method, params })) })
}
const openQ = async () => { await key('Shift'); await key('P', ['meta']); await until(() => q(`!!document.querySelector('[data-quick-open]')`), { timeoutMs: 8000, label: 'open' }); await sleep(500) }
const closeQ = async () => { await key('Escape'); const ok = await until(async () => !(await q(`!!document.querySelector('[data-quick-open]')`)), { timeoutMs: 1500, label: 'close' }).then(() => true, () => false); if (ok) return true; await ctl(root, { cmd: 'raw-mouse', type: 'mouseDown', x: 8, y: 8, button: 'left' }); await ctl(root, { cmd: 'raw-mouse', type: 'mouseUp', x: 8, y: 8, button: 'left' }); await sleep(500); return false }
try {
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30000, label: 'renderer' })
  await giveBack()
  await ctl(root, { cmd: 'resize-window', width: 1400, height: 900 }).catch(() => null)
  await cdp('Runtime.evaluate', { expression: '1' })
  // A — no-root 대화상자가 열린 채 worktree 가 생긴다 (null → 값)
  await openQ()
  rec('A0 no-root 열림', await info())
  await repoPane(root)
  await until(async () => (await info()).state !== 'no-root', { timeoutMs: 8000, label: 'state change' }).then(() => null, () => null)
  await sleep(1200)
  rec('A1 root 전이 뒤', await info())
  await key('A')
  await sleep(300)
  rec('A2 글자 A 뒤', await info())
  await key('Shift')
  await ctl(root, { cmd: 'type', text: 'zq' })
  await sleep(300)
  rec('A2b 글자 zq(type) 뒤', await info())
  await key('Tab')
  await sleep(200)
  rec('A3 Tab 뒤', await info())
  rec('A4 Esc 로 닫힘', { closedByEsc: await closeQ() })
  await sleep(500)
  // B — worktree 있음: 입력칸 포커스 상태에서 입력칸이 꺼진다 (값 → null 모사: DOM disabled)
  await openQ()
  rec('B0 열림', await info())
  await q(`(() => { document.querySelector('[data-quick-open-input]').disabled = true })()`)
  await sleep(300)
  rec('B1 포커스된 입력칸 disabled 뒤', await info())
  rec('B2 Esc 로 닫힘', { closedByEsc: await closeQ() })
  await sleep(500)
  // C — worktree 있음: 대화상자 안 빈 곳(푸터) 클릭 뒤 포커스·Esc
  await openQ()
  const box = await ctl(root, { cmd: 'rect', selector: '[data-quick-open] footer' })
  const r = box.rect
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseDown', x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2), button: 'left' })
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseUp', x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2), button: 'left' })
  await sleep(300)
  rec('C1 푸터 클릭 뒤', await info())
  await key('B')
  await sleep(200)
  rec('C2 글자 B 뒤(입력칸으로 안 감)', await info())
  rec('C3 Esc 로 닫힘', { closedByEsc: await closeQ() })
  const step = (name) => res.steps.find((x) => x.name.startsWith(name)) ?? {}
  res.verdict = {
    'A0 안내 상태 포커스 대화상자 안': step('A0').inDialog === true,
    'A1 null→값 전이 뒤 포커스 입력칸': step('A1').isInput === true && step('A1').state !== 'no-root',
    'A2b 친 글자가 질의에 들어감': String(step('A2b').inputValue ?? '').includes('zq'),
    'A4 Esc 로 닫힘': step('A4').closedByEsc === true,
    'B2 입력칸 꺼진 뒤 Esc 로 닫힘': step('B2').closedByEsc === true,
    'C3 빈 곳 클릭 뒤 Esc 로 닫힘': step('C3').closedByEsc === true,
  }
  console.log('# verdict', JSON.stringify(res.verdict))
  res.ok = Object.values(res.verdict).every(Boolean)
} catch (e) { res.error = String(e?.stack ?? e); console.error(res.error) } finally {
  cdpSocket?.close()
  let rows = []; try { rows = fs.readFileSync(path.join(root, 'ud/corral.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } }) } catch { rows = [] }
  const raw = rows.filter((r) => r.tag === 'input.raw')
  res.inputMix = { harnessKeyCalls: sent, inputRaw: raw.length, inputRawKeyUp: raw.filter((r) => r.type === 'keyUp').length }
  console.log('# inputMix', JSON.stringify(res.inputMix))
  fs.writeFileSync(out, JSON.stringify(res, null, 2))
  process.exit(res.ok ? 0 : 1)
}
