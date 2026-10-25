// LIFE-692 최종 관문 — CDP 도구(격리 앱·설치본 공용). 키 = `Input.dispatchKeyEvent`(페이지 입력 경로 — main `before-input-event`·렌더러 캡처·Monaco 를 그대로 지난다).
// `editor.trigger`·액션 직접 호출은 쓰지 않는다(01-criteria 「키 입력 규칙」). 모델 텍스트·선택 읽기만 Monaco API(읽기 전용)로 한다.
import fs from 'node:fs'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function until(check, { timeoutMs = 15_000, everyMs = 150, label = 'until' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label} 시간 초과`)
    await sleep(everyMs)
  }
}

/** 페이지 대상(앱 창 index.html)에 붙는다. */
export async function connect(port) {
  const targets = await until(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => null)
    return list?.filter((t) => t.type === 'page' && /index\.html/.test(t.url)) ?? null
  }, { timeoutMs: 30_000, label: 'CDP 페이지' })
  if (targets.length !== 1) throw new Error(`페이지 대상이 하나가 아님: ${targets.length}`)
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id !== undefined && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) reject(new Error(`${data.error.message}`))
      else resolve(data.result)
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  // 창이 비활성(showInactive)이어도 페이지는 포커스된 것처럼 — 키·포커스 판정이 실제 사용과 같게.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`eval 예외: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    return result.result.value
  }
  return { send, evaluate, close: () => ws.close(), url: targets[0].url }
}

const KEYS = {
  Backspace: { code: 'Backspace', vk: 8 }, Delete: { code: 'Delete', vk: 46 }, Enter: { code: 'Enter', vk: 13 }, Escape: { code: 'Escape', vk: 27 },
  ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 }, ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
  '/': { code: 'Slash', vk: 191 }, ']': { code: 'BracketRight', vk: 221 }, '[': { code: 'BracketLeft', vk: 219 }, Shift: { code: 'ShiftLeft', vk: 16 },
}
const MOD = { alt: 1, control: 2, meta: 4, shift: 8 }
/** 키 하나(누름+뗌). `combo` = 'Meta+Shift+K' 꼴. 글자 키는 대문자 하나. */
export function keySpec(combo) {
  const parts = combo.split('+')
  const name = parts.pop()
  const mods = parts.map((p) => p.toLowerCase())
  const modifiers = mods.reduce((sum, m) => sum + (MOD[m] ?? 0), 0)
  const known = KEYS[name]
  if (known) return { key: name, code: known.code, vk: known.vk, modifiers }
  if (/^[A-Z]$/.test(name)) return { key: mods.includes('shift') ? name : name.toLowerCase(), code: `Key${name}`, vk: name.charCodeAt(0), modifiers }
  throw new Error(`모르는 키 ${combo}`)
}
export async function press(cdp, combo) {
  const spec = keySpec(combo)
  const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers: spec.modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
/** 글자 입력(키 이벤트 — keyDown text). 앞에 무해한 Shift 누름·뗌(가로챈 keyDown 뒤 글자가 버려지는 하네스 함정 회피). */
export async function typeText(cdp, text) {
  await press(cdp, 'Shift')
  for (const ch of text) {
    const upper = ch.toUpperCase()
    const vk = /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : 0
    const base = { key: ch, code: /[A-Z]/.test(upper) ? `Key${upper}` : '', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...base })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
}
/** 마우스 클릭(실제 입력 경로) — 선택자의 중심(또는 dx·dy 오프셋). */
export async function clickAt(cdp, selector, { dx = null, dy = null } = {}) {
  const box = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
  if (box === null) throw new Error(`클릭 대상 없음 ${selector}`)
  const x = box.x + (dx ?? box.w / 2)
  const y = box.y + (dy ?? box.h / 2)
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  return { x, y }
}
export async function screenshot(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  return fs.statSync(file).size
}

/** 페이지에 키 관측기를 건다 — window 캡처에서 keydown 을 붙잡아 두고, 디스패치가 끝난 뒤 `defaultPrevented`(최종값)를 읽는다. */
export const INSTALL_PROBE = `(() => {
  if (window.__l692) return 'already'
  window.__l692 = { events: [] }
  window.addEventListener('keydown', (event) => {
    const target = event.target instanceof Element ? event.target : null
    window.__l692.events.push({ event, key: event.key, code: event.code, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey,
      target: target ? (target.className && typeof target.className === 'string' ? target.tagName + '.' + target.className.split(' ')[0] : target.tagName) : String(event.target),
      inMarkdownView: !!target?.closest('[data-markdown-view]'), inFileEditor: !!target?.closest('[data-file-editor]'), inTerm: !!target?.closest('[data-term-pane]') })
  }, true)
  return 'installed'
})()`
/** 마지막 keydown(수식 키 제외)의 관측 — defaultPrevented 는 디스패치가 끝난 뒤의 값. */
export const LAST_KEY = `(() => {
  const rows = (window.__l692?.events ?? []).filter((e) => !['Shift','Meta','Control','Alt'].includes(e.key))
  const last = rows[rows.length - 1]
  if (!last) return null
  const { event, ...rest } = last
  return { ...rest, defaultPrevented: event.defaultPrevented }
})()`

/** Monaco 모듈(지연 청크)을 찾아 모델·편집기를 읽는다(읽기 전용). 모델은 파일 이름(URI 끝)으로 찾는다. */
export const MONACO = `(async () => {
  if (window.__l692monaco) return window.__l692monaco
  // file:// 자원은 Resource Timing 에 안 잡힌다 — 하네스가 빌드 폴더에서 읽은 청크 이름(window.__l692monacoFile)으로 같은 URL 을 만든다(같은 모듈 인스턴스).
  if (!window.__l692monacoFile) return null
  const url = new URL('./assets/' + window.__l692monacoFile, location.href).href
  const mod = await import(url)
  const m = Object.values(mod).find((v) => v && typeof v === 'object' && v.editor && typeof v.editor.getEditors === 'function')
  window.__l692monaco = m ?? null
  return m ?? null
})()`
/** 상태 덤프 식 — 그 파일 모델의 텍스트·그 파일 편집기의 선택·포커스, 영역별 탭·Markdown 모드, 활성 요소. */
export const dumpExpr = (file) => `(async () => {
  const m = await ${MONACO}
  const model = m ? m.editor.getModels().find((x) => decodeURIComponent(x.uri.path).endsWith('/' + ${JSON.stringify(file)})) ?? null : null
  const editor = m && model ? m.editor.getEditors().find((e) => e.getModel() === model) ?? null : null
  const sel = editor?.getSelection() ?? null
  const active = document.activeElement
  const groups = [...document.querySelectorAll('.tab-group[data-tab-group]')].map((g) => ({
    groupId: g.dataset.tabGroup,
    active: g.classList.contains('is-active-group'),
    activeTab: g.querySelector('[data-main-tab][data-active="true"]')?.dataset.mainTab ?? g.querySelector('[data-file-tab][data-active="true"]')?.dataset.fileTab ?? null,
    view: g.querySelector('[data-file-view]')?.dataset.fileView ?? null,
    markdownView: g.querySelector('[data-markdown-view]')?.dataset.markdownView ?? null,
  }))
  return {
    monaco: !!m,
    text: model ? model.getValue() : null,
    selection: sel ? { sl: sel.startLineNumber, sc: sel.startColumn, el: sel.endLineNumber, ec: sel.endColumn } : null,
    editorFocus: editor ? editor.hasTextFocus() : null,
    readOnly: editor ? editor.getOption(m.editor.EditorOption.readOnly) : null,
    active: active ? { tag: active.tagName, cls: typeof active.className === 'string' ? active.className.split(' ')[0] : '', inMarkdownView: active.closest('[data-markdown-view]')?.dataset.fileView ?? null, inFileEditor: !!active.closest('[data-file-editor]'), inTerm: !!active.closest('[data-term-pane]'), group: active.closest('[data-file-group]')?.dataset.fileGroup ?? active.closest('.tab-group[data-tab-group]')?.dataset.tabGroup ?? null } : null,
    groups,
    palette: !!document.querySelector('[data-command-palette]'),
    quickOpen: !!document.querySelector('[data-quick-open]'),
  }
})()`
/** 편집기에 텍스트·선택을 놓는다(준비 단계 — 시험 대상 키가 아니다). 같은 모델의 실행 취소 기록은 그대로. */
export const setupExpr = (file, text, sel) => `(async () => {
  const m = await ${MONACO}
  const model = m.editor.getModels().find((x) => decodeURIComponent(x.uri.path).endsWith('/' + ${JSON.stringify(file)}))
  const editor = m.editor.getEditors().find((e) => e.getModel() === model)
  if (${JSON.stringify(text)} !== null && model.getValue() !== ${JSON.stringify(text)}) model.setValue(${JSON.stringify(text)})
  editor.setSelection({ startLineNumber: ${sel.sl}, startColumn: ${sel.sc}, endLineNumber: ${sel.el ?? sel.sl}, endColumn: ${sel.ec ?? sel.sc} })
  editor.focus()
  return { focus: editor.hasTextFocus(), sel: editor.getSelection() }
})()`
