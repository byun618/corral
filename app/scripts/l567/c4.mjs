// LIFE-567 최종 관문 C4ⓐ~ⓓ — 개발 실행 한 인스턴스에서 셸 pane(실제 HOME 의 zsh) 하나를 열고 같은 조작을 각 3회 돈다.
// Claude 가 아니라 셸에서 도는 이유: ⓑ의 Enter 가 Claude 프롬프트 제출이 되지 않게(02-kickoff 안전 5). ⓐⓑ는 `cat -v` 안에서 해 받은 바이트를 그대로 보여 준다.
// 셸 명령은 전부 **앞에 공백**을 붙이고 처음에 ` fc -p` 로 파일 없는 히스토리로 바꾼다 — 사용자 zsh 가 histignorespace 라 공백 명령은 남지 않는다.
// (시험 t1·t2 가 남긴 사용자 히스토리 항목은 시간대·내용을 확인해 지웠다 — RESULT 최종 관문 절)
// URL 은 따옴표로 감싼다 — zsh url-quote-magic 이 URL 뒤 `;` 를 `\;` 로 바꾼다(t1).
// 기준선(0f4adb6bc)·수정본에 같은 명령을 돌려 결과 JSON 을 나란히 비교한다 — 이 스크립트는 수집기다(조작·계측 실패만 exit 1, 판정은 RESULT 에서).
// 읽기는 xterm 공개 API(React fiber 로 찾은 Terminal: buffer·getSelection·onData·options)와 DOM 만. 링크는 window.open 을 관측용으로 가로채
// 외부 브라우저를 열지 않는다. 조합은 실제 textarea 합성(G4), 키는 control `key`(webContents.sendInputEvent — OS 입력 아님).
// 사용: node c4.mjs <ctl.sock> <worktree 경로> <out 폴더> <이름>
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [sock, worktree, out, name] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const REPS = 3
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
class DriverFailure extends Error {}
const call = async (label, request) => {
  const res = await rpc(sock, request, 20_000)
  if (res?.ok !== true && res?.hit !== true) throw new DriverFailure(`${label}: ${JSON.stringify(res).slice(0, 300)}`)
  return res
}
const evalJs = async (code) => (await call('eval', { cmd: 'eval', code: `(() => { ${code} })()` })).result
const pump = () => call('pump', { cmd: 'shot', name: 'l567-frame-pump' })
const shot = async (label) => {
  const res = await call(`shot ${label}`, { cmd: 'shot', name: `l567-${label}` })
  if (typeof res.file !== 'string' || !fs.existsSync(res.file)) throw new DriverFailure(`shot ${label}: 파일 없음`)
  fs.copyFileSync(res.file, path.join(out, `${name}-${label}.png`))
}
const expect = (cond, message) => { if (!cond) throw new DriverFailure(message) }
const settle = async (ms = 1200) => { await pause(ms); await pump() }

// 렌더러 공통 머리 — 모든 pane 의 xterm 을 fiber 로 찾는다. sel = 선택된 pane(없으면 첫 pane).
const HEAD = `const findTerm = (el) => { const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$')); let fiber = key ? el[key] : null;
    for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) for (let hook = fiber.memoizedState; hook && typeof hook === 'object'; hook = hook.next) {
      const cur = hook.memoizedState && hook.memoizedState.current; if (cur && cur.buffer && cur.buffer.active && cur.element) return cur } return null };
  const hosts = Array.from(document.querySelectorAll('[data-term-pane]'));
  const selHost = document.querySelector('.term-pane.is-selected [data-term-pane]') ?? hosts[0];
  const sel = findTerm(selHost) || findTerm(selHost.querySelector('.xterm'));
  const ta = selHost.querySelector('.xterm-helper-textarea'); window.__l567 ??= { start: 0, data: [], opened: [] };
  const cellAt = (term, host, x, y) => { const r = host.querySelector('.xterm-screen').getBoundingClientRect(); return { clientX: r.left + (x + 0.5) * r.width / term.cols, clientY: r.top + (y + 0.5) * r.height / term.rows } };`
// 화면 정합 — pane 마다 baseY·viewportY, DOM 행 텍스트 = 버퍼 표시 범위 텍스트(끝 공백 무시)인지, 다른 행 수.
const CHECK = `${HEAD} return hosts.map((host) => { const term = findTerm(host) || findTerm(host.querySelector('.xterm')); const b = term.buffer.active;
    const dom = Array.from(host.querySelectorAll('.xterm-rows > div')).map((e) => e.textContent.trimEnd());
    const buf = Array.from({ length: term.rows }, (_, i) => b.viewportY + i < b.length ? (b.getLine(b.viewportY + i)?.translateToString(true) ?? '').trimEnd() : null);
    const mismatch = dom.map((t, i) => t === buf[i] ? null : { i, dom: t.slice(0, 40), buf: buf[i] === null ? null : buf[i].slice(0, 40) }).filter(Boolean);
    return { pane: host.dataset.termPane, cols: term.cols, rows: term.rows, baseY: b.baseY, viewportY: b.viewportY, length: b.length, domRows: dom.length,
      mismatches: mismatch.length, mismatchSample: mismatch.slice(0, 3), windowsPty: term.options.windowsPty ?? null } })`
const LINES = `${HEAD} const b = sel.buffer.active; return { cols: sel.cols, rows: sel.rows, cursorY: b.cursorY, baseY: b.baseY, viewportY: b.viewportY,
  lines: Array.from({ length: sel.rows }, (_, i) => (b.getLine(b.viewportY + i)?.translateToString(true) ?? '')) }`
const DATA_ON = `${HEAD} if (!window.__l567.dataHooked) { sel.onData((d) => window.__l567.data.push(d)); window.__l567.dataHooked = true }
  window.open = (u) => { window.__l567.opened.push(String(u)); return null }; return true`
const DATA_TAKE = `${HEAD} const d = window.__l567.data.splice(0); return d`
const FOCUS = `${HEAD} ta.focus(); return document.activeElement === ta`
const START = `${HEAD} ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Process', bubbles: true, cancelable: true }));
  window.__l567.start = ta.value.length; ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true })); return true`
const UPDATE = (ch) => `${HEAD} ta.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, key: 'Process', bubbles: true, cancelable: true }));
  ta.value = ta.value.slice(0, window.__l567.start) + ${JSON.stringify(ch)};
  ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: ${JSON.stringify(ch)}, bubbles: true }));
  ta.dispatchEvent(new InputEvent('input', { data: ${JSON.stringify(ch)}, inputType: 'insertCompositionText', isComposing: true, bubbles: true })); return ta.value`
const END = `${HEAD} const data = ta.value.slice(window.__l567.start); ta.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true })); return data`
const CANCEL = `${HEAD} ta.value = ta.value.slice(0, window.__l567.start);
  ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: '', bubbles: true }));
  ta.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true })); return ta.value`
// 드래그 선택 — 공개 getSelection 으로 읽는다. 시작 (0, y0) ~ 끝 (cols−1, y1).
const SELECT = (y0, y1) => `${HEAD} const s = selHost.querySelector('.xterm-screen'); const a = cellAt(sel, selHost, 0, ${y0}); const z = cellAt(sel, selHost, sel.cols - 1, ${y1});
  s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1, ...a }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, button: 0, buttons: 1, ...z }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, ...z }));
  const text = sel.getSelection(); sel.clearSelection(); return text`
// ⌘+클릭 — 링크 칸 위로 mousemove(링크 감지) → 감지(화면 커서 pointer)가 확인될 때까지 최대 5번 다시 움직인 뒤 바로 metaKey 로 mousedown·mouseup·click.
// (1회차는 400ms 고정 대기 뒤 클릭해 두 빌드 모두 6회 중 1회 열림 0 — 프롬프트 시계가 매초 프레임을 다시 그리면 감지가 풀린다. final/c4/try1)
const LINK_CLICK = (x, y) => `${HEAD} const s = selHost.querySelector('.xterm-screen'); const p = cellAt(sel, selHost, ${x}, ${y});
  window.__l567.opened.length = 0;
  const pointer = () => (s.style.cursor || getComputedStyle(s).cursor) === 'pointer' || selHost.querySelector('.xterm-screen').classList.contains('xterm-cursor-pointer');
  return new Promise((resolve) => { let tries = 0;
    const attempt = () => { tries++;
      s.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, ...p, metaKey: true }));
      setTimeout(() => {
        if (!pointer() && tries < 5) { attempt(); return }
        const detected = pointer();
        s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1, ...p, metaKey: true }));
        s.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, ...p, metaKey: true }));
        s.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...p, metaKey: true }));
        setTimeout(() => resolve({ tries, detected, opened: window.__l567.opened.slice() }), 200)
      }, 150) }
    attempt() })`

const record = { name, at: new Date().toISOString(), steps: [] }
const step = (label, value) => { record.steps.push({ label, at: Date.now(), value }); console.log(label, JSON.stringify(value).slice(0, 300)) }
const key = (keyCode, modifiers = []) => call(`key ${keyCode}`, { cmd: 'key', keyCode, modifiers })
const lines = () => evalJs(LINES)
const rowOf = (ls, pred) => ls.lines.findIndex(pred)

try {
  // --- 셸 pane 열기 -------------------------------------------------------
  await call('add-repo', { cmd: 'add-repo', root: worktree })
  const card = `[data-worktree="${worktree}"] [data-worktree-card-surface]`
  for (let i = 0; ; i++) { const q = await rpc(sock, { cmd: 'query', selector: card }); if ((q.found ?? []).length > 0) break; expect(i < 100, '사이드바 행 없음'); await pause(300) }
  await call('click card', { cmd: 'click', selector: card })
  for (let i = 0; ; i++) { const t = await rpc(sock, { cmd: 'term-read' }); if (t.ok) break; expect(i < 100, 'pane 없음'); await pause(300) }
  await settle(2500)
  step('hook', await evalJs(DATA_ON))
  step('focus', await evalJs(FOCUS))
  // 서버 scrollback·꽉 찬 두 줄·URL 을 찍는다(회차마다 다시 — 앞 조작이 줄을 밀어 올리므로)
  const drawScene = async () => {
    await call('type scene', { cmd: 'type', text: " clear; seq 1 150; printf 'A%.0s' $(seq $COLUMNS); echo; printf 'B%.0s' $(seq $COLUMNS); echo; echo 'https://example.com/l567-link'" })
    await key('Return')
    await settle(2500)
    await evalJs(DATA_TAKE)
  }
  // 이 셸의 히스토리를 파일 없는 새 목록으로 바꾼다 — ⓑ의 '한'+Enter 가 실수로 셸에 가도 사용자 히스토리 파일에 남지 않게(t2 에서 실제로 남았다 → 지움)
  await call('type fc', { cmd: 'type', text: ' fc -p' }); await key('Return'); await settle(800)
  await drawScene()
  const base = await lines()
  step('scene', { cols: base.cols, rows: base.rows, cursorY: base.cursorY, tail: base.lines.filter((l) => l.trim()).slice(-5) })
  expect(base.lines.some((l) => l.startsWith('https://example.com/l567-link')), 'URL 줄이 안 보인다')
  await shot('scene')

  // --- ⓐ 확정 문자열 1회 · ⓑ 조합 중 Enter·Esc·Backspace — cat -v 안에서 ----------
  // `cat` 은 사용자 셸에서 bat 별칭이다(t2) — command 로 진짜 cat 을 띄우고, 떠 있는지(커서 줄이 빈 줄) 확인한 뒤에만 조합을 보낸다
  await call('type cat', { cmd: 'type', text: ' command cat -v' }); await key('Return'); await settle(1000); await evalJs(DATA_TAKE)
  const inCat = await lines()
  expect((inCat.lines[inCat.cursorY] ?? 'x').trim() === '', `cat -v 가 안 떠 있다: ${JSON.stringify(inCat.lines[inCat.cursorY])}`)
  const typing = []
  for (let r = 1; r <= REPS; r++) {
    for (const mode of ['commit', 'Return', 'Escape', 'Backspace']) {
      await evalJs(DATA_TAKE)
      await evalJs(START)
      for (const ch of ['ㅎ', '하', '한']) await evalJs(UPDATE(ch))
      if (mode === 'commit') await evalJs(END)
      else { await key(mode); await pause(100); await evalJs(CANCEL) }
      await settle(500)
      const sent = await evalJs(DATA_TAKE)
      const cur = await lines()
      const lineText = cur.lines[cur.cursorY] ?? ''
      // 줄을 마치고(cat 이 받은 줄을 되찍음) 다음 회차를 깨끗한 줄에서 시작한다
      await key('Return'); await settle(500)
      const after = await evalJs(DATA_TAKE)
      const echoed = (await lines()).lines.filter((l) => l.trim()).slice(-3)
      typing.push({ r, mode, sent, cursorLine: lineText, hanCountOnLine: (lineText.match(/한/g) ?? []).length, afterReturn: after, echoed })
      step(`typing ${mode} r${r}`, typing[typing.length - 1])
    }
  }
  record.typing = typing
  await key('C', ['control']); await settle(800); await evalJs(DATA_TAKE)

  // --- ⓒ 휠(서버 scrollback) · 선택 · ⌘+클릭 링크 -----------------------------
  const wheel = [], selection = [], links = []
  const doSelectAndLink = async (phase, r) => {
    const ls = await lines()
    const ya = rowOf(ls, (l) => /^A{10,}$/.test(l.trim())), yb = rowOf(ls, (l) => /^B{10,}$/.test(l.trim())), yu = rowOf(ls, (l) => l.startsWith('https://example.com/l567-link'))
    expect(ya >= 0 && yb === ya + 1 && yu >= 0, `선택·링크 장면 행 못 찾음 A${ya} B${yb} U${yu}`)
    const text = await evalJs(SELECT(ya, yb))
    // 끝 칸(cols−1) 가운데까지 끌면 xterm 선택은 끝 칸을 빼므로 B 는 cols−1 칸이다(t3 실측 — 두 빌드 같은 조작)
    const expected = `${'A'.repeat(ls.cols)}\n${'B'.repeat(ls.cols - 1)}`
    selection.push({ phase, r, cols: ls.cols, rowA: ya, text, expected, equalsExpected: text === expected })
    const link = await evalJs(LINK_CLICK(5, yu))
    links.push({ phase, r, row: yu, ...link })
    step(`select+link ${phase} r${r}`, { sel: selection[selection.length - 1].equalsExpected, link })
  }
  for (let r = 1; r <= REPS; r++) {
    await drawScene()
    const top0 = (await lines()).lines[0]
    await call('wheel up', { cmd: 'wheel', deltaY: -160 }); await settle(1000)
    const up = await lines()
    await call('wheel down', { cmd: 'wheel', deltaY: 160 }); await settle(1000)
    const down = await lines()
    wheel.push({ r, topBefore: top0, topAfterUp: up.lines[0], baseYUp: up.baseY, viewportYUp: up.viewportY, topAfterDown: down.lines[0], backToBottom: down.lines[0] === top0 })
    step(`wheel r${r}`, wheel[wheel.length - 1])
    await doSelectAndLink('steady', r)
    // 열 축소·복원 뒤(서버가 다시 그린 뒤) 같은 선택·링크 — reflow 를 끈 영향이 여기서 갈린다
    const st = await evalJs(`${HEAD} return { w: window.outerWidth, h: window.outerHeight }`)
    await call('shrink', { cmd: 'resize-window', width: st.w - 40, height: st.h }); await settle(1500)
    await call('restore', { cmd: 'resize-window', width: st.w, height: st.h }); await settle(1500)
    await doSelectAndLink('after-shrink-restore', r)
  }
  record.wheel = wheel; record.selection = selection; record.links = links

  // --- ⓓ 분할·닫기·창 축소·확대 뒤 화면 정합 ---------------------------------
  const layout = []
  const check = async (label) => { await settle(1800); const panes = await evalJs(CHECK); layout.push({ label, panes }); step(`layout ${label}`, panes.map((p) => ({ cols: p.cols, rows: p.rows, baseY: p.baseY, viewportY: p.viewportY, mismatches: p.mismatches }))); return panes }
  for (let r = 1; r <= REPS; r++) {
    const st = await evalJs(`${HEAD} return { w: window.outerWidth, h: window.outerHeight }`)
    await key('D', ['meta']); const split = await check(`split r${r}`); expect(split.length === 2, `분할 뒤 pane ${split.length}개`)
    await shot(`split-r${r}`)
    await call('shrink', { cmd: 'resize-window', width: st.w - 200, height: st.h - 100 }); await check(`split+shrink r${r}`)
    await call('enlarge', { cmd: 'resize-window', width: st.w + 120, height: st.h + 60 }); await check(`split+enlarge r${r}`)
    await call('restore', { cmd: 'resize-window', width: st.w, height: st.h })
    await key('W', ['meta']); const closed = await check(`close r${r}`); expect(closed.length === 1, `닫기 뒤 pane ${closed.length}개`)
    await shot(`close-r${r}`)
  }
  record.layout = layout
} catch (error) {
  record.failure = { message: String(error?.message ?? error), driver: error instanceof DriverFailure }
  console.error(`실패: ${record.failure.message}`)
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(record, null, 1))
  process.exit(1)
}
fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(record, null, 1))
