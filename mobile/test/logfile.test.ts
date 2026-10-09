// 연결 기록 저장 → 재시작 복원 → 재복사 왕복 (LIFE-580 수정 r2 — R2-A3 · R2-A5).
// 실제 `runtime/logfile.ts`(파일 I/O 경계)를 쓰고, expo-file-system 의 `File` 만 node fs 위의 가짜로 바꾼다(임시 폴더). 네이티브 실행이 아니다.
// 왕복 대상: J5 원자료 `list_recv`(seq · serverAt · recvAt · offsetMs) · 시계차 `clock` 줄. r1 까지는 `list_recv` 의 서버 시각이 봉투 `at` 을
// 덮어 복원 파서가 줄을 버렸고, 다음 저장에서 파일에서도 사라졌다(리뷰어 재현 listLines 4 → restored 0).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionManager } from '../src/core/connection'
import { ListStore } from '../src/core/list-store'
import { ConnectionLog, parseLine } from '../src/core/log'
import { UnreadLedger, type UnreadData } from '../src/core/unread'
import { attachLogFile, readLogFile } from '../src/runtime/logfile'
import { FakeClock, FakeSocket, MemoryVault, SERVER, record } from './fakes'

const fsState = vi.hoisted(() => ({ dir: '' }))

vi.mock('expo-file-system', async () => {
  const nodeFs = await import('node:fs')
  const nodePath = await import('node:path')
  class File {
    readonly uri: string
    constructor(dir: string, name: string) {
      this.uri = nodePath.join(dir, name)
    }
    get exists(): boolean {
      return nodeFs.existsSync(this.uri)
    }
    textSync(): string {
      return nodeFs.readFileSync(this.uri, 'utf8')
    }
    create(): void {
      nodeFs.writeFileSync(this.uri, '')
    }
    write(text: string): void {
      nodeFs.writeFileSync(this.uri, text)
    }
  }
  return { File, Paths: { get document() { return fsState.dir } } }
})

class MemoryStore<T> {
  data: T | null = null
  load(): T | null {
    return this.data
  }
  save(data: T): void {
    this.data = data
  }
}

beforeEach(() => {
  fsState.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l580lf-'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(fsState.dir, { recursive: true, force: true })
})

function wire(seq: number) {
  return { type: 'list', epoch: 'e1', seq, at: 9_000_000 + seq, changedAt: 8_000_000 + seq, list: { available: true, repos: [], waiting: [] } }
}

/** 앱 한 번 — 연결·목록·기록을 붙이고 기록 파일에 잇는다(재시작이면 파일에서 복원부터). */
function bootApp(clock: FakeClock) {
  const log = new ConnectionLog(() => clock.now())
  log.restore(readLogFile())
  attachLogFile(log)
  const sockets: FakeSocket[] = []
  const manager = new ConnectionManager({
    openSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    vault: new MemoryVault(record()),
    clock,
    log,
    appVersion: '0.1.0',
    deviceName: 'Z Flip7',
  })
  const ledger = new UnreadLedger({ store: new MemoryStore<UnreadData>(), now: () => clock.now() })
  const store = new ListStore({ connection: manager, ledger, now: () => clock.now(), timer: clock, log })
  return { log, manager, store, sockets }
}

const fileLines = (): Record<string, unknown>[] =>
  fs
    .readFileSync(path.join(fsState.dir, 'connection-log.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))

describe('R2-A3 list_recv 저장 → 재시작 복원 → 재복사', () => {
  it('수신 4건과 시계차 줄이 파일에 남고, 재시작 뒤 복원·재복사·다음 저장까지 그대로 산다', async () => {
    const clock = new FakeClock()
    const first = bootApp(clock)
    await first.manager.start()
    const socket = first.sockets[first.sockets.length - 1]
    if (socket === undefined) throw new Error('소켓')
    socket.serverOpen()
    socket.serverSend({ type: 'hello', ok: true, protocol: 1, server: SERVER, device: { id: 'dev1', name: 'Z Flip7' } })
    clock.advance(8_000)
    const ping = socket.lastSent()
    clock.advance(30)
    socket.serverSend({ type: 'pong', id: ping?.id, at: clock.now() - 15 + 250 })
    for (let seq = 1; seq <= 4; seq += 1) {
      clock.advance(1_000)
      socket.serverSend(wire(seq))
    }
    vi.advanceTimersByTime(1_000) // 기록 파일 flush
    const saved = fileLines().filter((line) => line.event === 'list_recv')
    expect(saved).toHaveLength(4)
    for (const [index, line] of saved.entries()) {
      expect(typeof line.at).toBe('string') // 봉투 시각은 ISO 그대로
      expect(line).toMatchObject({ seq: index + 1, serverAt: 9_000_000 + index + 1, changedAt: 8_000_000 + index + 1, offsetMs: 250, rttMs: 30 })
      expect(Date.parse(String(line.at))).toBe(line.recvAt)
    }
    expect(fileLines().some((line) => line.event === 'clock')).toBe(true)

    // 재시작 — 새 앱이 파일에서 복원한다.
    const second = bootApp(clock)
    const restored = second.log.list().filter((entry) => entry.event === 'list_recv')
    expect(restored).toHaveLength(4)
    expect(restored.map((entry) => entry.detail.seq)).toEqual([1, 2, 3, 4])
    expect(restored[0]?.detail).toMatchObject({ serverAt: 9_000_001, offsetMs: 250 })
    // 재복사(「복사」 = text()) 에도 그대로.
    const copied = second.log.text().split('\n').map(parseLine)
    expect(copied.filter((entry) => entry?.event === 'list_recv')).toHaveLength(4)
    // 다음 저장(새 기록 한 줄) 뒤에도 파일에서 지워지지 않는다.
    second.log.add('probe', { why: 'manual' })
    vi.advanceTimersByTime(1_000)
    expect(fileLines().filter((line) => line.event === 'list_recv')).toHaveLength(4)
    expect(fileLines().filter((line) => line.event === 'clock').length).toBeGreaterThanOrEqual(1)
  })

  it('음성 대조 — 봉투 `at` 이 숫자로 덮인 줄(r1 모양)은 파서가 버린다 · 이제 detail 의 `at` 은 봉투를 덮지 못한다', () => {
    expect(parseLine(JSON.stringify({ at: 9_000_001, event: 'list_recv', seq: 1 }))).toBeNull()
    const log = new ConnectionLog(() => 5_000)
    log.add('x', { at: 123, event: 'y', seq: 1 })
    const line = log.text()
    const parsed = parseLine(line)
    expect(parsed).toMatchObject({ at: 5_000, event: 'x', detail: { atDetail: 123, eventDetail: 'y', seq: 1 } })
  })
})

describe('R2-A5 clock 줄의 원시 시각 = 선택된 표본', () => {
  it('RTT 10·20·…·90 ms 순서(offset 250) — 최단 표본이 창에서 빠진 뒤의 줄도 선택 표본의 sentAt·recvAt·serverAt 이다', async () => {
    const clock = new FakeClock()
    const app = bootApp(clock)
    await app.manager.start()
    const socket = app.sockets[app.sockets.length - 1]
    if (socket === undefined) throw new Error('소켓')
    socket.serverOpen()
    socket.serverSend({ type: 'hello', ok: true, protocol: 1, server: SERVER, device: { id: 'dev1', name: 'Z Flip7' } })
    for (let i = 1; i <= 9; i += 1) {
      clock.advance(8_000)
      const ping = socket.lastSent()
      const sentAt = clock.now()
      const rtt = i * 10
      clock.advance(rtt)
      socket.serverSend({ type: 'pong', id: ping?.id, at: sentAt + rtt / 2 + 250 })
    }
    const best = app.manager.clockSample()
    if (best === null) throw new Error('표본 없음')
    // ping 은 연결 관리자의 정기 타이머가 보낸다 — 왕복은 시험이 넣은 지연(10·20·…)보다 조금 길 수 있다. 첫 표본은 8개 창에서 빠졌다.
    expect(best.pingId).not.toBe(1)
    const lines = app.log.list().filter((entry) => entry.event === 'clock')
    const last = lines[lines.length - 1]?.detail
    if (last === undefined) throw new Error('clock 줄 없음')
    // 마지막 clock 줄 = 선택된 표본 그 자체(같은 ping · 원시 시각으로 rtt·offset 이 다시 계산된다).
    expect(last).toMatchObject({ pingId: best.pingId, sentAt: best.sentAt, recvAt: best.recvAt, serverAt: best.serverAt, rttMs: best.rttMs, offsetMs: best.offsetMs })
    expect(Number(last.recvAt) - Number(last.sentAt)).toBe(last.rttMs)
    expect(Math.round(Number(last.serverAt) - (Number(last.sentAt) + Number(last.recvAt)) / 2)).toBe(last.offsetMs)
    // 방금 받은 pong(왕복이 가장 긴 9번째)은 따로 — 선택 표본과 구분된다. r1 은 이 pong 의 시각을 선택 표본의 offset 과 한 줄에 섞었다.
    expect(last.latestPingId).not.toBe(last.pingId)
    expect(Number(last.latestRecvAt)).toBeGreaterThan(Number(last.recvAt))
  })
})
