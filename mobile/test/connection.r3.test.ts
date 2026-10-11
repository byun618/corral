// 리뷰 r3 지적 시험 — R3-A1: 토큰 저장 중(pair·saving)에 받은 서버의 명시적 거절(revoked/4003 · unauthorized/4001, not_authenticated 제외)은
// 공통 해제 경로로 — 늦은 저장은 무효, 삭제는 그 저장 뒤, A1(이유). 그 밖의 종료는 저장 유지·재연결(R2-A1 그대로).
// 모양은 리뷰어 프로브(raw/review/codex-r3-raw/review-probes.test.ts · revoked-real-server.test.ts)를 따르되 고친 동작을 단언한다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PairingStore } from '../../app/src/main/mobile/pairing'
import { MobileServer } from '../../app/src/main/mobile/server'
import { createTimerClock } from '../src/core/clock'
import { ConnectionManager, type PairingRecord, type SocketLike } from '../src/core/connection'
import { ConnectionLog } from '../src/core/log'
import { DeferredVault, FakeClock, FakeSocket, SERVER, flush } from './fakes'

const A = { url: 'wss://a.example.ts.net:8577/ws', host: 'a.example.ts.net', code: 'ABCDEFGH' }

function setup() {
  const vault = new DeferredVault()
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const manager = new ConnectionManager({
    vault,
    clock,
    log: new ConnectionLog(() => clock.now()),
    appVersion: 'test',
    deviceName: 'test',
    openSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })
  return { manager, vault, clock, sockets }
}

/** pair → paired 수신 → 저장 대기까지. 첫 소켓을 돌려준다. */
async function pairedSaving(t: ReturnType<typeof setup>): Promise<FakeSocket> {
  await t.manager.start()
  t.manager.pair(A)
  const socket = t.sockets[0]
  if (socket === undefined) throw new Error('소켓 없음')
  socket.serverOpen()
  socket.serverSend({ type: 'paired', protocol: 1, server: SERVER, token: 'synthetic-A', device: { id: 'A', name: 'test' } })
  await flush()
  expect(t.manager.getSnapshot().pair).toMatchObject({ kind: 'pairing', saving: true })
  return socket
}

describe('R3-A1 — 저장 중 받은 명시적 거절은 해제 경로로', () => {
  it('revoked-before-save: paired → save 대기 → revoked/4003 → 서버 불통 → save·clear 완료 → A1(revoked) · 저장 토큰 없음 · 추가 hello 없음', async () => {
    const t = setup()
    const socket = await pairedSaving(t)
    socket.serverSend({ type: 'error', code: 'revoked', message: '' })
    socket.serverClose(4003)
    // 삭제가 끝나기 전에는 「해제됨」 아님 — 저장 중이라도 해제 중으로
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpairing', reason: 'revoked' })
    t.vault.op(0).finish()
    await flush()
    // 이미 떠난 save 뒤에 clear 가 줄을 섰다
    expect(t.vault.ops.map((op) => op.kind)).toEqual(['save', 'clear'])
    t.vault.op(1).finish()
    await flush()
    const snap = t.manager.getSnapshot()
    expect(snap.conn).toEqual({ kind: 'unpaired', reason: 'revoked' })
    expect(snap.pair.kind).toBe('idle')
    expect(snap.info).toBeNull()
    expect(t.vault.record).toBeNull()
    t.clock.advance(30_000)
    expect(t.sockets).toHaveLength(1)
    expect(socket.sent.map((message) => message.type)).toEqual(['pair'])
  })

  it('unauthorized/4001 도 같다 → A1(unauthorized)', async () => {
    const t = setup()
    const socket = await pairedSaving(t)
    socket.serverSend({ type: 'error', code: 'unauthorized', message: '' })
    socket.serverClose(4001)
    t.vault.op(0).finish()
    await flush()
    t.vault.op(1).finish()
    await flush()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'unauthorized' })
    expect(t.vault.record).toBeNull()
  })

  it('저장이 먼저 실패해도 해제는 그대로 끝난다(save 실패 → clear → A1)', async () => {
    const t = setup()
    const socket = await pairedSaving(t)
    socket.serverClose(4003)
    t.vault.op(0).fail()
    await flush()
    t.vault.op(1).finish()
    await flush()
    expect(t.manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'revoked' })
    expect(t.manager.getSnapshot().pair.kind).toBe('idle')
  })

  it('대조군 — 그 밖의 종료(1001·1006·4006·4008·4009 · not_authenticated 4001)는 저장 유지·재연결', async () => {
    for (const close of [{ code: 1001 }, { code: 1006 }, { code: 4006 }, { code: 4008 }, { code: 4009 }, { code: 4001, error: 'not_authenticated' }]) {
      const t = setup()
      const socket = await pairedSaving(t)
      if (close.error !== undefined) socket.serverSend({ type: 'error', code: close.error, message: '' })
      socket.serverClose(close.code)
      t.vault.op(0).finish()
      await flush()
      expect({ code: close.code, conn: t.manager.getSnapshot().conn.kind, pair: t.manager.getSnapshot().pair.kind, ops: t.vault.ops.map((op) => op.kind) }).toEqual({
        code: close.code,
        conn: 'reconnecting',
        pair: 'paired',
        ops: ['save'],
      })
      expect(t.vault.record?.token).toBe('synthetic-A')
      expect(t.sockets).toHaveLength(2)
    }
  })
})

async function until(pred: () => boolean): Promise<void> {
  const at = Date.now()
  while (Date.now() - at < 3_000) {
    if (pred()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('대기 시간 초과')
}

describe('R3-A1 — 실제 서버(MobileServer·PairingStore, loopback)', () => {
  it('저장 대기 중 맥에서 해지(revoke + disconnectDevice) → 서버 정지 → 저장 완료 → 삭제 1회 · 저장 토큰 없음 · A1(revoked) · 재연결 없음', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-revoke-'))
    const sockets: WebSocket[] = []
    const store = new PairingStore({ dir: path.join(dir, 'store') })
    store.load()
    const server = new MobileServer({ pairing: store, appVersion: 'test', macName: () => 'r3-server', log: () => {}, onChange: () => {} })
    let stored: PairingRecord | null = null
    let saveFinish: (() => void) | null = null
    let clears = 0
    const log = new ConnectionLog(() => Date.now())
    const manager = new ConnectionManager({
      vault: {
        load: async () => null,
        save: (record) =>
          new Promise<void>((done) => {
            saveFinish = () => {
              stored = record
              done()
            }
          }),
        clear: async () => {
          clears += 1
          stored = null
        },
      },
      clock: createTimerClock(),
      log,
      appVersion: 'test',
      deviceName: 'test',
      openSocket: (url) => {
        const ws = new WebSocket(url)
        sockets.push(ws)
        const adapter: SocketLike = {
          get readyState() {
            return ws.readyState
          },
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        }
        ws.on('open', () => adapter.onopen?.({}))
        ws.on('message', (data) => adapter.onmessage?.({ data: data.toString() }))
        ws.on('close', (code) => adapter.onclose?.({ code }))
        ws.on('error', () => adapter.onerror?.({}))
        return adapter
      },
    })
    try {
      const port = await server.start()
      await manager.start()
      manager.pair({ url: `ws://127.0.0.1:${port}/ws`, host: '127.0.0.1', code: store.createCode().code })
      await until(() => saveFinish !== null)
      const device = store.list()[0]
      if (device === undefined) throw new Error('기기 없음')
      store.revoke(device.id)
      server.disconnectDevice(device.id)
      await until(() => log.list().some((entry) => entry.event === 'closed' && entry.detail.code === 4003))
      await server.stop()
      const finish: () => void = saveFinish ?? (() => {})
      finish()
      await until(() => manager.getSnapshot().conn.kind === 'unpaired')
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(store.list()).toHaveLength(0)
      expect(stored).toBeNull()
      expect(clears).toBe(1)
      expect(manager.getSnapshot().conn).toEqual({ kind: 'unpaired', reason: 'revoked' })
      expect(manager.getSnapshot().pair.kind).toBe('idle')
      expect(sockets).toHaveLength(1)
      expect(log.list().some((entry) => entry.event === 'connect')).toBe(false)
    } finally {
      manager.setForeground(false)
      for (const ws of sockets) ws.terminate()
      await server.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
