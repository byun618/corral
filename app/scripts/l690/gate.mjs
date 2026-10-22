// LIFE-690 최종 관문 G3·G4·G5 — 개발 실행 한 세션 안에서 기준선 렌더러 → 수정본 렌더러 순으로 회차를 돌리고 종료코드로 판정한다.
// 0 = 모든 기대 걸음 통과, 1 = 하나라도 어긋남, 2 = rpc 실패·중단. 걸음별 판정은 <out>/checks.json, 회차별 링·화면·스크린샷은 <out>/<회차>.*.
// 사용(app/ 에서, dev-up.sh 로 기준선 out 을 띄운 뒤): node scripts/l690/gate.mjs <ctl.sock> <out 폴더> <worktree> <수정본 renderer 폴더>
//
// 주입 (02-kickoff 격리 4 — OS 입력·입력 소스 전환 없음):
// - 조합: 선택된 pane 의 xterm textarea 에 DOM composition·input 합성. G4 회차는 keydown(229) → compositionend → keydown(Enter, keyCode 13,
//   isComposing=false) 를 **한 eval 안의 동기 dispatch** 로 낸다(xterm 의 조합 전송 setTimeout(0) 이 그 사이에 돌 수 없다).
// - 그 밖의 글자·키: control `type`/`key` = webContents.sendInputEvent(Chromium 입력 경로).
// - 빌드 전환: app/out/renderer 를 수정본 사본으로 바꾸고 location.reload() — main·herdr 세션·pane 의 Claude Code 는 그대로다.
import fs from 'node:fs'
import path from 'node:path'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [sock, out, worktree, fixRenderer] = process.argv.slice(2)
if (!sock || !out || !worktree || !fixRenderer) {
  console.error('사용: node scripts/l690/gate.mjs <ctl.sock> <out> <worktree> <수정본 renderer 폴더>')
  process.exit(2)
}
fs.mkdirSync(out, { recursive: true })
const CSI = '\x1b[13;2u'
const checks = []
const save = () => fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 1))
const abort = (message) => {
  checks.push({ step: 'abort', pass: false, message })
  save()
  console.error(`ABORT ${message}`)
  process.exit(2)
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const call = async (request, timeout = 20_000) => {
  let res
  try {
    res = await rpc(sock, request, timeout)
  } catch (error) {
    abort(`${request.cmd} 예외 ${error.message}`)
  }
  if (!res || res.ok !== true) abort(`${request.cmd} 실패 ${JSON.stringify(res).slice(0, 300)}`)
  return res
}
const evalJs = async (code) => (await call({ cmd: 'eval', code: `(() => { ${code} })()` })).result
const type = (text) => call({ cmd: 'type', text })
const key = (keyCode, modifiers = []) => call({ cmd: 'key', keyCode, modifiers })
const read = async () => {
  const term = (await call({ cmd: 'term-read' })).term
  if (!term || !Array.isArray(term.inputs) || !Array.isArray(term.lines)) abort('term-read 빈 결과')
  return term
}
const record = (step, pass, detail) => {
  checks.push({ step, pass, ...detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${step} ${JSON.stringify(detail).slice(0, 400)}`)
}
async function until(fn, label, timeout = 30_000) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) abort(`시간 초과: ${label}`)
    await pause(300)
  }
}

// --- 렌더러 안 합성 (선택된 pane 의 textarea) ------------------------------------------------
const HEAD = `const host = document.querySelector('.term-pane.is-selected [data-term-pane]') ?? document.querySelector('[data-term-pane]');
  const ta = host.querySelector('.xterm-helper-textarea'); window.__l690 ??= { start: 0 };
  const kd = (init, keyCode) => { const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); Object.defineProperty(e, 'keyCode', { value: keyCode }); ta.dispatchEvent(e); return e.defaultPrevented };`
const ime = {
  focus: `${HEAD} ta.focus(); return { active: document.activeElement === ta, hasFocus: document.hasFocus() }`,
  start: `${HEAD} kd({ key: 'Process' }, 229); window.__l690.start = ta.value.length;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true })); return { start: window.__l690.start }`,
  update: (ch, shiftKey = false) => `${HEAD} kd({ key: 'Process', shiftKey: ${shiftKey} }, 229);
    ta.value = ta.value.slice(0, window.__l690.start) + ${JSON.stringify(ch)};
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: ${JSON.stringify(ch)}, bubbles: true }));
    ta.dispatchEvent(new InputEvent('input', { data: ${JSON.stringify(ch)}, inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
    return { value: ta.value.slice(window.__l690.start) }`,
  end: `${HEAD} const data = ta.value.slice(window.__l690.start);
    ta.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true })); return { committed: data }`,
  /** G4 — 조합 중 (Shift+)Enter: keydown(229) → compositionend → keydown(13, isComposing=false) 를 한 동기 실행 안에서. */
  endEnter: (shiftKey) => `${HEAD} const data = ta.value.slice(window.__l690.start);
    kd({ key: 'Process', shiftKey: ${shiftKey}, isComposing: true }, 229);
    ta.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true }));
    const prevented = kd({ key: 'Enter', code: 'Enter', shiftKey: ${shiftKey} }, 13);
    return { committed: data, enterPrevented: prevented, sameTask: true }`,
  /** 정보용 스트레스 변형 — 같은 eval 안에서 Shift+Enter 뒤 untrusted `d`(keydown+keypress)까지. 통과선 아님. */
  endShiftEnterThenD: `${HEAD} const data = ta.value.slice(window.__l690.start);
    kd({ key: 'Process', shiftKey: true, isComposing: true }, 229);
    ta.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true }));
    kd({ key: 'Enter', code: 'Enter', shiftKey: true }, 13);
    kd({ key: 'd', code: 'KeyD' }, 68);
    const kp = new KeyboardEvent('keypress', { key: 'd', code: 'KeyD', charCode: 100, bubbles: true, cancelable: true });
    Object.defineProperty(kp, 'charCode', { value: 100 }); Object.defineProperty(kp, 'keyCode', { value: 100 }); Object.defineProperty(kp, 'which', { value: 100 });
    ta.dispatchEvent(kp); return { committed: data }`,
  /** C3ⓔ — 조합 중 Shift keydown(16·229) 뒤 자모가 쌍자음으로 바뀐다. */
  shiftDouble: (ch) => `${HEAD} kd({ key: 'Shift', shiftKey: true, isComposing: true }, 16); kd({ key: 'Shift', shiftKey: true, isComposing: true }, 229);
    kd({ key: 'Process', shiftKey: true, isComposing: true }, 229);
    ta.value = ta.value.slice(0, window.__l690.start) + ${JSON.stringify(ch)};
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: ${JSON.stringify(ch)}, bubbles: true }));
    ta.dispatchEvent(new InputEvent('input', { data: ${JSON.stringify(ch)}, inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
    return { value: ta.value.slice(window.__l690.start) }`,
}
const step = async (label, code) => {
  const result = await evalJs(code)
  console.log(`ime ${label} ${JSON.stringify(result)}`)
  return result
}
/** 조합을 시작해 자모 단계별로 진행(각 단계는 따로 eval — 실제 타자처럼 태스크가 갈린다). */
const compose = async (stages) => {
  await step('start', ime.start)
  for (const ch of stages) await step(`update:${ch}`, ime.update(ch))
}

// --- 링·화면 ----------------------------------------------------------------------------------
let markAt = 0
const mark = async () => {
  const t = await read()
  markAt = t.inputs.at(-1)?.at ?? 0
  await pause(20)
}
const snapshot = async (label) => {
  const t = await read()
  const items = t.inputs.filter((item) => item.at > markAt)
  const lines = t.lines.map((line, y) => ({ y, line: line.trimEnd() })).filter((x) => x.line.length > 0)
  fs.writeFileSync(path.join(out, `${label}.ring.json`), JSON.stringify({ markAt, paneId: t.paneId, items }, null, 1))
  fs.writeFileSync(path.join(out, `${label}.term.json`), JSON.stringify({ paneId: t.paneId, cursorX: t.cursorX, cursorY: t.cursorY, cols: t.cols, rows: t.rows, lines }, null, 1))
  await call({ cmd: 'shot', name: 'l690-frame-pump' })
  const shot = await call({ cmd: 'shot', name: `l690-${label}` })
  fs.copyFileSync(shot.file, path.join(out, `${label}.png`))
  return { joined: items.map((item) => item.data).join(''), items: items.map((item) => item.data), lines: lines.map((x) => x.line) }
}
const expectRing = (label, snap, expected) => record(`${label} ring`, snap.joined === expected, { expected, actual: snap.joined, items: snap.items })
const expectScreen = (label, snap, pattern, present = true) => {
  const hits = snap.lines.filter((line) => new RegExp(pattern).test(line))
  record(`${label} ${present ? 'screen' : 'noscreen'}`, present ? hits.length > 0 : hits.length === 0, { pattern, hits })
}
const info = (label, snap) => {
  checks.push({ step: `${label} (정보용)`, pass: true, info: true, actual: snap.joined, items: snap.items })
  console.log(`INFO ${label} ${JSON.stringify(snap.joined)}`)
}
/** Claude Code 입력줄 비우기 — 내용이 있을 때 Ctrl+C 1회(빈 줄에서 두 번이면 종료라 한 번만). */
const clearClaude = async (label) => {
  await key('c', ['control'])
  await pause(800)
  const t = await read()
  const prompt = t.lines.map((line) => line.trimEnd()).filter((line) => /^❯/.test(line))
  console.log(`clear ${label} prompt=${JSON.stringify(prompt)}`)
}

const settleMs = 1500
const USER = 'ㅁㄴ어미나언마ㅣ'

// === 0. pane 열기 (셸) ===
await call({ cmd: 'add-repo', root: worktree })
const card = `[data-worktree="${worktree}"] [data-worktree-card-surface]`
await until(async () => ((await call({ cmd: 'query', selector: card })).found ?? []).length > 0, '사이드바 행')
const click = await call({ cmd: 'click', selector: card })
if (!click.hit) abort(`행 클릭 실패 ${JSON.stringify(click).slice(0, 200)}`)
await until(async () => (await rpc(sock, { cmd: 'term-read' }, 20_000)).term, 'pane')
await pause(2500)
const bundle = async (label) => {
  const src = await evalJs(`return Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src'))`)
  fs.writeFileSync(path.join(out, `${label}.bundle.json`), JSON.stringify(src))
  console.log(`bundle ${label} ${JSON.stringify(src)}`)
  return src
}
const baseBundle = await bundle('base')

/** C3ⓑ 셸 회차 — 조합 중 Enter(`echo l690-ime ㅇ`)·비조합 Enter(`echo l690-plain`). 셸이라 제출해도 무해. */
const shellEnter = async (phase) => {
  await step('focus', ime.focus)
  await mark()
  await type('echo l690-ime ')
  await pause(300)
  await compose(['ㅇ'])
  await step('endEnter', ime.endEnter(false))
  await pause(settleMs)
  const ime1 = await snapshot(`${phase}-c3b-ime-enter`)
  expectRing(`${phase} C3ⓑ 조합 중 Enter`, ime1, 'echo l690-ime ㅇ\r')
  expectScreen(`${phase} C3ⓑ 조합 중 Enter`, ime1, '^l690-ime ㅇ$')
  await mark()
  await type('echo l690-plain')
  await key('Return')
  await pause(settleMs)
  const plain = await snapshot(`${phase}-c3b-plain-enter`)
  expectRing(`${phase} C3ⓑ 비조합 Enter`, plain, 'echo l690-plain\r')
  expectScreen(`${phase} C3ⓑ 비조합 Enter`, plain, '^l690-plain$')
  return { ime: ime1.joined, plain: plain.joined }
}

// === 1. 기준선 (25d4fc301 렌더러) ===
const baseShell = await shellEnter('base')
await type('claude')
await key('Return')
await until(async () => (await read()).lines.some((line) => /^❯/.test(line)), 'Claude Code 입력줄', 60_000)
await pause(2000)
await step('focus', ime.focus)

// C1ⓑ — 결함이 보여야 한다(양성 대조): CSI-u 가 마지막 조합 글자보다 앞.
await mark()
await type(USER)
await pause(300)
await compose(['ㅇ'])
await step('endEnter', ime.endEnter(true))
await pause(settleMs)
const c1b = await snapshot('base-c1b')
expectRing('base C1ⓑ 결함 재현', c1b, `${USER}${CSI}ㅇ`)
expectScreen('base C1ⓑ 둘째 줄 ㅇ', c1b, '^\\s+ㅇ$')
await clearClaude('base-c1b')

// 기준선 `한` — 같은 결함(참고 대조).
await mark()
await compose(['ㅎ', '하', '한'])
await step('endEnter', ime.endEnter(true))
await pause(settleMs)
const c1bHan = await snapshot('base-c1b-han')
expectRing('base C1ⓑ 한 결함 재현', c1bHan, `${CSI}한`)
await clearClaude('base-c1b-han')

// === 2. 수정본 렌더러로 전환 (같은 main·herdr 세션·Claude Code) ===
const rendererDir = path.join(process.cwd(), 'out', 'renderer')
fs.rmSync(rendererDir, { recursive: true, force: true })
fs.cpSync(fixRenderer, rendererDir, { recursive: true })
await evalJs(`setTimeout(() => location.reload(), 50); return true`)
await pause(3000)
await until(async () => {
  const res = await rpc(sock, { cmd: 'query', selector: card }, 20_000).catch(() => null)
  return (res?.found ?? []).length > 0
}, '재적재 뒤 사이드바 행')
const selected = await evalJs(`return document.querySelector('.term-pane.is-selected [data-term-pane]') !== null || document.querySelector('[data-term-pane]') !== null`)
if (!selected) {
  const again = await call({ cmd: 'click', selector: card })
  if (!again.hit) abort('재적재 뒤 행 클릭 실패')
}
await until(async () => (await read()).lines.some((line) => /^❯/.test(line)), '재적재 뒤 Claude Code 입력줄', 30_000)
await pause(1500)
const fixBundle = await bundle('fix')
record('빌드 전환 — 번들이 바뀌었다', JSON.stringify(baseBundle) !== JSON.stringify(fixBundle), { base: baseBundle, fix: fixBundle })
await step('focus', ime.focus)

// C2ⓑ — 사용자 재현.
await mark()
await type(USER)
await pause(300)
await compose(['ㅇ'])
await step('endEnter', ime.endEnter(true))
await pause(settleMs)
const c2b = await snapshot('fix-c2b')
expectRing('fix C2ⓑ', c2b, `${USER}ㅇ${CSI}`)
expectScreen('fix C2ⓑ 첫 줄 끝 ㅇ', c2b, `^❯\\s${USER}ㅇ$`)
expectScreen('fix C2ⓑ 둘째 줄에 ㅇ 없음', c2b, '^\\s+ㅇ$', false)
expectScreen('fix C2ⓑ 제출 안 됨', c2b, '^⏺', false)
await clearClaude('fix-c2b')

// C2ⓒ — 완성 음절.
await mark()
await compose(['ㅎ', '하', '한'])
await step('endEnter', ime.endEnter(true))
await pause(settleMs)
const c2c = await snapshot('fix-c2c')
expectRing('fix C2ⓒ', c2c, `한${CSI}`)
expectScreen('fix C2ⓒ 첫 줄 한', c2c, '^❯\\s한$')
await clearClaude('fix-c2c')

// C3ⓐ — 비조합 Shift+Enter (sendInputEvent).
await mark()
await type('abc')
await key('Return', ['shift'])
await pause(settleMs)
const c3a = await snapshot('fix-c3a')
expectRing('fix C3ⓐ', c3a, `abc${CSI}`)
await clearClaude('fix-c3a')

// C3ⓒ — 비조합 연속 입력, 쉬지 않고.
await mark()
await type('abc')
await key('Return', ['shift'])
await type('def')
await pause(settleMs)
const c3c = await snapshot('fix-c3c')
expectRing('fix C3ⓒ', c3c, `abc${CSI}def`)
expectScreen('fix C3ⓒ 둘째 줄 def', c3c, '^\\s+def$')
await clearClaude('fix-c3c')

// C3ⓕ — 지연 경로 직후 연속 입력: 조합 Shift+Enter eval 이 돌아오자마자(기다리지 않고) def 를 sendInputEvent 로.
await mark()
await compose(['ㅎ', '하', '한'])
await evalJs(ime.endEnter(true))
await type('def')
await pause(settleMs)
const c3f = await snapshot('fix-c3f')
expectRing('fix C3ⓕ', c3f, `한${CSI}def`)
expectScreen('fix C3ⓕ 둘째 줄 def', c3f, '^\\s+def$')
await clearClaude('fix-c3f')

// C3ⓔ — Shift 쌍자음: 줄바꿈 시퀀스 0.
await mark()
await compose(['ㅅ'])
await step('shiftDouble', ime.shiftDouble('ㅆ'))
await pause(300)
await step('end', ime.end)
await pause(settleMs)
const c3e = await snapshot('fix-c3e')
expectRing('fix C3ⓔ', c3e, 'ㅆ')
await clearClaude('fix-c3e')

// 정보용 — 같은 eval 안의 untrusted d (통과선 아님).
await mark()
await compose(['ㅎ', '하', '한'])
await step('endShiftEnterThenD', ime.endShiftEnterThenD)
await pause(settleMs)
info('fix 스트레스 같은 eval 안 d', await snapshot('fix-stress-same-eval-d'))
await clearClaude('fix-stress')

// === 3. Claude Code 닫고 셸 C3ⓑ (수정본) ===
await type('/exit')
await pause(500)
await key('Return')
await until(async () => (await read()).lines.some((line) => /Resume this session|claude --resume/.test(line)), 'Claude Code 종료', 30_000)
await pause(1500)
await snapshot('fix-claude-exit')
const fixShell = await shellEnter('fix')
record('C3ⓑ 링 기준선 = 수정본', JSON.stringify(baseShell) === JSON.stringify(fixShell), { base: baseShell, fix: fixShell })

save()
const failed = checks.filter((check) => !check.pass)
console.log(`checks ${checks.length - failed.length}/${checks.length} pass`)
process.exit(failed.length === 0 ? 0 : 1)
