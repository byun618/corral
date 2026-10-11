// LIFE-567 C1·C2 — 개발 실행에서 창 폭을 줄여(서버가 pane cols 를 줄인 프레임을 보낸다 → TerminalPane sizeTo → term.resize)
// xterm 버퍼가 `viewportY ≠ baseY` 또는 `baseY ≠ 0` 으로 남는지 보고, 그 상태에서 조합 상자 행·helper textarea 행·그려진 커서 행을 잰다.
// 읽기는 xterm **공개 API**(buffer.active)와 DOM rect 만 쓴다(01-criteria G5). 조합은 실제 textarea 에 합성(G4) — 제출하지 않고 취소로 끝낸다.
// 사용: node c1.mjs <ctl.sock> <out 폴더> <회차 이름> [폭 감소 px=40]
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [sock, out, name, dwArg] = process.argv.slice(2)
const dw = Number(dwArg ?? 40)
fs.mkdirSync(out, { recursive: true })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evalJs = async (code) => {
  const res = await rpc(sock, { cmd: 'eval', code: `(() => { ${code} })()` }, 20_000)
  if (!res.ok) throw new Error(`eval 실패 ${JSON.stringify(res).slice(0, 300)}`)
  return res.result
}
// 가려진 창은 rAF 가 멈춘다 — 재기 전에 capturePage 로 프레임을 민다(l566 ime.mjs 와 같은 수법).
const pump = () => rpc(sock, { cmd: 'shot', name: 'l567-frame-pump' }, 20_000)
const shot = async (label) => {
  const res = await rpc(sock, { cmd: 'shot', name: `l567-${label}` }, 20_000)
  if (res.ok) fs.copyFileSync(res.file, path.join(out, `${label}.png`))
}

const HEAD = `const host = document.querySelector('.term-pane.is-selected [data-term-pane]') ?? document.querySelector('[data-term-pane]');
  const xt = host.querySelector('.xterm'); const ta = host.querySelector('.xterm-helper-textarea'); window.__l567 ??= { start: 0 };
  const findTerm = (el) => { const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$')); let fiber = key ? el[key] : null;
    for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) for (let hook = fiber.memoizedState; hook && typeof hook === 'object'; hook = hook.next) {
      const cur = hook.memoizedState && hook.memoizedState.current; if (cur && cur.buffer && cur.buffer.active && cur.element) return cur } return null };
  const term = findTerm(xt.parentElement) || findTerm(xt);`
const STATE = `${HEAD} const b = term.buffer.active;
  return { baseY: b.baseY, viewportY: b.viewportY, cursorX: b.cursorX, cursorY: b.cursorY, length: b.length, rows: term.rows, cols: term.cols,
    window: { w: window.outerWidth, h: window.outerHeight }, lastLine: (b.getLine(b.baseY + term.rows - 1)?.translateToString(true) ?? null),
    firstVisible: b.getLine(b.viewportY)?.translateToString(true) ?? null }`
const MEASURE = `${HEAD} const b = term.buffer.active;
  const r = (el) => { if (!el) return null; const x = el.getBoundingClientRect(); return { top: x.top, left: x.left, width: x.width, height: x.height } };
  const screen = xt.querySelector('.xterm-screen').getBoundingClientRect(); const rows = xt.querySelector('.xterm-rows');
  const rowH = screen.height / term.rows; const view = xt.querySelector('.composition-view'); const cursor = xt.querySelector('.xterm-rows .xterm-cursor');
  const rowOf = (el) => el ? +((el.getBoundingClientRect().top - screen.top) / rowH).toFixed(3) : null;
  return { buffer: { baseY: b.baseY, viewportY: b.viewportY, cursorX: b.cursorX, cursorY: b.cursorY, length: b.length, rows: term.rows, cols: term.cols },
    rowH, screen: { top: screen.top, left: screen.left, height: screen.height },
    view: { active: view?.classList.contains('active') ?? null, text: view?.textContent ?? null, styleTop: view?.style.top ?? null, rect: r(view), row: rowOf(view) },
    textarea: { rect: r(ta), row: rowOf(ta) },
    cursor: { rect: r(cursor), row: rowOf(cursor), domRowIndex: cursor ? Array.prototype.indexOf.call(rows.children, cursor.closest('.xterm-rows > div')) : null },
    viewMinusCursorLeft: view && cursor ? +(view.getBoundingClientRect().left - cursor.getBoundingClientRect().left).toFixed(3) : null }`
const START = `${HEAD} ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Process', bubbles: true, cancelable: true }));
  window.__l567.start = ta.value.length; ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true })); return true`
const UPDATE = (ch) => `${HEAD} ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Process', bubbles: true, cancelable: true }));
  ta.value = ta.value.slice(0, window.__l567.start) + ${JSON.stringify(ch)};
  ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: ${JSON.stringify(ch)}, bubbles: true }));
  ta.dispatchEvent(new InputEvent('input', { data: ${JSON.stringify(ch)}, inputType: 'insertCompositionText', isComposing: true, bubbles: true })); return ta.value`
const CANCEL = `${HEAD} ta.value = ta.value.slice(0, window.__l567.start);
  ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: '', bubbles: true }));
  ta.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true })); return ta.value`

const record = { name, dw, at: new Date().toISOString(), steps: [] }
const step = (label, value) => { record.steps.push({ label, at: Date.now(), value }); console.log(label, JSON.stringify(value)) }

await pump()
const before = await evalJs(STATE)
step('before', before)
const width = before.window.w
const height = before.window.h
step('resize-window', await rpc(sock, { cmd: 'resize-window', width: width - dw, height }))
await pause(1500)
await pump()
step('after-shrink', await evalJs(STATE))
await shot(`${name}-after-shrink`)
step('compose-start', await evalJs(START))
step('compose-update', await evalJs(UPDATE('한')))
await pause(150)
await pump()
const m = await evalJs(MEASURE)
step('measure-composing', m)
await shot(`${name}-composing`)
step('compose-cancel', await evalJs(CANCEL))
step('resize-window-restore', await rpc(sock, { cmd: 'resize-window', width, height }))
await pause(1500)
await pump()
step('after-restore', await evalJs(STATE))
const bad = m.buffer.viewportY !== m.buffer.baseY || m.buffer.baseY !== 0
record.summary = {
  stateDuringCompose: `baseY ${m.buffer.baseY} · viewportY ${m.buffer.viewportY} · length ${m.buffer.length} · rows ${m.buffer.rows}`,
  misaligned: bad,
  viewRow: m.view.row, textareaRow: m.textarea.row, cursorRow: m.cursor.row,
  viewRowEqualsCursorMinusDelta: m.view.row !== null && m.cursor.row !== null ? Math.round(m.view.row) === Math.round(m.cursor.row) - (m.buffer.baseY - m.buffer.viewportY) : null,
  viewMinusCursorLeft: m.viewMinusCursorLeft,
}
step('summary', record.summary)
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(record, null, 1))
