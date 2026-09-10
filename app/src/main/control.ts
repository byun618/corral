// 계측용 제어 채널 — **CORRAL_CONTROL_SOCKET 이 설정된 실행에서만** 열린다.
//
// 왜 있나: 판정 근거가 "화면"과 "타임스탬프 로그"를 함께 요구한다 (K6·L3·L4). 사람 손으로
// 클릭해 가며 찍으면 재현이 안 되므로, 측정 스크립트가 라벨을 붙여 스크린샷을 요청하고
// 선택을 바꿀 수 있게 얇은 채널을 둔다. 평시 실행에는 열리지 않는다.
//
// 프로토콜은 앱의 herdr 클라이언트와 같은 NDJSON: {"cmd":"shot","name":"k6-before"}

import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { isRecord, readNumber, readString } from './herdr/protocol.js'
import type { PaneTerminal } from './herdr/pane-terminal.js'
import { log } from './log.js'
import { checkUnixSocketPath } from './unix-socket-path.js'

/**
 * `sendInputEvent` 가 받는 수식자. 계측이 문자열로 보내오므로 아는 것만 통과시킨다 —
 * 모르는 값을 그대로 넘기면 Electron 이 조용히 무시하고 "Ctrl 을 보냈는데 안 먹었다" 가 된다.
 */
const KEY_MODIFIERS = ['shift', 'control', 'alt', 'meta'] as const
type KeyModifier = (typeof KEY_MODIFIERS)[number]

function readModifiers(value: unknown): KeyModifier[] {
  if (!Array.isArray(value)) return []
  const out: KeyModifier[] = []
  for (const item of value) {
    for (const known of KEY_MODIFIERS) {
      if (item === known) out.push(known)
    }
  }
  return out
}

export type ControlHandlers = {
  capture: (name: string, selector?: string) => Promise<string>
  selectSession: (name: string) => void
  selectPane: (paneId: string | null) => void
  toggleCollapse: (workspaceId: string) => void
  state: () => unknown
  verify: () => Promise<unknown>
  /** LIFE-345 — 터미널 층. 계측이 정책 상수와 격자를 그대로 읽어 간다. */
  terminal: PaneTerminal
  window: () => BrowserWindow | null
}

/**
 * 렌더러의 **진짜 xterm 버퍼**를 셀 단위로 뜬다 (T1·T3 관문 ④).
 *
 * 헤드리스 인스턴스를 따로 돌려 재면 그건 "재생 로직을 잰 것" 이지 "화면을 잰 것" 이 아니다.
 * 그래서 판정 근거는 실제로 사람이 보고 있는 그 버퍼에서 뽑는다.
 * 이 스크립트는 `TerminalView` 가 걸어 둔 `window.__corralTerm` 을 읽는다.
 */
const DUMP_SCRIPT = `(() => {
  const term = window.__corralTerm
  if (!term) return { ok: false, error: 'terminal not mounted' }
  const buf = term.buffer.active
  const rows = []
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y)
    const cells = []
    if (line) {
      for (let x = 0; x < term.cols; x++) {
        const c = line.getCell(x)
        if (!c) { cells.push(null); continue }
        cells.push({
          ch: c.getChars(),
          w: c.getWidth(),
          fg: c.isFgDefault() ? 'default' : (c.isFgPalette() ? 'p' : 'rgb') + c.getFgColor(),
          bg: c.isBgDefault() ? 'default' : (c.isBgPalette() ? 'p' : 'rgb') + c.getBgColor(),
          bold: !!c.isBold(),
          inverse: !!c.isInverse(),
          underline: !!c.isUnderline(),
        })
      }
    }
    rows.push(cells)
  }
  const scrollback = []
  for (let y = 0; y < buf.baseY; y++) {
    const line = buf.getLine(y)
    scrollback.push(line ? line.translateToString(true) : '')
  }
  return {
    ok: true,
    cols: term.cols,
    rows: term.rows,
    baseY: buf.baseY,
    viewportY: buf.viewportY,
    length: buf.length,
    unicodeVersion: term.unicode.activeVersion,
    grid: rows,
    scrollback,
  }
})()`

export function startControlServer(handlers: ControlHandlers): net.Server | null {
  const socketPath = process.env.CORRAL_CONTROL_SOCKET
  if (!socketPath || socketPath.length === 0) return null

  // 경로가 길면 bind 가 EINVAL 로 던지고, main 의 uncaught exception 은 Electron 모달로 앱을 막는다.
  // 계측 채널 하나 때문에 앱이 죽지 않게 **바인드 전에** 재고 식별 가능한 실패로 남긴다.
  const check = checkUnixSocketPath(socketPath)
  if (!check.ok) {
    log('control.path_too_long', { socketPath, bytes: check.bytes, limit: check.limit, reason: check.reason })
    return null
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath)

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('error', (error) => log('control.error', { error: String(error) }))
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index === -1) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length === 0) continue
        void handle(line, socket, handlers)
      }
    })
  })
  server.on('error', (error) => log('control.listen_failed', { socketPath, error: String(error) }))
  server.listen(socketPath, () => log('control.listening', { socketPath, bytes: check.bytes }))
  return server
}

async function handle(line: string, socket: net.Socket, handlers: ControlHandlers): Promise<void> {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(line)
  } catch {
    socket.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n')
    return
  }
  if (!isRecord(parsed)) {
    socket.write(JSON.stringify({ ok: false, error: 'bad frame' }) + '\n')
    return
  }
  const cmd = readString(parsed, 'cmd')
  log('control.cmd', { line: line.slice(0, 300) })
  try {
    switch (cmd) {
      case 'shot': {
        const file = await handlers.capture(readString(parsed, 'name') ?? 'shot', readString(parsed, 'selector') ?? undefined)
        socket.write(JSON.stringify({ ok: true, file }) + '\n')
        return
      }
      case 'select-session': {
        const name = readString(parsed, 'name')
        if (name === null) throw new Error('name 필요')
        handlers.selectSession(name)
        socket.write(JSON.stringify({ ok: true }) + '\n')
        return
      }
      case 'select-pane': {
        handlers.selectPane(readString(parsed, 'paneId'))
        socket.write(JSON.stringify({ ok: true }) + '\n')
        return
      }
      case 'toggle-collapse': {
        const workspaceId = readString(parsed, 'workspaceId')
        if (workspaceId === null) throw new Error('workspaceId 필요')
        handlers.toggleCollapse(workspaceId)
        socket.write(JSON.stringify({ ok: true }) + '\n')
        return
      }
      case 'state': {
        socket.write(JSON.stringify({ ok: true, state: handlers.state() }) + '\n')
        return
      }
      case 'verify': {
        socket.write(JSON.stringify({ ok: true, verify: await handlers.verify() }) + '\n')
        return
      }
      // --- LIFE-345 계측 ---------------------------------------------------
      case 'term-dump': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const dump = await target.webContents.executeJavaScript(DUMP_SCRIPT, true)
        socket.write(JSON.stringify({ ok: true, dump }) + '\n')
        return
      }
      /**
       * 렌더러 화면에 이 문자열이 지금 보이나 (I1 계측).
       *
       * 로그를 긁어 프레임과 페인트를 짝짓는 방식은 zsh 구문 강조·로그 성장 때문에 자꾸
       * 표본을 놓쳤다. 화면에 실제로 보이는지를 **화면에 직접** 묻는 것이 이 항목의 질문
       * ("그 글자가 화면에 나타나기까지")에도 더 정직하다.
       */
      case 'term-find': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const needle = readString(parsed, 'needle')
        if (needle === null) throw new Error('needle 필요')
        const found = await target.webContents.executeJavaScript(
          `(() => {
            const t = window.__corralTerm
            if (!t) return false
            const buf = t.buffer.active
            let text = ''
            for (let y = 0; y < t.rows; y++) {
              const line = buf.getLine(buf.viewportY + y)
              text += (line ? line.translateToString(true) : '') + String.fromCharCode(10)
            }
            return text.includes(${JSON.stringify(needle)})
          })()`,
          true,
        )
        socket.write(JSON.stringify({ ok: true, found, at: Date.now() }) + '\n')
        return
      }
      case 'term-policy': {
        socket.write(JSON.stringify({ ok: true, policy: handlers.terminal.policy() }) + '\n')
        return
      }
      /**
       * 렌더러 터미널에 **바이트를 직접** 쓴다 — T3 의 대조군 전용이다.
       * 제품 경로(main 이 만든 home 프레임)와 나란히 naive·reset 전략을 같은 화면에서 돌려
       * "0줄"이 전략 덕분이라는 것을 보이기 위한 것. 앱 코드는 이 경로를 쓰지 않는다.
       */
      case 'term-write': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const bytes = readString(parsed, 'bytes')
        if (bytes === null) throw new Error('bytes 필요')
        const done = await target.webContents.executeJavaScript(
          `new Promise((resolve) => { const t = window.__corralTerm; if (!t) return resolve(false); t.write(${JSON.stringify(bytes)}, () => resolve(t.buffer.active.baseY)) })`,
          true,
        )
        socket.write(JSON.stringify({ ok: true, baseY: done }) + '\n')
        return
      }
      case 'term-unicode': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const mode = readString(parsed, 'mode') ?? '11'
        // dataset 에도 박는다. pane 선택을 비우면 TerminalView 가 **언마운트**되고 다시 붙을 때
        // 새 인스턴스가 기본 모드로 뜬다 — 실측에서 이것 때문에 세 모드가 전부 11 로 나왔다.
        const active = await target.webContents.executeJavaScript(
          `(() => {
            document.documentElement.dataset.corralUnicode = ${JSON.stringify(mode)}
            return window.__corralUnicode ? window.__corralUnicode(${JSON.stringify(mode)}) : null
          })()`,
          true,
        )
        log('control.unicode', { mode, active: String(active) })
        socket.write(JSON.stringify({ ok: true, mode, active }) + '\n')
        return
      }
      case 'term-webgl': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const on = parsed['on'] === true
        await target.webContents.executeJavaScript(
          `document.documentElement.dataset.corralWebgl = ${JSON.stringify(on ? '1' : '0')}; true`,
          true,
        )
        socket.write(JSON.stringify({ ok: true, on }) + '\n')
        return
      }
      /**
       * **진짜 키 입력**을 렌더러에 넣는다 (I1·I2·I3·I4).
       *
       * `sendPaneText` 를 main 에서 직접 부르면 재는 경로가 짧아져 xterm 의 키 처리와 IPC 가
       * 빠진다 — 사용자가 겪는 지연이 아니다. 그래서 `sendInputEvent` 로 렌더러의 keydown 부터
       * 밟게 한다. 포커스는 여기서 맞춘다.
       */
      case 'key': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const keyCode = readString(parsed, 'keyCode')
        if (keyCode === null) throw new Error('keyCode 필요')
        const modifiers = readModifiers(parsed['modifiers'])
        // 대문자는 shift 를 같이 눌러야 브라우저가 그 글자로 읽는다. 안 넣으면 keydown 이
        // 소문자로 해석돼 화면에 소문자가 찍힌다 (1차 측정에서 `I2MARK0` 이 `imark0` 이 됐다).
        if (/^[A-Z]$/.test(keyCode) && !modifiers.includes('shift')) modifiers.push('shift')
        const printable = keyCode.length === 1 && !modifiers.includes('control') && !modifiers.includes('meta')
        await target.webContents.executeJavaScript(
          `(() => { const el = document.querySelector('.xterm-helper-textarea'); if (el) el.focus(); return !!el })()`,
          true,
        )
        const at = Date.now()
        target.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
        if (printable) target.webContents.sendInputEvent({ type: 'char', keyCode, modifiers })
        target.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
        log('control.key', { keyCode, modifiers: modifiers.join('+'), at })
        socket.write(JSON.stringify({ ok: true, at }) + '\n')
        return
      }
      /** 붙여넣기 (I5) — 여러 줄을 한 번에 넣는다. xterm 의 paste 경로를 그대로 탄다. */
      case 'paste': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const text = readString(parsed, 'text')
        if (text === null) throw new Error('text 필요')
        const at = Date.now()
        await target.webContents.executeJavaScript(
          `(() => { const t = window.__corralTerm; if (!t) return false; t.paste(${JSON.stringify(text)}); return true })()`,
          true,
        )
        log('control.paste', { length: text.length, at })
        socket.write(JSON.stringify({ ok: true, at }) + '\n')
        return
      }
      /** 창 크기 (T2) — 격자가 창을 따라 어떻게 되는지 보려면 창을 흔들어야 한다. */
      case 'resize': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const width = readNumber(parsed, 'width')
        const height = readNumber(parsed, 'height')
        if (width === null || height === null) throw new Error('width·height 필요')
        target.setSize(Math.round(width), Math.round(height))
        socket.write(JSON.stringify({ ok: true, width, height }) + '\n')
        return
      }
      default:
        socket.write(JSON.stringify({ ok: false, error: `모르는 cmd: ${cmd}` }) + '\n')
    }
  } catch (error) {
    socket.write(JSON.stringify({ ok: false, error: String(error) }) + '\n')
  }
}
