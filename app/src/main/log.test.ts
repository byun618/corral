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
  retryDelay,
  ROTATE_RETRY_MAX_MS,
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

  // 시험·관문용 변수라 Number() 가 받는 형태를 그대로 받는다 — 수용 형태를 고정한다.
  it.each([
    [' 2000 ', 2000],
    ['1e3', 1000],
    ['0x10', 16],
    ['0b11', 3],
    ['1', 1]
  ])('%s → %d', (v, n) => {
    expect(maxBytesFromEnv(v)).toBe(n)
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

  it('한글(멀티바이트) 줄 — 누적은 바이트 기준이라 모든 세대가 상한 + 한 줄 안이다', async () => {
    openLog(dir)
    const pad = '한글'.repeat(20)
    const per = lineBytes('t.seq', { seq: 100, pad })
    expect(per).toBeGreaterThan(pad.length * 2) // 문자 수와 바이트 수가 크게 다르다
    const n = Math.ceil((1000 * 5) / per)
    for (let seq = 0; seq < n; seq++) log('t.seq', { seq, pad })
    await flush()
    for (const p of [file, `${file}.1`, `${file}.2`]) expect(fs.statSync(p).size).toBeLessThanOrEqual(1000 + per)
    const seqs = [...lines(`${file}.2`), ...lines(`${file}.1`), ...lines(file)]
      .filter((l) => l.tag === 't.seq')
      .map((l) => l.seq)
    expect(seqs.at(-1)).toBe(n - 1)
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => n - seqs.length + i))
  })
})

describe('C4 회전 실패 내성', () => {
  const pad = 'p'.repeat(100)
  // 상한(1000)을 넘길 만큼 쓴다 — 회전 시도가 한 번 일어난다(간격 안이면 시도 없음).
  const burst = (): void => {
    for (let i = 0; i < 8; i++) expect(() => log('t.x', { pad })).not.toThrow()
  }
  const realOpen = fs.openSync
  const realRename = fs.renameSync

  // .next(새 파일) 열기만 실패시킨다.
  function failNextOpen(): { failing: boolean } {
    const state = { failing: true }
    vi.spyOn(fs, 'openSync').mockImplementation((p, flags, mode) => {
      if (state.failing && String(p).endsWith('.next')) throw Object.assign(new Error('injected open'), { code: 'EIO' })
      return realOpen(p, flags, mode)
    })
    return state
  }

  function failRenameFrom(src: string, code: string): void {
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === src) throw Object.assign(new Error(`injected ${code}`), { code })
      realRename(from, to)
    })
  }

  function failures(p: string): Record<string, unknown>[] {
    return lines(p).filter((l) => l.tag === 'log.rotate.failed')
  }

  it('retryDelay — 1분에서 두 배씩, 1시간 상한', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(retryDelay)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000
    ])
    expect(ROTATE_RETRY_MS).toBe(60_000)
    expect(ROTATE_RETRY_MAX_MS).toBe(3_600_000)
  })

  it('쓰기 불가 디렉터리 — 던지지 않고, 간격을 늘리며 포기 없이 재시도하고, 해소되면 회전한다', async () => {
    openLog(dir)
    const open = vi.spyOn(fs, 'openSync')
    const rename = vi.spyOn(fs, 'renameSync')
    fs.chmodSync(dir, 0o555)
    let now = T0.getTime()
    burst()
    expect(open).toHaveBeenCalledTimes(1)
    const attempts = 9 // 이전 상한(5회)을 넘긴다
    for (let k = 1; k < attempts; k++) {
      now += retryDelay(k)
      vi.setSystemTime(now - 1)
      burst() // 간격 안 — 재시도 없음
      expect(open).toHaveBeenCalledTimes(k)
      vi.setSystemTime(now)
      burst()
      expect(open).toHaveBeenCalledTimes(k + 1)
    }
    expect(rename).not.toHaveBeenCalled() // 새 파일을 못 열면 아무 rename 도 하지 않는다
    fs.chmodSync(dir, 0o755)
    now += retryDelay(attempts)
    vi.setSystemTime(now)
    log('t.x', { pad }) // 누적은 이미 상한 위 — 한 줄로 회전한다
    expect(open).toHaveBeenCalledTimes(attempts + 1)
    expect(fs.existsSync(`${file}.1`)).toBe(true)
    await flush()
    const failed = failures(`${file}.1`)
    expect(failed.map((l) => l.failures)).toEqual(Array.from({ length: attempts }, (_, i) => i + 1))
    expect(failed.map((l) => l.retryInMs)).toEqual(Array.from({ length: attempts }, (_, i) => retryDelay(i + 1)))
    expect(String(failed[0]?.error)).toMatch(/EACCES|EPERM/)
    expect(tags(file)[0]).toBe('log.rotated')
    expect(fs.existsSync(`${file}.next`)).toBe(false)
  })

  it('성공 회전 뒤 연속 실패 횟수가 초기화된다 — 다시 실패하면 failures 1·간격 1분', async () => {
    openLog(dir)
    const state = failNextOpen()
    let now = T0.getTime()
    burst()
    for (let k = 1; k < 3; k++) {
      now += retryDelay(k)
      vi.setSystemTime(now)
      burst()
    }
    state.failing = false
    now += retryDelay(3)
    vi.setSystemTime(now)
    log('t.x', { pad })
    expect(fs.existsSync(`${file}.1`)).toBe(true)
    state.failing = true
    burst()
    await flush()
    expect(failures(`${file}.1`).map((l) => l.failures)).toEqual([1, 2, 3])
    expect(failures(file)).toEqual([expect.objectContaining({ phase: 'run', failures: 1, retryInMs: ROTATE_RETRY_MS })])
  })

  it('새 파일 열기 실패 — 어떤 rename 도 하지 않고 모든 세대의 바이트가 그대로다', async () => {
    fs.writeFileSync(`${file}.2`, '{"tag":"gen2"}\n')
    fs.writeFileSync(`${file}.1`, '{"tag":"gen1"}\n')
    openLog(dir)
    failNextOpen()
    const rename = vi.spyOn(fs, 'renameSync')
    const gens = [`${file}.1`, `${file}.2`].map(sha)
    for (let i = 0; i < 12; i++) expect(() => log('t.x', { i, pad })).not.toThrow()
    await flush()
    expect(rename).not.toHaveBeenCalled()
    expect([`${file}.1`, `${file}.2`].map(sha)).toEqual(gens)
    expect(fs.existsSync(`${file}.next`)).toBe(false)
    expect(lines(file).map((l) => l.i).filter((i) => i !== undefined)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    expect(failures(file)).toEqual([expect.objectContaining({ phase: 'run', failures: 1, error: 'injected open' })])
  })

  it('.1 → .2 가 ENOENT 아닌 오류면 기존 .1 을 덮지 않는다 — 세대는 그대로, 현재 파일에 계속', async () => {
    fs.writeFileSync(`${file}.2`, '{"tag":"gen2"}\n')
    fs.writeFileSync(`${file}.1`, '{"tag":"gen1"}\n')
    openLog(dir)
    failRenameFrom(`${file}.1`, 'EPERM')
    burst()
    await flush()
    expect(tags(`${file}.1`)).toEqual(['gen1'])
    expect(tags(`${file}.2`)).toEqual(['gen2'])
    expect(fs.existsSync(`${file}.next`)).toBe(false)
    expect(tags(file).filter((t) => t === 't.x')).toHaveLength(8)
    expect(failures(file)).toEqual([expect.objectContaining({ phase: 'run', failures: 1, error: 'injected EPERM' })])
  })

  it('현재 → .1 실패 — .2 → .1 을 되돌려 옛 .1 은 남고, 이전 .2 는 잃는다(주석의 잔여)', async () => {
    fs.writeFileSync(`${file}.2`, '{"tag":"gen2"}\n')
    fs.writeFileSync(`${file}.1`, '{"tag":"gen1"}\n')
    openLog(dir)
    failRenameFrom(file, 'EPERM')
    burst()
    await flush()
    expect(tags(`${file}.1`)).toEqual(['gen1'])
    expect(fs.existsSync(`${file}.2`)).toBe(false)
    expect(fs.existsSync(`${file}.next`)).toBe(false)
    expect(tags(file).filter((t) => t === 't.x')).toHaveLength(8)
    expect(failures(file)).toHaveLength(1)
  })

  it('주입된 rename 오류 — 다음 간격 뒤 회복하면 회전한다', async () => {
    openLog(dir)
    failRenameFrom(file, 'EIO')
    burst()
    expect(fs.existsSync(`${file}.1`)).toBe(false)
    vi.mocked(fs.renameSync).mockImplementation(realRename)
    vi.setSystemTime(T0.getTime() + ROTATE_RETRY_MS)
    log('t.after', { pad })
    expect(fs.existsSync(`${file}.1`)).toBe(true)
    await flush()
    expect(failures(`${file}.1`)).toEqual([
      expect.objectContaining({ phase: 'run', failures: 1, retryInMs: ROTATE_RETRY_MS, error: 'injected EIO' })
    ])
    expect(tags(`${file}.1`).at(-1)).toBe('t.after')
    expect(tags(file)).toEqual(['log.rotated'])
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
    expect(tags(file)[0]).toBe('t.old')
    expect(failures(file)).toEqual([expect.objectContaining({ phase: 'open', failures: 1, retryInMs: ROTATE_RETRY_MS })])
    expect(tags(file).slice(-2)).toEqual(['t.after', 't.after2'])
  })

  // 파일을 못 열면 stdout 으로 간다 — 실패 줄(log.open.failed)과 이후 줄 모두 stdout 에 남는다.
  it.each([
    ['상한 아래', 500],
    ['상한 초과(열 때 회전과 겹침)', 1500]
  ])('열 때 파일 열기 실패(%s) — openLog·log 가 던지지 않고 stdout 으로, 파일은 그대로', async (_, bytes) => {
    fill(file, bytes)
    const before = sha(file)
    const open = vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw Object.assign(new Error('injected open'), { code: 'EMFILE' })
    })
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk))
      return true
    })
    expect(() => openLog(dir)).not.toThrow()
    for (let i = 0; i < 20; i++) expect(() => log('t.after', { i, pad })).not.toThrow()
    await flush()
    open.mockRestore() // readFileSync 도 openSync 를 쓴다
    vi.mocked(process.stdout.write).mockRestore()
    const tagsOut = out.map((l) => {
      const v: unknown = JSON.parse(l)
      return typeof v === 'object' && v !== null && 'tag' in v ? v.tag : undefined
    })
    expect(tagsOut[0]).toBe('log.open.failed')
    expect(tagsOut.filter((t) => t === 't.after')).toHaveLength(20)
    expect(sha(file)).toBe(before)
    expect(fs.existsSync(`${file}.1`)).toBe(false)
    expect(fs.existsSync(`${file}.next`)).toBe(false)
  })
})

// LIFE-788 r3 (리뷰 r2 H~M) — 회전 뒤 외부 조작·되돌리기 멈춤·재열기·생존 변이 판별
describe('r3 — 외부 조작·되돌리기·재열기', () => {
  const pad = 'p'.repeat(100)
  const burst = (): void => {
    for (let i = 0; i < 8; i++) expect(() => log('t.x', { i, pad })).not.toThrow()
  }
  const realOpen = fs.openSync
  const realRename = fs.renameSync

  function failRename(pred: (from: string, to: string) => boolean): void {
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (pred(String(from), String(to))) throw Object.assign(new Error('injected rename'), { code: 'EIO' })
      realRename(from, to)
    })
  }

  // 지금까지 받은 쓰기가 전부 파일에 닿을 때까지(stream 은 열어 둔 채).
  async function drain(): Promise<void> {
    await vi.waitFor(() => {
      for (const s of streams) expect(s.writableLength).toBe(0)
    })
  }

  function captureStdout(): string[] {
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk))
      return true
    })
    return out
  }

  function stdoutTags(out: string[]): unknown[] {
    return out.map((l) => {
      const v: unknown = JSON.parse(l)
      return typeof v === 'object' && v !== null && 'tag' in v ? v.tag : undefined
    })
  }

  function allText(): string {
    return fs
      .readdirSync(dir)
      .map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
      .join('')
  }

  it('H 회전 뒤 외부에서 현재 파일을 0 으로 잘라도 다음 줄은 NUL 없이 맨 앞에 붙는다(O_APPEND)', async () => {
    openLog(dir)
    burst()
    expect(fs.existsSync(`${file}.1`)).toBe(true)
    await drain()
    expect(fs.statSync(file).size).toBeGreaterThan(0)
    fs.truncateSync(file, 0)
    log('t.after', {})
    await flush()
    const text = fs.readFileSync(file, 'utf8')
    expect(text.includes('\u0000')).toBe(false)
    expect(tags(file)).toEqual(['t.after'])
  })

  it('H 남아 있던 .next 의 내용은 새 로그 머리에 오지 않는다(O_TRUNC)', async () => {
    fs.writeFileSync(`${file}.next`, '{"tag":"stale"}\n'.repeat(5))
    openLog(dir)
    burst()
    await flush()
    expect(tags(file)[0]).toBe('log.rotated')
    expect(tags(file)).not.toContain('stale')
    expect(fs.existsSync(`${file}.next`)).toBe(false)
  })

  it('I .next → 현재 실패 + .1 → 현재 되돌리기 실패 — 되돌리기를 멈춰 활성 세대 본문이 남는다', async () => {
    fs.writeFileSync(`${file}.2`, '{"tag":"gen2"}\n')
    fs.writeFileSync(`${file}.1`, '{"tag":"gen1"}\n')
    openLog(dir)
    failRename((from, to) => from === `${file}.next` || (from === `${file}.1` && to === file))
    burst()
    await flush()
    // 현재 파일 내용은 .1 에(옛 stream 이 계속 쓴다), 옛 .1 은 .2 에 — 되돌리기를 이어 갔다면 .2 → .1 이 활성 세대를 덮었다
    expect(tags(`${file}.1`).filter((t) => t === 't.x')).toHaveLength(8)
    expect(tags(`${file}.2`)).toEqual(['gen1'])
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.next`)).toBe(false)
    expect(allText().split('\n').filter((l) => l.includes('"t.x"'))).toHaveLength(8)
  })

  it('M .next → 현재 실패 — 전부 되돌려 세대·현재 파일 그대로, .next 의 fd 는 닫힌다', async () => {
    fs.writeFileSync(`${file}.2`, '{"tag":"gen2"}\n')
    fs.writeFileSync(`${file}.1`, '{"tag":"gen1"}\n')
    openLog(dir)
    const fds: number[] = []
    vi.spyOn(fs, 'openSync').mockImplementation((p, flags, mode) => {
      const fd = realOpen(p, flags, mode)
      if (String(p).endsWith('.next')) fds.push(fd)
      return fd
    })
    failRename((from) => from === `${file}.next`)
    burst()
    expect(fds).toHaveLength(1)
    expect(() => fs.fstatSync(fds[0] ?? -1)).toThrow(/EBADF/)
    await flush()
    expect(tags(`${file}.1`)).toEqual(['gen1'])
    expect(fs.existsSync(`${file}.2`)).toBe(false) // .1 → .2 가 덮은 이전 .2 — 주석의 잔여
    expect(tags(file).filter((t) => t === 't.x')).toHaveLength(8)
    expect(fs.existsSync(`${file}.next`)).toBe(false)
  })

  it('J 회전 뒤 현재 파일이 외부에서 지워지면 다음 회전은 세대를 밀지 않고 새 현재 파일을 만든다', async () => {
    fs.writeFileSync(`${file}.2`, '{"tag":"gen2"}\n')
    fs.writeFileSync(`${file}.1`, '{"tag":"gen1"}\n')
    openLog(dir)
    burst()
    await drain()
    const gens = [`${file}.1`, `${file}.2`].map(sha)
    fs.rmSync(file)
    // 새 현재 파일이 생길 때까지만(그 회전 하나) 쓴다
    for (let i = 0; i < 10 && !fs.existsSync(file); i++) log('t.x', { i, pad })
    expect(fs.existsSync(file)).toBe(true)
    await flush()
    expect([`${file}.1`, `${file}.2`].map(sha)).toEqual(gens)
    expect(tags(file)[0]).toBe('log.rotated')
    expect(lines(file).filter((l) => l.tag === 'log.rotate.failed')).toEqual([])
  })

  it('K 열기 실패 뒤 재시도 시각 전에는 열지 않고, 해소되면 다시 열어 이전 실패를 파일에 남긴다', async () => {
    fs.chmodSync(dir, 0o555)
    const out = captureStdout()
    openLog(dir)
    expect(stdoutTags(out)).toEqual(['log.open.failed'])
    const open = vi.spyOn(fs, 'openSync')
    vi.setSystemTime(T0.getTime() + ROTATE_RETRY_MS - 1)
    log('t.before', {})
    expect(open).not.toHaveBeenCalled()
    expect(fs.existsSync(file)).toBe(false)
    fs.chmodSync(dir, 0o755)
    vi.setSystemTime(T0.getTime() + ROTATE_RETRY_MS)
    log('t.back', {})
    expect(open).toHaveBeenCalledTimes(1)
    await flush()
    expect(stdoutTags(out)).toEqual(['log.open.failed', 't.before'])
    expect(tags(file)).toEqual(['log.open.recovered', 't.back'])
    expect(lines(file)[0]).toMatchObject({ failures: 1 })
    expect(String(lines(file)[0]?.error)).toMatch(/EACCES|EPERM/)
  })

  it('L 회전 성공 경로에서 stream 생성이 던져도 log 는 던지지 않고, 되돌려 줄은 현재 파일에 남는다', async () => {
    openLog(dir)
    vi.mocked(fs.createWriteStream).mockImplementationOnce(() => {
      throw new Error('injected stream')
    })
    burst()
    await flush()
    expect(fs.existsSync(`${file}.1`)).toBe(false)
    expect(fs.existsSync(`${file}.next`)).toBe(false)
    expect(tags(file).filter((t) => t === 't.x')).toHaveLength(8)
    expect(lines(file).filter((l) => l.tag === 'log.rotate.failed')).toEqual([
      expect.objectContaining({ phase: 'run', error: 'injected stream' })
    ])
  })

  it('L 열 때 stream 생성이 던져도 openLog 는 던지지 않고 stdout 으로 간다', async () => {
    const out = captureStdout()
    vi.mocked(fs.createWriteStream).mockImplementationOnce(() => {
      throw new Error('injected stream')
    })
    expect(() => openLog(dir)).not.toThrow()
    log('t.after', {})
    await flush()
    expect(stdoutTags(out)).toEqual(['log.open.failed', 't.after'])
  })

  it('M mkdir 실패 — openLog 는 던지지 않고 stdout 에 실패를 남긴다', async () => {
    const out = captureStdout()
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw Object.assign(new Error('injected mkdir'), { code: 'EACCES' })
    })
    expect(() => openLog(dir)).not.toThrow()
    log('t.after', {})
    await flush()
    expect(stdoutTags(out)).toEqual(['log.open.failed', 't.after'])
  })

  it('M 다시 openLog 하면 이전 stream 을 끝낸다', async () => {
    openLog(dir)
    const first = streams[0]
    openLog(dir)
    expect(first?.writableEnded).toBe(true)
    await flush()
  })

  it('M 쓰기 경로(상한 아래)는 동기 fs 호출을 하나도 하지 않는다', () => {
    openLog(dir)
    type FsMethod = { [K in keyof typeof fs]: (typeof fs)[K] extends (...args: never[]) => unknown ? K : never }[keyof typeof fs]
    const isSyncMethod = (name: string): name is FsMethod =>
      name.endsWith('Sync') && name in fs && typeof Reflect.get(fs, name) === 'function'
    const spies = Object.keys(fs)
      .filter(isSyncMethod)
      .map((name) => ({ name, spy: vi.spyOn(fs, name) }))
    for (let i = 0; i < 4; i++) log('t.x', { i })
    expect(spies.filter((s) => s.spy.mock.calls.length > 0).map((s) => s.name)).toEqual([])
    expect(spies.length).toBeGreaterThan(30)
  })

  it('M closeLog 뒤 log 는 stdout 으로만 — 회전 대기 중이었어도 파일을 건드리지 않는다', async () => {
    openLog(dir)
    failRename((from) => from === file)
    burst()
    closeLog()
    vi.mocked(fs.renameSync).mockClear()
    vi.setSystemTime(T0.getTime() + ROTATE_RETRY_MAX_MS)
    const open = vi.spyOn(fs, 'openSync')
    const out = captureStdout()
    log('t.closed', {})
    expect(stdoutTags(out)).toEqual(['t.closed'])
    expect(fs.renameSync).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    await flush()
    expect(fs.existsSync(`${file}.1`)).toBe(false)
  })
})
