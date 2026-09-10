// LIFE-342 스파이크 — herdr 소켓 최소 클라이언트.
//
// 설계 원칙 (01-criteria.md §5 우선순위 2): 응답을 래핑하지 않는다.
// 서버가 준 result/error 객체를 그대로 돌려준다. 파싱·정규화·타입 변환 없음.
//
// 안전 장치 (02-kickoff.md §2): 소켓 경로에 sessions/spike-claude 가 없으면 연결 자체를 거부한다.
// 사용자의 default 세션에 붙는 사고를 코드 레벨에서 막는다.

import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const SESSION_NAME = 'spike-claude'

/** 이 스파이크가 붙어도 되는 유일한 소켓 경로. */
export function socketPath() {
  const fromEnv = process.env.HERDR_SOCKET_PATH
  const p = fromEnv
    ? fromEnv.replace(/^~/, os.homedir())
    : path.join(os.homedir(), '.config', 'herdr', 'sessions', SESSION_NAME, 'herdr.sock')
  assertIsolated(p)
  return p
}

export function assertIsolated(p) {
  if (!p.includes(`sessions/${SESSION_NAME}`)) {
    throw new Error(
      `거부: 격리 세션 소켓이 아니다 (${p}). ` +
        `sessions/${SESSION_NAME} 를 포함해야 한다 — 02-kickoff.md §2`,
    )
  }
}

/**
 * NDJSON 커넥션 하나. 요청/응답과 구독 push 가 같은 줄 스트림에 섞여 온다.
 *
 * 줄을 받으면 원문 그대로 onLine 에 먼저 넘긴다 (원자료 기록용).
 * 그 다음 id 가 pending 요청과 맞으면 응답으로, 아니면 이벤트로 분류한다.
 */
export class Conn {
  constructor({ onLine, onEvent, onClose } = {}) {
    this.path = socketPath()
    this.seq = 0
    this.pending = new Map()
    this.onLine = onLine ?? (() => {})
    this.onEvent = onEvent ?? (() => {})
    this.onClose = onClose ?? (() => {})
    this.closed = false
    this.buf = ''
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.createConnection(this.path)
      this.sock.setEncoding('utf8')
      this.sock.once('connect', resolve)
      this.sock.once('error', (err) => {
        if (!this.sock.readyState || this.sock.readyState === 'opening') reject(err)
        else this._fail(err)
      })
      this.sock.on('data', (chunk) => this._onData(chunk))
      this.sock.on('close', () => {
        this.closed = true
        this._fail(new Error('socket closed'))
        this.onClose()
      })
    })
  }

  _onData(chunk) {
    this.buf += chunk
    let nl
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      const at = Date.now()
      this.onLine({ at, line })
      let msg
      try {
        msg = JSON.parse(line)
      } catch (err) {
        this.onEvent({ at, parseError: String(err), line })
        continue
      }
      const waiter = msg.id != null ? this.pending.get(msg.id) : undefined
      if (waiter) {
        this.pending.delete(msg.id)
        waiter.resolve({ at, msg })
      } else {
        this.onEvent({ at, msg, line })
      }
    }
  }

  _fail(err) {
    for (const [, w] of this.pending) w.reject(err)
    this.pending.clear()
  }

  /** 요청 1건. 응답 봉투를 통째로 돌려준다 — result 든 error 든 가공하지 않는다. */
  request(method, params = {}, { timeoutMs = 15000 } = {}) {
    const id = `c${++this.seq}`
    const sentAt = Date.now()
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      if (timeoutMs) {
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`timeout ${method} (${timeoutMs}ms)`))
        }, timeoutMs).unref?.()
      }
      this.sock.write(JSON.stringify({ id, method, params }) + '\n')
    })
    return p.then(({ at, msg }) => ({ ...msg, _sentAt: sentAt, _recvAt: at }))
  }

  /** 스키마에 없는 필드를 일부러 섞어 보내는 경로 (A6). */
  requestRaw(obj, { timeoutMs = 15000 } = {}) {
    const id = obj.id ?? `c${++this.seq}`
    const sentAt = Date.now()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      if (timeoutMs) {
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`timeout raw (${timeoutMs}ms)`))
        }, timeoutMs).unref?.()
      }
      this.sock.write(JSON.stringify({ ...obj, id }) + '\n')
    }).then(({ at, msg }) => ({ ...msg, _sentAt: sentAt, _recvAt: at }))
  }

  end() {
    this.closed = true
    this.sock?.end()
  }
}

/** 커넥션 하나 열고 요청 몇 개 던지고 닫는 짧은 경로. */
export async function withConn(fn, hooks) {
  const c = new Conn(hooks)
  await c.connect()
  try {
    return await fn(c)
  } finally {
    c.end()
  }
}

/** 요청 1건짜리 편의 함수. */
export async function call(method, params = {}) {
  return withConn((c) => c.request(method, params))
}

// --- 원자료 기록 ---------------------------------------------------------

export const RAW_DIR = new URL('../../specs/LIFE-342-spike/raw/claude/', import.meta.url).pathname

export function nowIso() {
  return new Date().toISOString()
}
