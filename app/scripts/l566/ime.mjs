// LIFE-566 G4·G5 — 개발 실행 렌더러의 **실제 xterm textarea** 에 조합 이벤트를 합성하고, 조합 표시층 DOM 경계·스크린샷을 남긴다.
// OS 입력·입력 소스는 건드리지 않는다(02-kickoff 격리 4). 각 걸음은 control `eval`/`shot` 한 번이다.
// 사용: node ime.mjs <ctl.sock> <out 폴더> <걸음...>
//   start | update:<글자> | end | cancel | input:<글자> | key:<KeyCode> | measure:<이름> | shot:<이름> | wait:<ms> | focus
// 합성 순서는 Chromium·macOS 한글 IME 의 순서를 따른다: keydown(229) → compositionstart → (textarea 값에 preedit 반영) compositionupdate → input(insertCompositionText) → … → compositionend.
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [sock, out, ...steps] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const evalJs = async (code) => {
  const res = await rpc(sock, { cmd: 'eval', code }, 20_000)
  if (!res.ok) throw new Error(`eval 실패 ${JSON.stringify(res).slice(0, 300)}`)
  return res.result
}
// 렌더러 안에서 도는 공통 머리 — 선택된 pane 의 textarea. 조합 시작 위치는 window.__l566 에 둔다.
const HEAD = `const host = document.querySelector('.term-pane.is-selected [data-term-pane]') ?? document.querySelector('[data-term-pane]');
const ta = host.querySelector('.xterm-helper-textarea'); window.__l566 ??= { start: 0 };`
const js = {
  focus: `${HEAD} ta.focus(); return { active: document.activeElement === ta, hasFocus: document.hasFocus() }`,
  start: `${HEAD} ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Process', bubbles: true, cancelable: true }));
    window.__l566.start = ta.value.length; ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true })); return { start: window.__l566.start }`,
  update: (ch) => `${HEAD} ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Process', bubbles: true, cancelable: true }));
    ta.value = ta.value.slice(0, window.__l566.start) + ${JSON.stringify(ch)};
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: ${JSON.stringify(ch)}, bubbles: true }));
    ta.dispatchEvent(new InputEvent('input', { data: ${JSON.stringify(ch)}, inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
    return { value: ta.value }`,
  end: `${HEAD} const data = ta.value.slice(window.__l566.start);
    ta.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true })); return { committed: data }`,
  // 취소(Esc 등으로 preedit 를 버림) — textarea 의 preedit 를 지우고 빈 data 로 끝낸다.
  cancel: `${HEAD} ta.value = ta.value.slice(0, window.__l566.start);
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: '', bubbles: true }));
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true })); return { value: ta.value }`,
  measure: `${HEAD}
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height } };
    const cs = (el, props) => { if (!el) return null; const s = getComputedStyle(el); return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)])) };
    const q = (sel) => host.querySelector(sel);
    const all = (sel) => Array.from(host.querySelectorAll(sel)).map((el) => ({ cls: el.className, rect: r(el), text: el.textContent }));
    const view = q('.composition-view');
    // caret 은 조합 상자의 ::after 다(LIFE-566 r0). 계산값을 그대로 읽고, 상자 테두리 상자 기준 left 를 더해 화면 x 를 낸다(r1 F1 — 가정 금지).
    const after = view ? getComputedStyle(view, '::after') : null;
    const caret = after && after.getPropertyValue('content') !== 'none' && after.getPropertyValue('display') !== 'none' ? (() => {
      const box = view.getBoundingClientRect(); const left = parseFloat(after.getPropertyValue('left')); const width = parseFloat(after.getPropertyValue('width'));
      const borderLeft = parseFloat(getComputedStyle(view).getPropertyValue('border-left-width')) || 0;
      return { content: after.getPropertyValue('content'), left: box.left + borderLeft + left, width, cssLeft: after.getPropertyValue('left'), cssWidth: after.getPropertyValue('width'),
        backgroundColor: after.getPropertyValue('background-color'), top: box.top + (parseFloat(after.getPropertyValue('top')) || 0), height: parseFloat(after.getPropertyValue('height')) };
    })() : null;
    const screen = q('.xterm-screen'); const rows = q('.xterm-rows');
    const range = view && view.firstChild ? (() => { const rg = document.createRange(); rg.selectNodeContents(view); const b = rg.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width } })() : null;
    return {
      dpr: window.devicePixelRatio, hasFocus: document.hasFocus(), activeIsTextarea: document.activeElement === ta,
      xtermFocusClass: q('.xterm')?.classList.contains('focus') ?? null,
      host: r(host), screen: r(screen), rowsEl: r(rows),
      compositionView: { rect: r(view), textRange: range, active: view?.classList.contains('active') ?? null, text: view?.textContent ?? null,
        style: cs(view, ['background-color', 'color', 'left', 'top', 'width', 'height', 'font-family', 'font-size', 'text-decoration-line', 'display', 'z-index', 'padding-right', 'box-shadow', 'border-right-width']) },
      caret,
      cursor: all('.xterm-cursor'),
      // 커서 칸 색(양성 대조·C2ⓒ 판정용) — 조합 중엔 수정본 CSS 가 지우므로 계산값을 그대로 남긴다.
      cursorStyle: (() => { const el = q('.xterm-rows .xterm-cursor'); return el ? cs(el, ['background-color', 'color', 'outline-color', 'outline-style', 'box-shadow', 'animation-name']) : null })(),
      xtermClasses: q('.xterm')?.className ?? null,
      helpers: { rect: r(q('.xterm-helpers')), style: cs(q('.xterm-helpers'), ['left', 'top', 'position']) },
      textarea: { rect: r(ta), style: cs(ta, ['left', 'top', 'width', 'height', 'opacity', 'caret-color', 'z-index', 'color']), value: ta.value },
    }`,
}
for (const step of steps) {
  const [name, arg] = step.includes(':') ? [step.slice(0, step.indexOf(':')), step.slice(step.indexOf(':') + 1)] : [step, '']
  if (name === 'wait') { await new Promise((resolve) => setTimeout(resolve, Number(arg))); continue }
  if (name === 'shot') {
    const res = await rpc(sock, { cmd: 'shot', name: `l566-${arg}` }, 20_000)
    if (!res.ok) throw new Error(`shot 실패 ${JSON.stringify(res)}`)
    fs.copyFileSync(res.file, path.join(out, `${arg}.png`))
    console.log(`shot ${arg}.png`)
    continue
  }
  if (name === 'key') { console.log(step, JSON.stringify(await rpc(sock, { cmd: 'key', keyCode: arg }))); continue }
  if (name === 'term') {
    const t = (await rpc(sock, { cmd: 'term-read' })).term
    const lines = t.lines.map((line, y) => ({ y, line: line.trimEnd() })).filter((x) => x.line.length > 0)
    fs.writeFileSync(path.join(out, `${arg}.term.json`), JSON.stringify({ cursorX: t.cursorX, cursorY: t.cursorY, cursorHidden: t.cursorHidden, cols: t.cols, rows: t.rows, lines, inputs: t.inputs.slice(-12) }, null, 1))
    console.log(`term ${arg} cursor=${t.cursorX},${t.cursorY}`)
    continue
  }
  // 가려진(백그라운드) 창은 rAF 가 멈춰 xterm DOM 이 늦게 갱신된다 — 재기 전에 capturePage 로 프레임을 한 번 밀어 준다(r0 실측: 확정 뒤 측정이 이전 커서 칸을 읽었다).
  if (name === 'measure') await rpc(sock, { cmd: 'shot', name: 'l566-frame-pump' }, 20_000)
  const code = name === 'update' ? js.update(arg) : js[name]
  if (code === undefined) throw new Error(`모르는 걸음 ${step}`)
  const result = await evalJs(`(() => { ${code} })()`)
  if (name === 'measure') {
    fs.writeFileSync(path.join(out, `${arg}.json`), JSON.stringify(result, null, 1))
    console.log(`measure ${arg}`)
  } else console.log(step, JSON.stringify(result))
}
