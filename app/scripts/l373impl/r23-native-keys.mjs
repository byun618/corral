// R23 — **진짜 OS 키 이벤트**로만 갈리는 것 세 가지 (F2-5a · 코디네이터 R23 요구).
//
// `webContents.sendInputEvent`(제어 채널 `key`)는 main 의 `before-input-event` 는 지나지만
// **네이티브 메뉴 액셀러레이터는 지나지 않는다** — F2 회차에서 `⌘Q` 를 그 길로 보내니 앱이
// 안 죽었고 `⌘A`(Edit role)도 선택을 안 바꿨다. 그러니 그 길로는 이걸 못 잰다:
//
//   ⓐ `⌘W` 가 **창을 안 닫는다**(우리가 삼켰다) — 그리고 pane 이 닫힌다
//   ⓑ `⌘A`(Edit role)는 **그대로 산다** — 메뉴를 다시 만들지 않았다는 증거
//   ⓒ `⌘Q` 는 **그대로 앱을 닫는다**
//
// 그래서 여기서만 System Events 로 진짜 키를 보낸다. 안전 장치 둘:
//   · 키는 **pid 로 찍은 그 프로세스**를 앞으로 올린 뒤에만 보낸다
//   · 보내기 직전 렌더러에서 `document.hasFocus()` 를 확인한다. 거짓이면 **안 보내고 멈춘다** —
//     남의 앱(사용자 브라우저·터미널)에 `⌘W` 를 떨어뜨리는 일이 없어야 한다
//
// 격리: `life373-` 세션 전용. M0: 유령 앱 0 에서만 유효하다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, paneCalls, quiesce, windowAlive } from './app-steps.mjs'
import { m0End, m0Start, resetPanes, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-r23-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0, prefs: APP_ENV.CORRAL_UI_PREFS }
결과.초기화 = await resetPanes()

const app = await startApp({ name: 'r23-native-keys', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await quiesce(app)

/**
 * System Events 한 줄. **접근성 권한이 없으면 여기서 거절당한다** — 그건 실패가 아니라
 * "이 회차에선 못 쟀다"이므로 던지지 않고 사유를 돌려준다(공백은 공백으로).
 */
const osa = (script) => {
  try {
    return { ok: true, out: execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim() }
  } catch (error) {
    return { ok: false, error: String(error.stderr ?? error.message ?? error).slice(0, 300) }
  }
}

/**
 * **GUI 프로세스의 pid** — `node_modules/.bin/electron` 은 실행기(Node)라 System Events 가 모른다
 * (`유효하지 않은 인덱스 -1719` 로 거절당했다). 그 자식 중 `.app/Contents/MacOS/Electron` 이면서
 * `--type=`(렌더러·GPU 헬퍼)가 **없는** 하나가 앱 본체다.
 */
const guiPid = (launcher) => {
  const kids = (pid) => {
    try {
      return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  const command = (pid) => {
    try {
      return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  }
  const 볼것 = [...kids(launcher)]
  while (볼것.length > 0) {
    const pid = 볼것.shift()
    const cmd = command(pid)
    if (cmd.includes('.app/Contents/MacOS/Electron') && !cmd.includes('--type=')) return { pid, cmd: cmd.slice(0, 160) }
    볼것.push(...kids(pid))
  }
  return { pid: null, cmd: null }
}

/**
 * 그 pid 의 프로세스를 앞으로 올린다 — **이름이 아니라 pid** 로 찍는다(Electron 이 여럿일 수 있다).
 *
 * 앱만 활성화하면 모자란다: 첫 회차에서 `⌘Q`(NSApp 레벨)는 먹는데 `⌘T`·`⌘W`(창·웹 콘텐츠
 * 레벨)는 하나도 안 먹었다 — **창이 key window 가 아니었다**. 그래서 창을 `AXRaise` 로
 * 올리고 `AXMain` 을 세운다.
 */
const front = (pid) =>
  osa(
    `tell application "System Events" to tell (first process whose unix id is ${pid})\n` +
      `set frontmost to true\n` +
      `try\n` +
      `perform action "AXRaise" of window 1\n` +
      `set value of attribute "AXMain" of window 1 to true\n` +
      `set value of attribute "AXFocused" of window 1 to true\n` +
      `end try\n` +
      `end tell`,
  )

/** 렌더러가 **정말로** 키를 받을 상태인가. 거짓이면 키를 안 보낸다(남의 앱으로 새면 끝이다). */
const focused = async () => (await app.send({ cmd: 'eval', code: `document.hasFocus()` })).result === true

/** OS 가 보는 창 상태. `AXFocused` 가 false 면 창·웹 콘텐츠 레벨 키가 **하나도** 안 먹는다. */
const axFocused = () => osa(`tell application "System Events" to tell (first process whose unix id is ${GUI?.pid}) to get value of attribute "AXFocused" of window 1`)

/**
 * 창을 **key window** 로 만든다 — 진짜로 한 번 **클릭**해서.
 *
 * `set frontmost`·`AXRaise`·`AXFocused` 설정·Electron `window.focus()` 를 다 해도 `AXFocused` 가
 * false 로 남았다(실측). 터미널에서 띄운 창은 아무도 안 눌러서 key 가 안 된다. 그래서 그 창의
 * **자기 좌표 안**을 한 번 누른다 — 누르는 곳은 터미널 한가운데라 pane 포커스만 바뀐다.
 */
const makeKey = async () => {
  const box = (await app.send({
    cmd: 'eval',
    code: `({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight })`,
  })).result
  front(GUI.pid)
  await sleep(400)
  const 누름 = osa(`tell application "System Events" to click at {${Math.round(box.x + box.w * 0.6)}, ${Math.round(box.y + box.h * 0.6)}}`)
  await sleep(800)
  return { 창좌표: box, 누름, AXFocused: axFocused().out ?? null, 렌더러: await focused().catch(() => false) }
}

const GUI = guiPid(app.child.pid)
결과.GUI = GUI
console.log('GUI pid', JSON.stringify(GUI))

/** 진짜 키 하나. 앞에 세우고 → 포커스 확인 → 그때만 보낸다. */
const nativeKey = async (label, { chars, using }) => {
  if (GUI.pid === null) return { 라벨: label, 보냈나: false, 이유: 'GUI 프로세스를 못 찾았다' }
  const 앞으로 = front(GUI.pid)
  if (!앞으로.ok) return { 라벨: label, 보냈나: false, 이유: `앞으로 못 세웠다: ${앞으로.error}` }
  await sleep(600)
  const 포커스 = await focused().catch(() => false)
  // **키가 어디로 가는지**를 보낸 쪽에서 남긴다 — System Events `keystroke` 는 맨 앞 앱으로 간다.
  const 맨앞 = osa('tell application "System Events" to get (unix id of first process whose frontmost is true) & (name of first process whose frontmost is true)')
  if (!포커스) return { 라벨: label, 보냈나: false, 이유: '창이 앞에 없다 — 안 보냈다', 맨앞: 맨앞.out ?? null }
  const 보냄 = osa(`tell application "System Events" to keystroke "${chars}" using {${using}}`)
  if (!보냄.ok) return { 라벨: label, 보냈나: false, 이유: `키를 못 보냈다: ${보냄.error}`, 맨앞: 맨앞.out ?? null }
  await sleep(1500)
  return { 라벨: label, 보냈나: true, 맨앞: 맨앞.out ?? null, 겨눈pid: GUI.pid }
}

// 준비 — pane 을 둘로 (⌘W 가 pane 을 닫는 걸 보려면 둘 이상이어야 한다).
{
  const groupId = (await app.state()).terminalGroups[0]?.groupId ?? null
  await app.click(`[data-group-split-right="${groupId}"]`)
  await sleep(1600)
  결과.준비 = { groupId, pane수: (await app.state()).terminalGroups[0]?.panes.length ?? 0 }
  console.log('준비 | pane', 결과.준비.pane수)
}

// ⓜ **살아 있는 앱의 메뉴** — `⌘Q`·Edit role 이 그대로인가 (R23: 메뉴를 다시 만들지 않았다).
//    소스에 `setApplicationMenu` 가 없다는 것만으로는 돌고 있는 앱의 증거가 아니다.
{
  const dump = (await app.send({ cmd: 'menu-dump' })).menu
  const 찾기 = (role) => {
    for (const top of dump ?? []) for (const item of top.items) if (item.role === role) return { 상위: top.label, ...item }
    return null
  }
  결과.메뉴 = {
    최상위: (dump ?? []).map((m) => m.label),
    quit: 찾기('quit'),
    close: 찾기('close'),
    selectAll: 찾기('selectall') ?? 찾기('selectAll'),
    copy: 찾기('copy'),
    paste: 찾기('paste'),
    cut: 찾기('cut'),
  }
  console.log('ⓜ 메뉴 |', JSON.stringify(결과.메뉴))
}

// 창을 key 로 — 여기서부터 진짜 키가 의미를 갖는다.
결과.키창만들기 = await makeKey()
console.log('key window |', JSON.stringify(결과.키창만들기))

// ⓝ 진단 — 창이 **key window** 인가. `⌘Q`(NSApp)만 먹고 `⌘T`·`⌘W`(창·웹 콘텐츠)는 안 먹는
//    회차가 나와서, 접근성 속성을 그대로 찍어 둔다.
{
  const ax = (attr) => osa(`tell application "System Events" to tell (first process whose unix id is ${GUI.pid}) to get value of attribute "${attr}" of window 1`)
  결과.접근성 = {
    창수: osa(`tell application "System Events" to tell (first process whose unix id is ${GUI.pid}) to count windows`),
    AXMain: ax('AXMain'),
    AXFocused: ax('AXFocused'),
    올리기: osa(`tell application "System Events" to tell (first process whose unix id is ${GUI.pid}) to perform action "AXRaise" of window 1`),
    AXMain설정: osa(`tell application "System Events" to tell (first process whose unix id is ${GUI.pid}) to set value of attribute "AXMain" of window 1 to true`),
    AXFocused설정: osa(`tell application "System Events" to tell (first process whose unix id is ${GUI.pid}) to set value of attribute "AXFocused" of window 1 to true`),
  }
  결과.접근성.AXMain뒤 = ax('AXMain')
  결과.접근성.AXFocused뒤 = ax('AXFocused')
  console.log('ⓝ 접근성 |', JSON.stringify(결과.접근성))
}

// ⓞ **판별자** — 진짜 키가 렌더러까지 닿기는 하나. `⌘T`(새 탭)는 렌더러 `keydown` 이 잡는,
//    메뉴가 안 쥔 키다. 이게 먹으면 "키는 웹 콘텐츠까지 간다"가 서고, 그래야 `⌘W` 의 결과를
//    "우리가 삼켰다" 로 읽을 수 있다. 안 먹으면 이 회차의 ⌘W 판정은 **성립하지 않는다**.
{
  const 전 = (await app.state()).repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? []).length
  const sent = await nativeKey('⌘T', { chars: 't', using: 'command down' })
  let 후 = 전
  for (let i = 0; i < 10; i += 1) {
    후 = (await app.state()).repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? []).length
    if (후 !== 전) break
    await sleep(500)
  }
  결과.판별자_cmdT = { ...sent, 전, 후, 렌더러까지닿나: 후 > 전 }
  console.log('ⓞ ⌘T 판별자 |', JSON.stringify(결과.판별자_cmdT))
}

// ⓐ 진짜 `⌘W` — 창은 살고 pane 이 닫힌다.
//    "안 닫혔다"와 "안 눌렸다"를 가르려고 **main 로그**(`shortcut.intercepted`)와 `pane.close`
//    호출을 같이 본다. 화면만 보면 둘이 똑같이 생겼다.
{
  const 전 = (await app.state()).terminalGroups[0]?.panes.length ?? 0
  const since = Date.now()
  const sent = await nativeKey('⌘W', { chars: 'w', using: 'command down' })
  const alive = await windowAlive(app)
  // 반영까지 기다린다 — pane 닫힘은 herdr 를 한 바퀴 돈다.
  let 후 = 전
  for (let i = 0; i < 12 && alive; i += 1) {
    후 = (await app.state()).terminalGroups[0]?.panes.length ?? 0
    if (후 !== 전) break
    await sleep(500)
  }
  결과.cmdW = {
    ...sent,
    전,
    창살아있나: alive,
    후: alive ? 후 : null,
    가로챔: app.entries().filter((e) => e.tag === 'shortcut.intercepted' && e.at >= since).length,
    'pane.close': paneCalls(app, since, 'pane.close').length,
    activeElement: (await app.send({ cmd: 'eval', code: `document.activeElement === null ? null : (document.activeElement.className + '|' + document.activeElement.tagName)` })).result,
  }
  console.log('ⓐ ⌘W |', JSON.stringify(결과.cmdW))
  if (!alive) {
    결과.판정 = '⌘W 가 창을 닫았다 — 가로채기 실패'
    writeRaw('r23-native-keys.json', 결과)
    process.exit(1)
  }
  await app.shot('r23-a-cmdw')
}

// ⓑ 진짜 `⌘A` — Edit role 이 그대로 산다. 리네임 입력칸에서 잰다(사이드바 검색칸은 disabled).
{
  const tabId = (await app.state()).repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? [])[0]?.tabId ?? null
  결과.cmdA = { tabId }
  if (tabId !== null) {
    await app.send({ cmd: 'dblclick', selector: `[data-main-tab="${tabId}"] .main-tab-label` })
    await sleep(600)
    // corral 이 편집을 켜며 이미 `select()` 한다 — 방향키로 한 번 풀고 ⌘A 가 되돌리는지를 본다.
    await app.send({ cmd: 'key', keyCode: 'Right', modifiers: [] })
    await sleep(300)
    const 읽기 = async () =>
      (await app.send({
        cmd: 'eval',
        code: `(() => {
          const el = document.querySelector('.main-tab-rename')
          if (el === null) return null
          return { 값: el.value, start: el.selectionStart, end: el.selectionEnd, 전부: el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.length > 0 }
        })()`,
      })).result
    결과.cmdA.푼뒤 = await 읽기()
    결과.cmdA.보냄 = await nativeKey('⌘A', { chars: 'a', using: 'command down' })
    결과.cmdA.누른뒤 = await 읽기()
    결과.cmdA.activeElement = (await app.send({ cmd: 'eval', code: `document.activeElement === null ? null : (document.activeElement.className + '|' + document.activeElement.tagName)` })).result
    await app.send({ cmd: 'key', keyCode: 'Escape', modifiers: [] })
    await sleep(400)
  }
  console.log('ⓑ ⌘A |', JSON.stringify(결과.cmdA.누른뒤))
}

// ⓒ 진짜 `⌘Q` — 그대로 앱이 닫힌다. **맨 끝**이다.
{
  결과.cmdQ = await nativeKey('⌘Q', { chars: 'q', using: 'command down' })
  await sleep(1500)
  결과.cmdQ.창살아있나 = await windowAlive(app)
  console.log('ⓒ ⌘Q | 창살아있나', 결과.cmdQ.창살아있나)
}

await app.stop()
await sleep(800)
결과.M0b = m0End()
writeRaw('r23-native-keys.json', 결과)
