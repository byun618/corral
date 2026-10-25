// LIFE-532 fix2 N-01 — herdr 설정 루트의 sessions 폴더를 못 읽어도(EACCES) 조회는 거부되지 않고 조회 오류가 된다.
// 그래야 연속 계수가 오르고 3회에 원인 `scan` 카드가 뜬다. 임시 디렉터리만 쓴다(사용자 ~/.config/herdr 무접촉).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSessions } from './adapter/index.js'
import { decideBackend, nextScanErrorStreak, type BackendInput } from './backend-start.js'

const saved = { xdg: process.env.XDG_CONFIG_HOME, herdr: process.env.HERDR_CONFIG_DIR, socket: process.env.CORRAL_BACKEND_SOCKET }
let root = ''
let locked = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'l532-eacces-'))
  const home = path.join(root, 'herdr')
  locked = path.join(home, 'sessions')
  fs.mkdirSync(locked, { recursive: true })
  // default 소켓 자리 — 폴백이 존재만 본다. 권한 오류가 이것까지 버리지 않는지 본다.
  fs.writeFileSync(path.join(home, 'herdr.sock'), '')
  fs.chmodSync(locked, 0o000)
  process.env.XDG_CONFIG_HOME = root
  delete process.env.HERDR_CONFIG_DIR
  delete process.env.CORRAL_BACKEND_SOCKET
})

afterEach(() => {
  fs.chmodSync(locked, 0o755)
  fs.rmSync(root, { recursive: true, force: true })
  const restore = (key: 'XDG_CONFIG_HOME' | 'HERDR_CONFIG_DIR' | 'CORRAL_BACKEND_SOCKET', value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('XDG_CONFIG_HOME', saved.xdg)
  restore('HERDR_CONFIG_DIR', saved.herdr)
  restore('CORRAL_BACKEND_SOCKET', saved.socket)
})

// root 는 권한을 무시한다 — 그때는 거부 경로 자체를 만들 수 없다.
const asRoot = process.getuid?.() === 0

describe.skipIf(asRoot)('sessions 폴더 권한 없음 (LIFE-532 fix2 N-01)', () => {
  it('바이너리 없음(폴백) — 거부하지 않고 오류 원문 + default 소켓', async () => {
    const scan = await listSessions({ binary: null, appDir: 'herdr' })
    expect(scan.error).toContain('EACCES')
    expect(scan.sessions.map((session) => session.name)).toEqual(['default'])
  })

  it('CLI 실패 → 폴백도 권한 오류 — 3회 연속이면 원인 scan 카드', async () => {
    const failing = path.join(root, 'herdr-fail.sh')
    fs.writeFileSync(failing, '#!/bin/sh\necho "permission denied" >&2\nexit 1\n', { mode: 0o755 })
    let streak = 0
    let last: BackendInput | null = null
    for (let poll = 1; poll <= 3; poll += 1) {
      const scan = await listSessions({ binary: failing, appDir: 'herdr' })
      const state = scan.error === null ? 'ok' : 'error'
      streak = nextScanErrorStreak({ streak, scan: state })
      last = {
        bound: null,
        binary: { kind: 'found' },
        sessions: scan.sessions,
        selected: 'default',
        link: { phase: 'connecting', attempt: poll },
        restore: null,
        starter: { phase: 'idle' },
        autoStartUsed: false,
        scan: state,
        scanErrorStreak: streak,
        scanError: scan.error,
        linkError: null,
      }
      const kind = decideBackend(last).status.kind
      expect(kind).toBe(poll < 3 ? 'ok' : 'unreachable')
    }
    expect(streak).toBe(3)
    if (last === null) throw new Error('조회를 한 번도 하지 않았다')
    const status = decideBackend(last).status
    expect(status.kind === 'unreachable' && status.cause).toBe('scan')
    expect(status.kind === 'unreachable' ? status.error : '').toContain('EACCES')
  })
})
