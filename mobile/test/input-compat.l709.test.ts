// LIFE-709 옛 앱 호환 (r1 L2g) — 앱이 모르는 실패 사유가 소켓으로 와도 수신 경로(ConnectionManager → `input` 이벤트 → InputStore)가
// 거절하지 않고, 말풍선 줄은 사유 없이 「보내지 못했습니다」 다. 옛 APK 가 새 허브의 `mac_input` 을 받는 경우와 같은 모양.
import { describe, expect, it } from 'vitest'
import { ConnectionManager } from '../src/core/connection'
import { sentLine } from '../src/core/input'
import { InputStore } from '../src/core/input-store'
import { ConnectionLog } from '../src/core/log'
import { FakeClock, FakeSocket, MemoryVault, SERVER, record } from './fakes'

describe('LIFE-709 모르는 사유 — 소켓 수신부터 저장·그리기까지', () => {
  it('input.state failed + 표에 없는 사유 → 저장은 그 사유 그대로, 줄은 「보내지 못했습니다」', async () => {
    const clock = new FakeClock()
    const sockets: FakeSocket[] = []
    const manager = new ConnectionManager({
      openSocket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket
      },
      vault: new MemoryVault(record()),
      clock,
      log: new ConnectionLog(() => clock.now()),
      appVersion: '0.1.0',
      deviceName: 'Z Flip7',
    })
    await manager.start()
    const socket = sockets.at(-1)
    if (socket === undefined) throw new Error('소켓 없음')
    socket.serverOpen()
    socket.serverSend({ type: 'hello', ok: true, protocol: 1, server: SERVER, device: { id: 'dev1', name: 'Z Flip7' } })
    expect(manager.getSnapshot().conn.kind).toBe('connected')

    const store = new InputStore({ connection: manager, now: () => clock.now(), timer: clock })
    const id = store.send({ channel: 'w1:p1', text: 'x', tailId: null })
    if (id === null) throw new Error('보내지 못함')
    expect(socket.sent.at(-1)).toMatchObject({ type: 'input.send', id })
    socket.serverSend({ type: 'input.state', protocol: 1, id, channel: 'w1:p1', op: 'send', state: 'failed', wait: null, reason: 'reason_from_a_newer_mac', at: 1 })

    const stored = store.getSnapshot().entries.find((entry) => entry.id === id)
    expect(stored).toMatchObject({ state: 'failed', reason: 'reason_from_a_newer_mac', acked: true })
    if (stored === undefined) throw new Error('저장 안 됨')
    expect(sentLine({ entry: stored, hhmm: () => '10:12' })).toMatchObject({ tone: 'error', text: '보내지 못했습니다', action: 'retry' })
  })
})
