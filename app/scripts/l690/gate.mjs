// LIFE-690 최종 관문 G3·G4·G5 — 같은 herdr l690 서버 위에서 기준선 빌드 → (Electron 재기동) → 수정본 빌드 순으로 회차를 돌리고 종료코드로 판정한다.
// 0 = 모든 기대 걸음 통과, 1 = 하나라도 어긋남, 2 = 무효·중단(rpc 실패, 번들 정체 불일치, 재기동 실패 등 — 판정 칸에 넣지 않는다).
// 걸음별 판정은 <ROOT>/gate/checks.json, 회차별 링·화면·스크린샷은 <ROOT>/gate/<회차>.*, 보낸 키는 keys.json, 혼입 대조는 input-audit.json.
// 사용(app/ 에서, dev-up.sh 로 기준선 out 을 띄운 뒤): node scripts/l690/gate.mjs <ROOT=/tmp/l690-*> <worktree>
//   빌드 사본은 L690_OUT_BASE·L690_OUT_FIX(기본 /tmp/l690-out-base·/tmp/l690-out-fix — prep.sh 가 만든다).
//
// 주입 (02-kickoff 격리 4 — OS 입력·입력 소스 전환 없음):
// - 조합: 선택된 pane 의 xterm textarea 에 DOM composition·input 합성. G4 회차는 keydown(229) → compositionend → keydown(Enter, keyCode 13,
//   isComposing=false) 를 **한 eval 안의 동기 dispatch** 로 낸다(xterm 의 조합 전송 setTimeout(0) 이 그 사이에 돌 수 없다).
// - 그 밖의 글자·키: control `type`/`key` = webContents.sendInputEvent(Chromium 입력 경로).
// - 빌드 전환(f2): Electron 만 PID 로 끄고 app/out 을 수정본 사본으로 바꿔 같은 userData 로 다시 띄운다(app-restart.sh). herdr l690 서버는 살려 둔다.
//   f1 의 렌더러 location.reload() 는 main 의 will-navigate 가드가 막아 수정본이 실리지 않았다(f1 final/corral.ndjson 652) — 그 경로는 지웠다.
// - 번들 정체(f2): 기준선·수정본 회차 직전에 페이지가 실은 스크립트 src 가 그 빌드 사본 index.html 의 것과 같아야 한다. 다르면 회차 없이 exit 2.
// - 셸 C3ⓑ(f2): Claude Code 탭과 따로 연 셸 탭(⌘T)에서 기준선·수정본 둘 다 돈다 — Claude Code 종료(f1 의 /exit 시간 초과)에 기대지 않는다.
// - 혼입 대조(f2): 드라이버가 보낸 `key` 를 keys.json 에 적고, 격리 로그 input.raw 전량이 그것과 순서·개수로 맞는지 input-audit.mjs 로 본다.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { audit } from './input-audit.mjs'

const [root, worktree] = process.argv.slice(2)
if (!root || !worktree || !root.startsWith('/tmp/l690-')) {
  console.error('사용: node scripts/l690/gate.mjs <ROOT=/tmp/l690-*> <worktree>')
  process.exit(2)
}
const sock = path.join(root, 'ctl.sock')
const out = path.join(root, 'gate')
const OUT_BASE = process.env.L690_OUT_BASE ?? '/tmp/l690-out-base'
const OUT_FIX = process.env.L690_OUT_FIX ?? '/tmp/l690-out-fix'
fs.mkdirSync(out, { recursive: true })
const CSI = '\x1b[13;2u'
const checks = []
/** 드라이버가 보낸 control `key` 요청(= sendInputEvent keyDown·keyUp) 순서 그대로 — 혼입 대조의 기대 목록. */
const sentKeys = []
const save = () => {
  fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(checks, null, 1))
  fs.writeFileSync(path.join(out, 'keys.json'), JSON.stringify(sentKeys, null, 1))
}
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
const key = (keyCode, modifiers = []) => {
  sentKeys.push({ keyCode, modifiers, at: Date.now() })
  return call({ cmd: 'key', keyCode, modifiers })
}
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

// --- pane·탭·번들 --------------------------------------------------------------------------
const card = `[data-worktree="${worktree}"] [data-worktree-card-surface]`
/** worktree 행을 눌러 그 pane 을 연다(첫 기동·재기동 뒤). */
const openWorktree = async () => {
  await until(async () => {
    const res = await rpc(sock, { cmd: 'query', selector: card }, 20_000).catch(() => null)
    return (res?.found ?? []).length > 0
  }, '사이드바 행')
  const click = await call({ cmd: 'click', selector: card })
  if (!click.hit) abort(`행 클릭 실패 ${JSON.stringify(click).slice(0, 200)}`)
  await until(async () => (await rpc(sock, { cmd: 'term-read' }, 20_000).catch(() => null))?.term, 'pane')
  await pause(2500)
}
const tabs = () => evalJs(`return Array.from(document.querySelectorAll('[data-main-tab]')).filter((el) => el.getAttribute('data-file-tab') === null)
  .map((el) => ({ id: el.getAttribute('data-main-tab'), active: el.getAttribute('data-active') === 'true' }))`)
const activeTab = async () => (await tabs()).find((tab) => tab.active)?.id ?? null
/** 탭을 눌러 고르고 그 pane 의 textarea 에 포커스를 둔다. */
const selectTab = async (id) => {
  const res = await call({ cmd: 'click', selector: `[data-main-tab="${id}"]` })
  if (!res.hit) abort(`탭 ${id} 클릭 실패`)
  await until(async () => (await activeTab()) === id, `탭 ${id} 활성`, 10_000)
  await pause(800)
  await step('focus', ime.focus)
}
/** 번들 정체 — 페이지가 실은 스크립트 src 가 빌드 사본 index.html 의 것과 같아야 한다. 다르면 회차를 돌리지 않고 exit 2. */
const expectBundle = async (label, copy) => {
  const html = fs.readFileSync(path.join(copy, 'renderer', 'index.html'), 'utf8')
  const expected = Array.from(html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)).map((m) => m[1])
  const loaded = await evalJs(`return Array.from(document.querySelectorAll('script[src]')).map((s) => s.getAttribute('src'))`)
  const files = expected.map((src) => fs.existsSync(path.join(copy, 'renderer', src)))
  const detail = { copy, build: fs.readFileSync(path.join(copy, '.l690-build'), 'utf8').trim(), expected, loaded, filesExist: files }
  fs.writeFileSync(path.join(out, `${label}.bundle.json`), JSON.stringify(detail, null, 1))
  const pass = expected.length > 0 && JSON.stringify(expected) === JSON.stringify(loaded) && files.every(Boolean)
  record(`${label} 번들 정체 = ${copy}`, pass, detail)
  if (!pass) abort(`${label} 번들 정체 불일치 — 회차 무효`)
}

// === 0. pane 열기 · 번들 정체(기준선) · 셸 탭 ===
await call({ cmd: 'add-repo', root: worktree })
await openWorktree()
await expectBundle('base', OUT_BASE)
const claudeTab = await activeTab()
if (claudeTab === null) abort('활성 탭 없음')
// 셸 C3ⓑ 전용 탭 — ⌘T(control key = sendInputEvent, l507 k2 와 같은 길). Claude Code 탭과 갈라 둬서 Claude Code 종료에 기대지 않는다.
const before = (await tabs()).map((tab) => tab.id)
await key('t', ['meta'])
const shellTab = await until(async () => {
  const now = await tabs()
  const fresh = now.find((tab) => !before.includes(tab.id) && tab.active)
  return fresh?.id ?? null
}, '⌘T 새 셸 탭', 15_000)
await until(async () => (await read()).lines.some((line) => line.trim().length > 0), '셸 탭 프롬프트', 20_000)
await pause(2500)
console.log(`tabs claude=${claudeTab} shell=${shellTab}`)

/** C3ⓑ 셸 회차 — 조합 중 Enter(`echo l690-ime ㅇ`)·비조합 Enter(`echo l690-plain`). 셸이라 제출해도 무해. */
const shellEnter = async (phase) => {
  await selectTab(shellTab)
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
await selectTab(claudeTab)
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

// === 2. 수정본 빌드로 전환 — Electron 재기동(같은 userData·같은 herdr l690 서버) ===
save()
try {
  execFileSync('sh', ['scripts/l690/app-restart.sh', root, OUT_FIX, 'base'], { stdio: 'inherit' })
} catch (error) {
  abort(`Electron 재기동 실패 ${error.status ?? error.message}`)
}
await openWorktree()
await expectBundle('fix', OUT_FIX)
const tabsAfter = (await tabs()).map((tab) => tab.id)
record('재기동 뒤 두 탭이 이어졌다', tabsAfter.includes(claudeTab) && tabsAfter.includes(shellTab), { claudeTab, shellTab, tabsAfter })
if (!tabsAfter.includes(claudeTab) || !tabsAfter.includes(shellTab)) abort('재기동 뒤 탭이 없다')
await selectTab(claudeTab)
// Claude Code 가 이어졌는지 — Ctrl+L(제출 아님: Claude Code·셸 둘 다 화면 다시 그리기)로 화면을 다시 받은 뒤 입력줄을 본다.
await key('l', ['control'])
await pause(1500)
let claudeContinued = (await read()).lines.some((line) => /^❯/.test(line))
if (!claudeContinued) {
  await pause(3000)
  claudeContinued = (await read()).lines.some((line) => /^❯/.test(line))
}
checks.push({ step: '재기동 뒤 Claude Code 세션 이어짐 (정보용)', pass: true, info: true, continued: claudeContinued })
console.log(`INFO Claude Code 이어짐 ${claudeContinued}`)
if (!claudeContinued) {
  // 이어지지 않았다 — 셸 프롬프트일 때만 새로 띄운다(Claude Code 입력줄에 `claude` 를 쳐서 제출하지 않게).
  // 사용자 zsh 프롬프트는 `… <브랜치> >` 뒤에 오른쪽 시각이 붙는다(f1 base-c3b-plain-enter.png) — ` > ` 또는 줄 끝 $%#>.
  const shellPrompt = (await read()).lines.some((line) => /\s>\s|[$%#>]\s*$/.test(line.trimEnd()))
  if (!shellPrompt) abort('재기동 뒤 Claude Code 입력줄도 셸 프롬프트도 안 보인다')
  await type('claude')
  await key('Return')
  await until(async () => (await read()).lines.some((line) => /^❯/.test(line)), '수정본 쪽 새 Claude Code 입력줄', 60_000)
  await pause(2000)
}
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

// === 3. 셸 C3ⓑ (수정본, 같은 셸 탭) ===
const fixShell = await shellEnter('fix')
record('C3ⓑ 링 기준선 = 수정본', JSON.stringify(baseShell) === JSON.stringify(fixShell), { base: baseShell, fix: fixShell })

// === 4. Claude Code 닫기 (02-kickoff 안전 5) — 정보용. 판정은 여기 기대지 않는다(f1 /exit 시간 초과). 못 닫혀도 dev-down 이 herdr l690 을 내린다.
await selectTab(claudeTab)
await type('/exit')
await pause(800)
await key('Return')
const exitStart = Date.now()
let exited = false
while (Date.now() - exitStart < 15_000) {
  const lines = (await read()).lines
  if (!lines.some((line) => /^❯/.test(line)) || lines.some((line) => /Resume this session|claude --resume/.test(line))) {
    exited = true
    break
  }
  await pause(500)
}
const exitSnap = await snapshot('fix-claude-exit')
checks.push({ step: 'Claude Code /exit (정보용)', pass: true, info: true, exited, lines: exitSnap.lines.slice(-12) })
console.log(`INFO /exit exited=${exited}`)

// === 5. 사용자 입력 혼입 대조 — input.raw 전량 ↔ 드라이버 key (기준선 구간 + 수정본 구간) ===
await pause(1500)
const logs = [path.join(root, 'corral.base.ndjson'), path.join(root, 'corral.ndjson')].map((file) => fs.readFileSync(file, 'utf8'))
const inputAudit = audit({ logs, sentKeys })
fs.writeFileSync(path.join(out, 'input-audit.json'), JSON.stringify(inputAudit, null, 1))
record('사용자 입력 혼입 없음 (input.raw ↔ 드라이버 key)', inputAudit.pass, {
  raw: inputAudit.raw,
  expected: inputAudit.expected,
  keyRequests: inputAudit.keyRequests,
  sentKeys: inputAudit.sentKeys,
  sentMatch: inputAudit.sentMatch,
  firstMismatch: inputAudit.firstMismatch,
})

save()
const failed = checks.filter((check) => !check.pass)
console.log(`checks ${checks.length - failed.length}/${checks.length} pass`)
process.exit(failed.length === 0 ? 0 : 1)
