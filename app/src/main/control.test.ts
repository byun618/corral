// LIFE-577 리뷰 r2 R2-A5 — 실제 계측 소켓(`startControlServer`)의 `mobile-pairing` 이 비공개가 아닌 소켓에서 거절되고
// **코드를 만드는 함수가 불리지 않는다**(음성 대조). 비공개 소켓에서는 불린다(양성 대조). electron·log 만 가짜로 바꾼다.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ Menu: {}, Notification: class {} }))
vi.mock('./log.js', () => ({ log: () => {} }))

const { startControlServer } = await import('./control.js')
type Handlers = Parameters<typeof startControlServer>[0]

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  delete process.env.CORRAL_CONTROL_SOCKET
})

function handlers(createPairing: () => unknown): Handlers {
  return {
    capture: async () => '',
    state: () => null,
    window: () => null,
    resync: async () => ({ ok: true, note: '' }),
    setDroppingPush: () => {},
    addRepo: () => ({ ok: false }),
    rebuildTree: async () => {},
    setDialogStub: () => {},
    resizeWindow: () => {},
    readClipboard: async () => '',
    counters: () => null,
    mobile: { status: () => null, createPairing, revoke: () => false },
    explorer: { status: () => null, crash: () => false },
    fileWatch: { status: () => null, drop: () => undefined },
  }
}

async function run(input: { dirMode: number; socketMode: number | null }): Promise<{ reply: Record<string, unknown>; calls: number }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l577k-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'c')
  fs.mkdirSync(dir)
  fs.chmodSync(dir, input.dirMode)
  const socketPath = path.join(dir, 's.sock')
  process.env.CORRAL_CONTROL_SOCKET = socketPath
  let calls = 0
  const server = startControlServer(handlers(() => { calls += 1; return { ok: true, code: 'SYNTHETIC' } }))
  if (server === null) throw new Error('계측 소켓이 열리지 않았다')
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  for (let i = 0; i < 100 && !fs.existsSync(socketPath); i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  await new Promise((resolve) => setTimeout(resolve, 20))
  if (input.socketMode !== null) fs.chmodSync(socketPath, input.socketMode)
  const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const client = net.connect(socketPath, () => client.write(JSON.stringify({ cmd: 'mobile-pairing' }) + '\n'))
    let text = ''
    client.setEncoding('utf8')
    client.on('data', (chunk) => {
      text += String(chunk)
      if (text.includes('\n')) {
        client.end()
        resolve(JSON.parse(text.slice(0, text.indexOf('\n'))))
      }
    })
    client.on('error', reject)
  })
  return { reply, calls }
}

describe('계측 소켓 mobile-pairing 관문 (R2-A5)', () => {
  it('폴더 0755 · 소켓 0666 → control_socket_not_private, 코드 생성 0회(음성 대조)', async () => {
    const { reply, calls } = await run({ dirMode: 0o755, socketMode: 0o666 })
    expect(reply).toEqual({ ok: false, error: 'control_socket_not_private' })
    expect(calls).toBe(0)
  })

  it('폴더 0700 이어도 소켓 0666 → 거절, 코드 생성 0회', async () => {
    const { reply, calls } = await run({ dirMode: 0o700, socketMode: 0o666 })
    expect(reply).toMatchObject({ ok: false, error: 'control_socket_not_private' })
    expect(calls).toBe(0)
  })

  it('폴더 0700 · 소켓 0600(생성 그대로) → 코드 생성 1회(양성 대조)', async () => {
    const { reply, calls } = await run({ dirMode: 0o700, socketMode: null })
    expect(reply).toMatchObject({ ok: true, pairing: { ok: true } })
    expect(calls).toBe(1)
  })
})
