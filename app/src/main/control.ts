// 계측용 제어 채널 — **CORRAL_CONTROL_SOCKET 이 설정된 실행에서만** 열린다.
//
// 왜 있나: 판정 근거가 "화면"과 "타임스탬프 로그"를 함께 요구한다 (K6·L3·L4). 사람 손으로
// 클릭해 가며 찍으면 재현이 안 되므로, 측정 스크립트가 라벨을 붙여 스크린샷을 요청하고
// 선택을 바꿀 수 있게 얇은 채널을 둔다. 평시 실행에는 열리지 않는다.
//
// 프로토콜은 앱의 herdr 클라이언트와 같은 NDJSON: {"cmd":"shot","name":"k6-before"}

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { isRecord, readString } from './herdr/protocol.js'
import { log } from './log.js'
import { checkUnixSocketPath } from './unix-socket-path.js'

export type ControlHandlers = {
  capture: (name: string) => Promise<string>
  selectSession: (name: string) => void
  selectPane: (paneId: string | null) => void
  toggleCollapse: (workspaceId: string) => void
  state: () => unknown
  verify: () => Promise<unknown>
}

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
        const file = await handlers.capture(readString(parsed, 'name') ?? 'shot')
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
      default:
        socket.write(JSON.stringify({ ok: false, error: `모르는 cmd: ${cmd}` }) + '\n')
    }
  } catch (error) {
    socket.write(JSON.stringify({ ok: false, error: String(error) }) + '\n')
  }
}
