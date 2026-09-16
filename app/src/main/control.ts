// 계측용 제어 채널 — **CORRAL_CONTROL_SOCKET 이 설정된 실행에서만** 열린다.
//
// 왜 있나: 판정 근거가 "화면" 과 "타임스탬프 로그" 를 함께 요구한다. 사람 손으로 클릭해 가며
// 찍으면 재현이 안 되므로, 측정 스크립트가 라벨을 붙여 스크린샷을 요청하고 화면을 누를 수 있게
// 얇은 채널을 둔다. 평시 실행에는 열리지 않는다. 프로토콜은 NDJSON: {"cmd":"shot","name":"n3-1"}
//
// **이 파일은 herdr 를 모른다** — 어댑터 타입도 프로토콜 모듈도 import 하지 않는다 (기준 N2).

import { Menu } from 'electron'
import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { isRecord, readNumber, readString, safeParse } from '../shared/json.js'
import type { AddRepoResult } from '../shared/types.js'
import { log } from './log.js'
import { checkUnixSocketPath } from './unix-socket-path.js'

export type ControlHandlers = {
  capture: (name: string, selector?: string) => Promise<string>
  state: () => unknown
  window: () => BrowserWindow | null
  resync: (reason: string) => Promise<{ ok: boolean; note: string }>
  /** N7 — push 를 조용히 버리게/멈추게 한다. 커넥션은 살아 있다. `only` 면 그 이벤트만. */
  setDroppingPush: (input: { dropping: boolean; only?: readonly string[] | null }) => void
  /** 준비·뒷정리 전용 지름길. 판정 회차(N3)는 이게 아니라 `click` 으로 진짜 버튼을 누른다. */
  addRepo: (root: string) => AddRepoResult
  rebuildTree: () => Promise<void>
  /**
   * 네이티브 폴더 선택기의 **결과만** 갈아끼운다 (게이트 ① 2번째 지시 (5)).
   * macOS 다이얼로그는 OS 가 그리는 창이라 `sendInputEvent` 가 안 닿는다. 그 한 걸음만 스텁으로
   * 두고 버튼 클릭 → IPC → 판별 → 등록은 진짜로 지나가게 한다.
   *
   * 세 상태다: 경로를 고른 것 · **취소한 것** · 스텁을 뗀 것(`null` — 진짜 창이 뜬다).
   */
  setDialogStub: (value: { canceled: true } | { path: string } | null) => void
  /** R2 계측 — S5 격자 수렴이 창 크기를 3단계로 바꾼다. */
  resizeWindow: (size: { width: number; height: number }) => void
  /** R2 계측 — A1 이 OSC 52 복사가 OS 클립보드에 실렸는지 읽는다. corral 쪽 관측이다. */
  readClipboard: () => Promise<string>
}

/**
 * 그 버튼이 **사람에게 닿나** — 누르기 전에 화면에 물어본다 (관문 ⑤).
 *
 * `el.click()` 은 요소에 이벤트를 직접 꽂는 것이라 가시성·z-order·히트테스트를 하나도 안 거친다.
 * 그래서 순서를 바꾼다: ① 보이는 데까지 스크롤 ② 중심 좌표의 `elementFromPoint` 가 그 버튼인지
 * 확인 ③ 맞을 때만 **좌표로** 마우스 이벤트를 보낸다. 아니면 무엇이 위에 있는지 적고 누르지 않는다.
 *
 * **조상은 히트가 아니다**: 최상위가 목표를 *담고 있는* 상자여도 그 좌표에서 실제로 눌리는 것은
 * 그 상자다. 그래서 `el.contains(top)` 만 인정한다 (목표 또는 그 안의 글리프).
 */
function clickProbe(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { found: false }
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return { found: true, hit: false, blockedBy: 'zero-size' }
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    const top = document.elementFromPoint(x, y)
    const describe = (node) => {
      if (!node) return null
      const id = node.id ? '#' + node.id : ''
      const cls = typeof node.className === 'string' && node.className.length > 0
        ? '.' + node.className.trim().split(/\\s+/).join('.') : ''
      return node.tagName.toLowerCase() + id + cls
    }
    const hit = top !== null && (top === el || el.contains(top))
    return {
      found: true, hit, x, y,
      rect: { left: r.left, top: r.top, w: r.width, h: r.height },
      elementFromPoint: describe(top),
      target: describe(el),
      blockedBy: hit ? null : describe(top),
    }
  })()`
}

export function startControlServer(handlers: ControlHandlers): net.Server | null {
  const socketPath = process.env.CORRAL_CONTROL_SOCKET
  if (socketPath === undefined || socketPath.length === 0) return null

  // 경로가 길면 bind 가 EINVAL 로 던지고, main 의 uncaught exception 은 Electron 모달로 앱을 막는다.
  // 계측 채널 하나 때문에 앱이 죽지 않게 **바인드 전에** 재고 식별 가능한 실패로 남긴다.
  const check = checkUnixSocketPath(socketPath)
  if (!check.ok) {
    log('control.path_too_long', { socketPath, bytes: check.bytes, limit: check.limit })
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
  const parsed = safeParse(line)
  if (!isRecord(parsed)) {
    socket.write(JSON.stringify({ ok: false, error: 'bad frame' }) + '\n')
    return
  }
  const reply = (payload: Record<string, unknown>): void => {
    socket.write(JSON.stringify(payload) + '\n')
  }
  const cmd = readString(parsed, 'cmd')
  log('control.cmd', { line: line.slice(0, 300) })
  try {
    switch (cmd) {
      case 'shot': {
        const file = await handlers.capture(
          readString(parsed, 'name') ?? 'shot',
          readString(parsed, 'selector') ?? undefined,
        )
        reply({ ok: true, file })
        return
      }
      case 'state':
        reply({ ok: true, at: Date.now(), state: handlers.state() })
        return
      /**
       * **메인 프로세스**의 누적 CPU 시간 (μs). 기준 A7 본문이 "메인 프로세스 추가 CPU" 를
       * 재라고 하는데 1회차는 벽시계(ms)만 쟀다 — 수정 라운드 1 (V12) 에서 이 문을 낸다.
       * 구간 앞뒤로 두 번 떠서 빼면 그 구간이 실제로 쓴 CPU 다. `ps` 의 초·센티초 해상도로는
       * 6ms 짜리 주기를 못 가르므로 프로세스 자신에게 묻는다.
       */
      case 'cpu':
        reply({ ok: true, at: Date.now(), cpu: process.cpuUsage(), uptimeMs: Math.round(process.uptime() * 1000) })
        return
      /**
       * **herdr 쪽 대조값은 이 채널이 주지 않는다.**
       * 판별자는 재는 대상 자신의 출력이면 안 된다 (관문 ⑤ 제3 오라클) — 하네스가 자기
       * 커넥션으로 `tab.list`·`pane.list` 를 떠서 상대편을 만든다. 여기는 corral 쪽만 준다.
       */
      case 'resync': {
        const result = await handlers.resync(readString(parsed, 'reason') ?? 'control')
        reply({ ok: result.ok, note: result.note, at: Date.now() })
        return
      }
      case 'drop-push': {
        // `only` 를 주면 **그 이벤트만** 버린다 — "corral 이 일부를 모르는 상태" 를 만드는 손잡이다.
        const raw = parsed['only']
        const only = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : null
        const dropping = parsed['dropping'] === true
        handlers.setDroppingPush({ dropping, only })
        reply({ ok: true, dropping, only, at: Date.now() })
        return
      }
      case 'add-repo': {
        const root = readString(parsed, 'root')
        if (root === null) throw new Error('root 필요')
        const result = handlers.addRepo(root)
        reply({ ...result, at: Date.now() })
        return
      }
      /**
       * 다음 「폴더 찾아보기」가 **고른 것으로 칠** 경로. 계측 전용이고, 이 채널은
       * `CORRAL_CONTROL_SOCKET` 이 있을 때만 선다 — 평시 앱에는 이 손잡이가 없다.
       */
      case 'browse-stub': {
        // `path` 가 있으면 그 폴더를 고른 것, `canceled:true` 면 그냥 닫은 것, 둘 다 없으면 스텁을 뗀다.
        const raw = readString(parsed, 'path')
        const value = raw !== null ? { path: raw } : parsed['canceled'] === true ? ({ canceled: true } as const) : null
        handlers.setDialogStub(value)
        reply({ ok: true, stub: value, at: Date.now() })
        return
      }
      case 'rebuild-tree': {
        await handlers.rebuildTree()
        reply({ ok: true, at: Date.now() })
        return
      }
      /**
       * 화면의 **진짜 버튼**을 누른다. main 핸들러를 부르는 지름길로는 "UI 조작만으로" 가
       * 증명되지 않는다 — 렌더러의 onClick 이 실제로 그 IPC 를 부르는지가 증명 대상의 일부다.
       */
      case 'click': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const selector = readString(parsed, 'selector')
        if (selector === null) throw new Error('selector 필요')
        const probe = await target.webContents.executeJavaScript(clickProbe(selector), true)
        if (!isRecord(probe) || probe['found'] !== true) {
          reply({ ok: false, hit: false, selector, error: '선택자가 화면에 없다' })
          return
        }
        const x = readNumber(probe, 'x')
        const y = readNumber(probe, 'y')
        if (probe['hit'] !== true || x === null || y === null) {
          // **누르지 않는다.** 가려진 버튼을 눌러 주는 순간 측정이 거짓말을 하기 시작한다.
          log('control.click.blocked', { selector, blockedBy: readString(probe, 'blockedBy') })
          reply({ ok: false, selector, ...probe })
          return
        }
        const at = Date.now()
        // 좌표로 보낸다 — 히트테스트·z-order 를 **크로미움이** 하게 두는 것이 요점이다.
        target.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        target.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        target.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        log('control.click', { selector, hit: true, x, y, at, method: 'sendInputEvent' })
        reply({ ok: true, selector, at, method: 'sendInputEvent', ...probe })
        return
      }
      /**
       * 더블클릭 (11-gate1-fix3.md I-7 인라인 리네임 진입). `click` 과 **같은 좌표 경로**다 —
       * 히트테스트를 크로미움이 하고, 가려져 있으면 누르지 않는다. 다른 점은 두 번째 누름의
       * `clickCount: 2` 뿐이고, 크로미움은 그 mouseUp 에서 `dblclick` 을 만든다.
       * (규칙을 약하게 하는 추가가 아니다 — 좌표·가림 판정은 그대로다.)
       */
      case 'dblclick': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const selector = readString(parsed, 'selector')
        if (selector === null) throw new Error('selector 필요')
        const probe = await target.webContents.executeJavaScript(clickProbe(selector), true)
        if (!isRecord(probe) || probe['found'] !== true) {
          reply({ ok: false, hit: false, selector, error: '선택자가 화면에 없다' })
          return
        }
        const x = readNumber(probe, 'x')
        const y = readNumber(probe, 'y')
        if (probe['hit'] !== true || x === null || y === null) {
          log('control.dblclick.blocked', { selector, blockedBy: readString(probe, 'blockedBy') })
          reply({ ok: false, selector, ...probe })
          return
        }
        const at = Date.now()
        target.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        target.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        target.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        target.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 })
        target.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 })
        log('control.dblclick', { selector, hit: true, x, y, at, method: 'sendInputEvent' })
        reply({ ok: true, selector, at, method: 'sendInputEvent', ...probe })
        return
      }
      /**
       * 글자를 친다 (붙여넣기 아님). 수정 5회차에서 경로 입력칸이 사라져 한동안 쓰는 측정이
       * 없었는데, I-7 인라인 리네임 입력칸이 생기며 다시 쓴다 — `char` 이벤트는 **포커스된
       * 요소**로 간다. 그래서 "편집 중 키가 터미널로 새지 않는다"를 이 손잡이 하나로 잰다.
       */
      case 'type': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const text = readString(parsed, 'text')
        if (text === null) throw new Error('text 필요')
        // **주입 시각을 넣기 직전에 찍는다** (수정 1회차 C3). S2 는 이 `at` 을 레이턴시의 시작점으로
        // 쓴다 — 루프가 끝난 뒤에 찍으면 그 사이 시간만큼 레이턴시를 과소평가한다. 시계는 injection
        // 순간에 시작해야 한다. (main·renderer 는 같은 머신이라 Date.now 벽시계가 동일 — 스큐 없음.)
        const at = Date.now()
        for (const ch of text) {
          target.webContents.sendInputEvent({ type: 'char', keyCode: ch })
        }
        reply({ ok: true, typed: text.length, at })
        return
      }
      /**
       * 키를 누른다 (수식자 포함) — 입력칸을 비우는 것도 **사람이 하는 걸음**이라 키로 한다.
       * 모르는 수식자는 Electron 이 조용히 무시하므로 아는 것만 통과시킨다.
       *
       * `type` 으로 **누름/뗌을 따로** 보낼 수 있다 (기본은 둘 다 — 기존 호출부 그대로).
       * MRU 홀드(`⌃Tab` 을 쥔 채 `Tab` 을 여러 번)는 누름만 이어 보내야 재현되고, 확정은
       * `Control` **뗌** 하나로 나야 한다 — 붙여 보내면 그 사이 뗌이 홀드를 먼저 끝낸다.
       */
      case 'key': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const keyCode = readString(parsed, 'keyCode')
        if (keyCode === null) throw new Error('keyCode 필요')
        const known = ['shift', 'control', 'alt', 'meta']
        const raw = parsed['modifiers']
        const modifiers = Array.isArray(raw) ? raw.filter((item) => typeof item === 'string' && known.includes(item)) : []
        const type = readString(parsed, 'type')
        const types = type === 'keyDown' || type === 'keyUp' ? [type] : ['keyDown', 'keyUp']
        for (const one of types) target.webContents.sendInputEvent({ type: one === 'keyUp' ? 'keyUp' : 'keyDown', keyCode, modifiers })
        reply({ ok: true, keyCode, modifiers, types, at: Date.now() })
        return
      }
      /** 화면에 그 선택자가 있나 / 무슨 글자를 들고 있나. */
      case 'query': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const selector = readString(parsed, 'selector')
        if (selector === null) throw new Error('selector 필요')
        // 입력칸은 textContent 가 빈 문자열이다 — **화면의 값**을 보려면 value 를 같이 읽어야 한다.
        const found = await target.webContents.executeJavaScript(
          `(() => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((el) =>
            'value' in el && typeof el.value === 'string' ? el.value : el.textContent))()`,
          true,
        )
        reply({ ok: true, selector, found, at: Date.now() })
        return
      }
      /** S5 — 창 크기 변경. 리사이즈→fit→요청→수렴 경로 전체가 진짜로 돈다. */
      case 'resize-window': {
        const width = readNumber(parsed, 'width')
        const height = readNumber(parsed, 'height')
        if (width === null || height === null) throw new Error('width·height 필요')
        handlers.resizeWindow({ width, height })
        reply({ ok: true, width, height, at: Date.now() })
        return
      }
      /**
       * LIFE-373 R23 — **지금 앱이 들고 있는 메뉴**를 그대로 읽는다 (읽기 전용).
       *
       * `⌘W` 를 `before-input-event` 로 가로채면서 "메뉴는 손대지 않았다"를 주장하는데, 그건
       * 소스에 `setApplicationMenu` 가 없다는 사실만으로는 **살아 있는 앱**에 대한 증거가 아니다.
       * `⌘Q`·Edit role 이 그대로인지를 여기서 원본 그대로 찍는다.
       */
      case 'menu-dump': {
        const menu = Menu.getApplicationMenu()
        reply({
          ok: true,
          at: Date.now(),
          menu:
            menu === null
              ? null
              : menu.items.map((item) => ({
                  label: item.label,
                  items: (item.submenu?.items ?? []).map((sub) => ({
                    label: sub.label,
                    role: sub.role ?? null,
                    accelerator: sub.accelerator ?? null,
                    enabled: sub.enabled,
                  })),
                })),
        })
        return
      }
      /** A1 — Electron 클립보드 내용. corral 이 썼는지를 보는 것이라 corral 쪽 관측이 맞다. */
      case 'read-clipboard': {
        reply({ ok: true, text: await handlers.readClipboard(), at: Date.now() })
        return
      }
      /**
       * S1·S2·S3 — **xterm 버퍼 실물**을 렌더러에서 읽는다. 렌더러가 diagnostics 실행에서
       * 노출하는 프로브 훅(window.corralTermProbe)을 부른다 — 기준 S1 이 지정한 대조 대상이
       * "xterm 버퍼 실물(buffer.getLine)" 이라 화면 스크린샷이 아니라 버퍼를 뜬다.
       * herdr 쪽 대조값은 여전히 이 채널이 주지 않는다 (위 'state' 주석의 규칙 그대로).
       */
      case 'term-read': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const result = await target.webContents.executeJavaScript(
          `(() => window.corralTermProbe ? window.corralTermProbe.read() : null)()`,
          true,
        )
        reply({ ok: result !== null, at: Date.now(), term: result })
        return
      }
      /**
       * S4 — 진짜 wheel 이벤트를 터미널 위에 꽂는다. 렌더러의 캡처-단계 wheel 핸들러가
       * 받아 termScroll → stream.scroll(벤더 session.scroll) 한 길로 흐른다. `el.dispatchEvent`
       * 로 실제 WheelEvent 를 만들어 그 경로가 실증되게 한다 (main 핸들러 지름길 아님).
       */
      case 'wheel': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const deltaY = readNumber(parsed, 'deltaY')
        if (deltaY === null) throw new Error('deltaY 필요')
        const dispatched = await target.webContents.executeJavaScript(
          `(() => {
             const host = document.querySelector('.term-host')
             if (!host) return { ok: false, reason: 'no term-host' }
             const screen = host.querySelector('.xterm-screen') ?? host
             const r = screen.getBoundingClientRect()
             const ev = new WheelEvent('wheel', {
               deltaY: ${deltaY}, bubbles: true, cancelable: true,
               clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
             })
             host.dispatchEvent(ev)
             return { ok: true }
           })()`,
          true,
        )
        reply({ ok: isRecord(dispatched) && dispatched['ok'] === true, deltaY, at: Date.now(), dispatched })
        return
      }
      /**
       * A5 — mouseReporting TUI 에 마우스 클릭을 전달한다. 진짜 MouseEvent 를 .xterm-screen 에
       * 꽂아 xterm 의 마우스 핸들러가 SGR 시퀀스로 onData 를 발화하게 한다 (wheel 과 같은 결). fx·fy
       * 는 스크린 rect 안 비율. main 지름길이 아니라 렌더러의 실제 입력 경로를 지난다.
       */
      case 'term-click': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const fx = readNumber(parsed, 'fx') ?? 0.5
        const fy = readNumber(parsed, 'fy') ?? 0.5
        const dispatched = await target.webContents.executeJavaScript(
          `(() => {
             const host = document.querySelector('.term-host')
             if (!host) return { ok: false, reason: 'no term-host' }
             const screen = host.querySelector('.xterm-screen') ?? host
             const r = screen.getBoundingClientRect()
             const x = Math.round(r.left + r.width * ${fx})
             const y = Math.round(r.top + r.height * ${fy})
             const opt = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }
             screen.dispatchEvent(new MouseEvent('mousedown', opt))
             screen.dispatchEvent(new MouseEvent('mouseup', opt))
             return { ok: true, x, y }
           })()`,
          true,
        )
        reply({ ok: isRecord(dispatched) && dispatched['ok'] === true, fx, fy, at: Date.now(), dispatched })
        return
      }
      /** S7ⓔ — xterm 이 한 문자열에 매기는 셀 폭. 폭 오라클의 xterm 축. */
      case 'term-cell-width': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const text = readString(parsed, 'text')
        if (text === null) throw new Error('text 필요')
        const width = await target.webContents.executeJavaScript(
          `(() => window.corralTermProbe ? window.corralTermProbe.cellWidth(${JSON.stringify(text)}) : null)()`,
          true,
        )
        reply({ ok: width !== null, width, text, at: Date.now() })
        return
      }
      /**
       * L2 — #5800 우회 직접 관측. DECRQM 질의를 xterm 에 먹이고 그 DECRPM 응답을 그대로 받는다.
       * 프로덕션(재-minify) 빌드에서도 `\x1b[?2026;<value>$y` 가 오면 DECRQM CSI 핸들러가 살아
       * 있다는 증거다 (renderer build.target es2022 우회). 응답 없음이면 우회가 깨진 것이다.
       */
      case 'term-decrqm': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const mode = readNumber(parsed, 'mode') ?? 2026
        const response = await target.webContents.executeJavaScript(
          `(() => window.corralTermProbe ? window.corralTermProbe.decrqm(${mode}) : null)()`,
          true,
        )
        reply({ ok: typeof response === 'string' && response.length > 0, mode, response, at: Date.now() })
        return
      }
      /**
       * C9′ — `getComputedStyle` 실측(색상·치수 대조). `properties` 는 읽을 CSS 속성 이름 목록.
       * 화면 자신의 출력이 아니라 브라우저 엔진이 계산한 값이라 관문 ⑤ 오라클 문제와 무관하다 —
       * 대조 대상(Orca 소스 리터럴)은 이 채널 밖(정적 소스 읽기)에서 따로 구한다.
       */
      case 'computed-style': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const selector = readString(parsed, 'selector')
        if (selector === null) throw new Error('selector 필요')
        const raw = parsed['properties']
        const properties = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
        const values = await target.webContents.executeJavaScript(
          `(() => {
             const el = document.querySelector(${JSON.stringify(selector)})
             if (!el) return null
             const style = getComputedStyle(el)
             const out = {}
             for (const prop of ${JSON.stringify(properties)}) out[prop] = style.getPropertyValue(prop)
             return out
           })()`,
          true,
        )
        reply({ ok: values !== null, selector, values, at: Date.now() })
        return
      }
      /** 치수 실측(C9′ⓑ) — `getBoundingClientRect()`. */
      case 'rect': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const selector = readString(parsed, 'selector')
        if (selector === null) throw new Error('selector 필요')
        const rect = await target.webContents.executeJavaScript(
          `(() => {
             const el = document.querySelector(${JSON.stringify(selector)})
             if (!el) return null
             const r = el.getBoundingClientRect()
             return { width: r.width, height: r.height, top: r.top, left: r.left }
           })()`,
          true,
        )
        reply({ ok: rect !== null, selector, rect, at: Date.now() })
        return
      }
      /**
       * 원 마우스 이벤트 하나를 좌표로 보낸다 — 드래그(mousedown→여러 mousemove→mouseup) 실측용.
       * `click` 은 한 지점을 눌렀다 떼는 것까지 한 걸음이라 리사이즈 드래그처럼 여러 중간 지점을
       * 지나야 하는 동작엔 못 쓴다. `type`(mouseDown/mouseMove/mouseUp)·x·y·button 필요.
       */
      case 'raw-mouse': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const type = readString(parsed, 'type')
        const x = readNumber(parsed, 'x')
        const y = readNumber(parsed, 'y')
        if (type !== 'mouseDown' && type !== 'mouseMove' && type !== 'mouseUp') throw new Error('type 은 mouseDown/mouseMove/mouseUp')
        if (x === null || y === null) throw new Error('x·y 필요')
        const rawButton = readString(parsed, 'button') ?? 'left'
        const button = rawButton === 'right' ? 'right' : rawButton === 'middle' ? 'middle' : 'left'
        if (type === 'mouseMove') target.webContents.sendInputEvent({ type, x, y })
        else target.webContents.sendInputEvent({ type, x, y, button, clickCount: 1 })
        reply({ ok: true, type, x, y, at: Date.now() })
        return
      }
      /**
       * 임의 JS 를 렌더러에서 평가해 결과를 돌려준다 — localStorage 실측(C2·C3 재기동 후 값
       * 확인) 등 전용 cmd 를 매번 늘리기엔 좁은 용도에 쓴다. **판정 대상 자신의 계산값을
       * 읽는 게 아니라 저장소 원값을 그대로 읽는 용도로만 쓴다**(관문 ⑤ — 이 채널로 상태를
       * 조작하지 않는다, 읽기만).
       */
      case 'eval': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        const code = readString(parsed, 'code')
        if (code === null) throw new Error('code 필요')
        const result: unknown = await target.webContents.executeJavaScript(code, true)
        reply({ ok: true, result: result === undefined ? null : result, at: Date.now() })
        return
      }
      /**
       * localStorage 등 DOM 저장소를 디스크에 강제 커밋한다 (C2·C3 재기동-후-유지 실측용).
       * Chromium 의 커밋 타이머를 기다리지 않고 `session.flushStorageData()` 로 즉시 내린다 —
       * 안 그러면 테스트 하네스가 SIGTERM 으로 죽일 때 아직 안 커밋된 값이 사라질 수 있다.
       */
      case 'flush-storage': {
        const target = handlers.window()
        if (target === null) throw new Error('창이 없다')
        target.webContents.session.flushStorageData()
        reply({ ok: true, at: Date.now() })
        return
      }
      default:
        reply({ ok: false, error: `모르는 cmd: ${cmd ?? '(없음)'}` })
        return
    }
  } catch (error) {
    log('control.failed', { cmd, error: String(error) })
    reply({ ok: false, error: String(error) })
  }
}
