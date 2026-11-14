// LIFE-788 — corral.ndjson 크기 상한 회전 (C2 열 때 · C3 줄 무결성 · C4 실패 내성 · 상한 환경변수)

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeLog,
  DEFAULT_MAX_BYTES,
  log,
  maxBytesFromEnv,
  openLog,
  ROTATE_MAX_FAILURES,
  ROTATE_RETRY_MS
} from './log'

const T0 = new Date('2026-11-15T00:00:00.000Z')

let dir = ''
let file = ''
let streams: fs.WriteStream[] = []

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l788-'))
  file = path.join(dir, 'corral.ndjson')
  vi.stubEnv('CORRAL_LOG', file)
  vi.stubEnv('CORRAL_LOG_MAX_BYTES', '1000')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  streams = []
  const create = fs.createWriteStream
  vi.spyOn(fs, 'createWriteStream').mockImplementation((p, o) => {
    const s = create(p, o)
    streams.push(s)
    return s
  })
})

afterEach(() => {
  closeLog()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  fs.chmodSync(dir, 0o755)
  fs.rmSync(dir, { recursive: true, force: true })
})

// 열었던 stream 전부(회전으로 끝낸 것 포함)가 닫힐 때까지 — 그 뒤에야 파일 내용이 확정된다.
async function flush(): Promise<void> {
  closeLog()
  await Promise.all(streams.map((s) => (s.closed ? Promise.resolve() : new Promise<void>((r) => s.once('close', () => r())))))
}

function sha(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function lines(p: string): Record<string, unknown>[] {
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const v: unknown = JSON.parse(l)
      if (typeof v !== 'object' || v === null) throw new Error(`not an object: ${l}`)
      return Object.fromEntries(Object.entries(v))
    })
}

function tags(p: string): unknown[] {
  return lines(p).map((l) => l.tag)
}

function lineBytes(tag: string, fields: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify({ ts: T0.toISOString(), at: T0.getTime(), tag, ...fields }) + '\n')
}

// bytes 바이트짜리 JSON 한 줄 — 기존 로그 흉내
function fill(p: string, bytes: number): void {
  fs.writeFileSync(p, `{"tag":"t.old","pad":"${'x'.repeat(bytes - 25)}"}\n`)
  expect(fs.statSync(p).size).toBe(bytes)
}

describe('maxBytesFromEnv — 잘못된 값은 기본값', () => {
  it.each([undefined, '', '  ', 'abc', '0', '-5', '1.5', 'NaN', 'Infinity', '9007199254740993'])('%s → 기본값', (v) => {
    expect(maxBytesFromEnv(v)).toBe(DEFAULT_MAX_BYTES)
  })

  it('양의 정수는 그대로', () => {
    expect(maxBytesFromEnv('1000')).toBe(1000)
    expect(DEFAULT_MAX_BYTES).toBe(104_857_600)
  })

  it('openLog 도 잘못된 값이면 기본 상한 — 1000 바이트 넘는 파일을 밀지 않는다', async () => {
    vi.stubEnv('CORRAL_LOG_MAX_BYTES', 'abc')
    fill(file, 5000)
    openLog(dir)
    log('t.after', {})
    await flush()
    expect(fs.existsSync(`${file}.1`)).toBe(false)
    expect(fs.statSync(file).size).toBe(5000 + lineBytes('t.after', {}))
  })
})

describe('C2 열 때 회전', () => {
  it('기존 파일이 상한을 넘으면 .1 로 밀고(바이트·해시 보존) 새 파일에 쓴다', async () => {
    fill(file, 1500)
    const before = sha(file)
    expect(openLog(dir)).toBe(file)
    log('t.after', { n: 1 })
    await flush()
    expect(fs.statSync(`${file}.1`).size).toBe(1500)
    expect(sha(`${file}.1`)).toBe(before)
    expect(tags(file)).toEqual(['log.rotated', 't.after'])
    expect(lines(file)[0]).toMatchObject({ phase: 'open', bytes: 1500, maxBytes: 1000 })
  })

  it('상한과 같으면 밀지 않는다', async () => {
    fill(file, 1000)
    const before = sha(file)
    openLog(dir)
    await flush()
    expect(fs.existsSync(`${file}.1`)).toBe(false)
    expect(sha(file)).toBe(before)
  })

  it('상한 아래면 밀지 않고 이어 쓴다', async () => {
    fill(file, 900)
    const before = fs.readFileSync(file)
    openLog(dir)
    log('t.after', {})
    await flush()
    expect(fs.existsSync(`${file}.1`)).toBe(false)
    const after = fs.readFileSync(file)
    expect(after.subarray(0, 900).equals(before)).toBe(true)
    expect(after.length).toBe(900 + lineBytes('t.after', {}))
  })

  it('세대가 이미 있으면 .1 → .2, 이전 .2 는 사라지고 .3 은 생기지 않는다', async () => {
    fs.writeFileSync(`${file}.2`, 'gen2\n')
    fs.writeFileSync(`${file}.1`, 'gen1\n')
    fill(file, 1200)
    const cur = sha(file)
    openLog(dir)
    await flush()
    expect(fs.readFileSync(`${file}.2`, 'utf8')).toBe('gen1\n')
    expect(sha(`${file}.1`)).toBe(cur)
    expect(fs.existsSync(`${file}.3`)).toBe(false)
  })

  it('파일이 없으면 새로 만든다', async () => {
    openLog(dir)
    log('t.first', {})
    await flush()
    expect(tags(file)).toEqual(['t.first'])
  })
})

describe('도는 중 회전 경계', () => {
  it('누적이 상한과 같으면 그대로, 넘는 쓰기 뒤에 회전한다', async () => {
    const one = lineBytes('t.x', {})
    fill(file, 1000 - one)
    openLog(dir)
    log('t.x', {})
    expect(fs.existsSync(`${file}.1`)).toBe(false)
    log('t.y', {})
    expect(fs.existsSync(`${file}.1`)).toBe(true)
    log('t.z', {})
    await flush()
    expect(fs.statSync(`${file}.1`).size).toBe(1000 + lineBytes('t.y', {}))
    expect(tags(`${file}.1`).slice(-2)).toEqual(['t.x', 't.y'])
    expect(tags(file)).toEqual(['log.rotated', 't.z'])
  })

  it('쓰기마다 stat 하지 않는다', () => {
    openLog(dir)
    const stat = vi.spyOn(fs, 'statSync')
    for (let i = 0; i < 50; i++) log('t.x', { i })
    expect(stat).not.toHaveBeenCalled()
  })
})

describe('C3 줄 무결성', () => {
  it('회전 3회 이상 동안 모든 줄이 파싱되고 남은 세대의 순번이 빠짐·중복 없이 연속', async () => {
    openLog(dir)
    const pad = 'p'.repeat(40)
    const per = lineBytes('t.seq', { seq: 100, pad })
    const n = Math.ceil((1000 * 5) / per)
    for (let seq = 0; seq < n; seq++) log('t.seq', { seq, pad })
    await flush()
    expect(fs.existsSync(`${file}.3`)).toBe(false)
    const all = [...lines(`${file}.2`), ...lines(`${file}.1`), ...lines(file)]
    const seqs = all.filter((l) => l.tag === 't.seq').map((l) => l.seq)
    expect(seqs.length).toBeGreaterThan(0)
    const first = seqs[0]
    expect(typeof first).toBe('number')
    expect(first).toBeGreaterThan(0) // 가장 오래된 세대는 지워졌다
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => Number(first) + i))
    expect(seqs[seqs.length - 1]).toBe(n - 1)
    // 남은 세대 셋이 모두 log.rotated 로 시작한다 — 첫 파일(회전 줄 없음)이 지워졌으니 회전 ≥ 3회
    expect([file, `${file}.1`, `${file}.2`].map((p) => tags(p)[0])).toEqual(['log.rotated', 'log.rotated', 'log.rotated'])
    for (const p of [file, `${file}.1`, `${file}.2`]) expect(fs.statSync(p).size).toBeLessThanOrEqual(1000 + per)
  })
})

describe('C4 회전 실패 내성', () => {
  it('쓰기 불가 디렉터리 — 던지지 않고 실패 태그를 남기며 간격·횟수 상한을 지킨다', async () => {
    openLog(dir)
    const rename = vi.spyOn(fs, 'renameSync')
    fs.chmodSync(dir, 0o555)
    const pad = 'p'.repeat(100)
    const burst = (): void => {
      for (let i = 0; i < 20; i++) expect(() => log('t.x', { pad })).not.toThrow()
    }
    burst()
    const perAttempt = rename.mock.calls.length
    expect(perAttempt).toBeGreaterThan(0)
    burst() // 간격 안 — 재시도 없음
    expect(rename.mock.calls.length).toBe(perAttempt)
    vi.setSystemTime(T0.getTime() + ROTATE_RETRY_MS - 1)
    burst()
    expect(rename.mock.calls.length).toBe(perAttempt)
    for (let k = 2; k <= ROTATE_MAX_FAILURES + 2; k++) {
      vi.setSystemTime(T0.getTime() + ROTATE_RETRY_MS * k)
      burst()
    }
    expect(rename.mock.calls.length).toBe(perAttempt * ROTATE_MAX_FAILURES)
    fs.chmodSync(dir, 0o755)
    await flush()
    const failed = lines(file).filter((l) => l.tag === 'log.rotate.failed')
    expect(failed.length).toBe(ROTATE_MAX_FAILURES)
    expect(failed.map((l) => l.failures)).toEqual([1, 2, 3, 4, 5])
    expect(failed[ROTATE_MAX_FAILURES - 1]).toMatchObject({ phase: 'run', gaveUp: true })
    expect(String(failed[0]?.error)).toMatch(/EACCES|EPERM/)
    expect(fs.existsSync(`${file}.1`)).toBe(false)
  })

  it('주입된 rename 오류 — 다음 간격 뒤 회복하면 회전하고 실패 횟수가 초기화된다', async () => {
    openLog(dir)
    const real = fs.renameSync
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('injected rename')
    })
    const pad = 'p'.repeat(100)
    for (let i = 0; i < 12; i++) log('t.x', { i, pad })
    expect(fs.existsSync(`${file}.1`)).toBe(false)
    rename.mockImplementation(real)
    vi.setSystemTime(T0.getTime() + ROTATE_RETRY_MS)
    log('t.after', { pad })
    expect(fs.existsSync(`${file}.1`)).toBe(true)
    await flush()
    const old = lines(`${file}.1`)
    expect(old.filter((l) => l.tag === 'log.rotate.failed')).toEqual([
      expect.objectContaining({ phase: 'run', failures: 1, gaveUp: false, error: 'injected rename' })
    ])
    expect(old.at(-1)?.tag).toBe('t.after')
    expect(tags(file)).toEqual(['log.rotated'])
  })

  it('새 파일 열기 실패 — 밀었던 파일을 되돌리고 같은 파일에 계속 쓴다', async () => {
    openLog(dir)
    const open = vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('injected open')
    })
    const pad = 'p'.repeat(100)
    for (let i = 0; i < 12; i++) expect(() => log('t.x', { i, pad })).not.toThrow()
    expect(open).toHaveBeenCalledTimes(1)
    await flush()
    expect(fs.existsSync(`${file}.1`)).toBe(false)
    const all = lines(file)
    expect(all.map((l) => l.i).filter((i) => i !== undefined)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    expect(all.filter((l) => l.tag === 'log.rotate.failed')).toEqual([
      expect.objectContaining({ phase: 'run', failures: 1, error: 'injected open' })
    ])
  })

  it('열 때 회전 실패 — 던지지 않고 기존 파일에 이어 쓰며 실패를 남긴다', async () => {
    fill(file, 1500)
    fs.chmodSync(dir, 0o555)
    expect(() => openLog(dir)).not.toThrow()
    log('t.after', {})
    expect(() => log('t.after2', {})).not.toThrow()
    fs.chmodSync(dir, 0o755)
    await flush()
    expect(fs.existsSync(`${file}.1`)).toBe(false)
    expect(fs.statSync(file).size).toBeGreaterThan(1500)
    expect(tags(file)[0]).toBe('t.old')
    expect(lines(file).filter((l) => l.tag === 'log.rotate.failed')).toEqual([
      expect.objectContaining({ phase: 'open', failures: 1, gaveUp: false })
    ])
    expect(tags(file).slice(-2)).toEqual(['t.after', 't.after2'])
  })
})
