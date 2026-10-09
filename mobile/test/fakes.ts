// 단위 시험용 가짜 — 시계(수동 진행)·소켓(서버 쪽을 시험이 조종)·금고(메모리).
import type { Clock, PairingRecord, SocketLike, TimerHandle, Vault } from '../src/core/connection'

type Timer = { id: number; due: number; fn: () => void }

export class FakeClock implements Clock {
  private time = 1_000_000
  private seq = 0
  private timers: Timer[] = []

  now(): number {
    return this.time
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.seq += 1
    this.timers.push({ id: this.seq, due: this.time + ms, fn })
    return { id: this.seq }
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle.id)
  }

  pending(): number {
    return this.timers.length
  }

  /** 시간을 ms 만큼 흘리며 그사이 만기 타이머를 순서대로 돌린다. */
  advance(ms: number): void {
    const end = this.time + ms
    for (;;) {
      const next = this.timers.filter((timer) => timer.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0]
      if (next === undefined) break
      this.timers = this.timers.filter((timer) => timer.id !== next.id)
      this.time = Math.max(this.time, next.due)
      next.fn()
    }
    this.time = end
  }

  /** 백그라운드 흉내 — 타이머를 돌리지 않고 시간만 건너뛴다. */
  jump(ms: number): void {
    this.time += ms
  }
}

export class FakeSocket implements SocketLike {
  readyState = 0
  sent: Record<string, unknown>[] = []
  closedByClient: number | null = null
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open')
    this.sent.push(JSON.parse(data))
  }

  close(code?: number): void {
    this.closedByClient = code ?? 1000
    this.readyState = 3
  }

  // --- 서버 쪽 조종 ---
  serverOpen(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  serverSend(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) })
  }

  serverClose(code: number): void {
    this.readyState = 3
    this.onclose?.({ code })
  }

  serverError(): void {
    this.onerror?.({})
  }

  lastSent(): Record<string, unknown> | undefined {
    return this.sent[this.sent.length - 1]
  }
}

export class MemoryVault implements Vault {
  record: PairingRecord | null
  saves = 0
  clears = 0
  failSave = false

  constructor(record: PairingRecord | null = null) {
    this.record = record
  }

  async load(): Promise<PairingRecord | null> {
    return this.record
  }

  async save(record: PairingRecord): Promise<void> {
    if (this.failSave) throw new Error('disk full')
    this.saves += 1
    this.record = record
  }

  async clear(): Promise<void> {
    this.clears += 1
    this.record = null
  }
}

export const TOKEN = 'tok_SECRET_abcdefghijklmnopqrstuvwxyz012345'
export const CODE = 'ABCD2345'
export const URL = 'wss://mac.tailnet.ts.net:8577/ws'

export function record(overrides: Partial<PairingRecord> = {}): PairingRecord {
  return { token: TOKEN, url: URL, macName: '시험 맥', serverVersion: '0.2.0', deviceId: 'dev1', deviceName: 'Z Flip7', pairedAt: 1, ...overrides }
}

export const SERVER = { app: 'corral', version: '0.2.0', macName: '시험 맥' }

/** 마이크로태스크(금고 await)를 비운다. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}
