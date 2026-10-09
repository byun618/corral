import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PAIRING_ALPHABET, PairingStore } from './pairing.js'

// R1-A8 — 기준 수치는 **제품 상수가 아니라 01-criteria E2·E3 에서 옮겨 적은 값**으로 기대한다(상수를 바꾸면 이 시험이 잡는다).
const CODE_LENGTH = 8
const TTL_MS = 600_000
const MAX_FAILURES = 5
const DEVICE_CAP = 5
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY23456789'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fresh(now?: () => number): { store: PairingStore; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l577p-'))
  dirs.push(root)
  const dir = path.join(root, 'mobile')
  const store = new PairingStore({ dir, now })
  store.load()
  return { store, dir }
}

describe('페어링 코드 [E3]', () => {
  it('8자 · 혼동 문자 뺀 29자 알파벳', () => {
    expect(PAIRING_ALPHABET).toBe(ALPHABET)
    expect(ALPHABET).toHaveLength(29)
    for (const banned of ['I', 'L', 'O', 'S', 'Z', '0', '1']) expect(PAIRING_ALPHABET).not.toContain(banned)
    const { store } = fresh()
    for (let i = 0; i < 50; i += 1) {
      const { code } = store.createCode()
      expect(code).toHaveLength(CODE_LENGTH)
      for (const char of code) expect(PAIRING_ALPHABET).toContain(char)
    }
  })

  it('10분 뒤 만료 — 만료 직전(599999ms)은 성공, 정각(600000ms)은 거절', () => {
    let now = 1_000_000
    const { store } = fresh(() => now)
    const early = store.createCode()
    expect(early.expiresAt - now).toBe(TTL_MS)
    now += TTL_MS - 1
    expect(store.pair({ code: early.code, name: 'p' }).ok).toBe(true)
    const late = store.createCode()
    now += TTL_MS
    expect(store.pairingExpiresAt()).toBeNull()
    expect(store.pair({ code: late.code, name: 'p' })).toEqual({ ok: false, reason: 'no_code' })
  })

  it('1회 사용 — 쓴 코드는 다시 거절', () => {
    const { store } = fresh()
    const { code } = store.createCode()
    expect(store.pair({ code, name: 'a' }).ok).toBe(true)
    expect(store.pair({ code, name: 'b' })).toEqual({ ok: false, reason: 'no_code' })
  })

  it('5회 틀리면 폐기(4회째까지 유효 · 5회째에 폐기) — 그 뒤 정답도 거절', () => {
    const { store } = fresh()
    const { code } = store.createCode()
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      expect(store.pairingExpiresAt()).not.toBeNull()
      expect(store.pair({ code: 'AAAAAAAA', name: 'x' })).toEqual({ ok: false, reason: 'wrong_code' })
    }
    expect(store.pairingExpiresAt()).toBeNull()
    expect(store.pair({ code, name: 'x' })).toEqual({ ok: false, reason: 'no_code' })
  })

  it('4회 틀려도 정답은 통과(경계)', () => {
    const { store } = fresh()
    const { code } = store.createCode()
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) store.pair({ code: 'AAAAAAAA', name: 'x' })
    expect(store.pair({ code, name: 'x' }).ok).toBe(true)
  })

  it('유효 코드는 하나 — 새 코드가 이전 코드를 무효화', () => {
    const { store } = fresh()
    const first = store.createCode()
    const second = store.createCode()
    expect(store.pair({ code: first.code, name: 'x' }).ok).toBe(first.code === second.code)
    expect(store.pair({ code: second.code, name: 'x' }).ok).toBe(first.code !== second.code)
  })

  it('소문자·앞뒤 공백 입력도 받는다', () => {
    const { store } = fresh()
    const { code } = store.createCode()
    expect(store.pair({ code: ` ${code.toLowerCase()} `, name: 'x' }).ok).toBe(true)
  })
})

describe('기기 [E2] · 토큰', () => {
  function pairOne(store: PairingStore, name: string): { id: string; token: string } {
    const { code } = store.createCode()
    const result = store.pair({ code, name })
    if (!result.ok) throw new Error(result.reason)
    return { id: result.device.id, token: result.token }
  }

  it('상한 5대까지 성공(5번째 성공 직접 확인), 6번째는 device_limit — 코드는 소모되지 않는다', () => {
    const { store } = fresh()
    for (let i = 0; i < DEVICE_CAP - 1; i += 1) pairOne(store, `d${i}`)
    const fifth = store.createCode()
    expect(store.pair({ code: fifth.code, name: 'fifth' }).ok).toBe(true)
    const { code } = store.createCode()
    expect(store.pair({ code, name: 'over' })).toEqual({ ok: false, reason: 'device_limit' })
    expect(store.pairingExpiresAt()).not.toBeNull()
    expect(store.list()).toHaveLength(DEVICE_CAP)
  })

  it('토큰 인증 · 틀린 토큰 · 해지 뒤 거절, 다른 기기는 유지', () => {
    const { store } = fresh()
    const a = pairOne(store, 'a')
    const b = pairOne(store, 'b')
    expect(store.authenticate(a.token)?.id).toBe(a.id)
    expect(store.authenticate(a.token + 'x')).toBeNull()
    expect(store.authenticate('')).toBeNull()
    expect(store.authenticate(undefined)).toBeNull()
    expect(store.revoke(a.id)).toBe(true)
    expect(store.authenticate(a.token)).toBeNull()
    expect(store.authenticate(b.token)?.id).toBe(b.id)
    expect(store.revoke(a.id)).toBe(false)
  })

  it('디스크엔 해시만 — 토큰·코드 원문 없음, 파일 0600·폴더 0700, 재적재 뒤 유효', () => {
    const { store, dir } = fresh()
    const { code } = store.createCode()
    const result = store.pair({ code, name: '폰' })
    if (!result.ok) throw new Error(result.reason)
    const file = path.join(dir, 'devices.json')
    const text = fs.readFileSync(file, 'utf8')
    expect(text).not.toContain(result.token)
    expect(text).not.toContain(code)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    const again = new PairingStore({ dir })
    again.load()
    expect(again.authenticate(result.token)?.name).toBe('폰')
    expect(again.list()).toHaveLength(1)
  })

  it('기기 이름은 제어 문자를 빼고 64자로 자른다', () => {
    const { store } = fresh()
    const { code } = store.createCode()
    const result = store.pair({ code, name: 'a\u0000b\n' + 'x'.repeat(100) })
    expect(result.ok && result.device.name.length).toBe(64)
    expect(result.ok && result.device.name.startsWith('abx')).toBe(true)
  })
})
