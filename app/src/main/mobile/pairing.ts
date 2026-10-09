// 페어링·기기 (LIFE-577 A4) — 1회용 코드 [E3] → 기기 토큰(해시만 저장), 상한 [E2], 개별 해지.
//
// - 코드는 **메모리에만** 산다. 디스크·로그·push 로 나가지 않는다 — 화면에 보여 줄 때 한 번 돌려줄 뿐이다.
// - 토큰은 32바이트 무작위(base64url). 디스크엔 SHA-256 해시만, 비교는 길이 확인 뒤 `timingSafeEqual`(W10).
// - 판정·변경은 **동기**다 — 확인과 확정 사이에 다른 요청이 끼지 않는다(Node 단일 스레드). 동시 pair 경합이 없는 이유.
// - 시계는 주입식(`now`) — 만료 시험이 실제로 10분을 기다리지 않는다.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite } from '../../runtime/storage.js'
import { isRecord, readNumber, readString } from '../../shared/json.js'

/** 혼동 문자(I·L·O·S·Z·0·1)를 뺀 29자 — 8자 ≈ 39비트(W10, Collie 상수). */
export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY23456789'
export const PAIRING_CODE_LENGTH = 8
export const PAIRING_TTL_MS = 10 * 60 * 1000
export const PAIRING_MAX_FAILURES = 5
export const MAX_DEVICES = 5
export const DEVICE_NAME_MAX = 64

export type Device = { id: string; name: string; pairedAt: number; lastSeenAt: number | null }
type StoredDevice = Device & { tokenHash: string }

export type PairResult =
  | { ok: true; device: Device; token: string }
  /** `no_code` 활성 코드 없음(만료·사용·폐기 포함) · `wrong_code` 틀림 · `device_limit` 상한 [E2]. */
  | { ok: false; reason: 'no_code' | 'wrong_code' | 'device_limit' }

type ActiveCode = { hash: Buffer; expiresAt: number; failures: number }

const FILE_VERSION = 1

export class PairingStore {
  private readonly file: string
  private readonly now: () => number
  private devices: StoredDevice[] = []
  private code: ActiveCode | null = null

  constructor(input: { dir: string; now?: () => number }) {
    this.file = path.join(input.dir, 'devices.json')
    this.now = input.now ?? Date.now
  }

  /** 파일을 읽는다. 없으면 빈 목록. 깨진 항목은 버린다 — 깨진 파일 전체는 빈 목록(토큰은 다시 페어링하면 된다). */
  load(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.devices = []
      return
    }
    const rows = isRecord(parsed) && Array.isArray(parsed.devices) ? parsed.devices : []
    this.devices = rows.flatMap((row): StoredDevice[] => {
      if (!isRecord(row)) return []
      const id = readString(row, 'id')
      const name = readString(row, 'name')
      const tokenHash = readString(row, 'tokenHash')
      const pairedAt = readNumber(row, 'pairedAt')
      const lastSeenAt = readNumber(row, 'lastSeenAt')
      if (id === null || name === null || tokenHash === null || !/^[0-9a-f]{64}$/.test(tokenHash) || pairedAt === null) return []
      return [{ id, name, tokenHash, pairedAt, lastSeenAt }]
    }).slice(0, MAX_DEVICES)
  }

  list(): Device[] {
    return this.devices.map(({ id, name, pairedAt, lastSeenAt }) => ({ id, name, pairedAt, lastSeenAt }))
  }

  /** 새 코드 — 이전 코드는 무효가 된다(유효 코드는 동시에 1개). 돌려준 코드는 부른 쪽이 화면에만 보여 준다. */
  createCode(): { code: string; expiresAt: number } {
    let code = ''
    for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.code = { hash: sha256(code), expiresAt, failures: 0 }
    return { code, expiresAt }
  }

  clearCode(): void {
    this.code = null
  }

  /** 지금 쓸 수 있는 코드가 있나 — 만료됐으면 여기서 버린다. */
  pairingExpiresAt(): number | null {
    if (this.code !== null && this.now() >= this.code.expiresAt) this.code = null
    return this.code?.expiresAt ?? null
  }

  /** 코드로 기기를 등록한다. 성공하면 코드는 소모, 5회 틀리면 폐기. 상한이면 코드를 소모하지 않고 거절. */
  pair(input: { code: unknown; name: unknown }): PairResult {
    if (this.pairingExpiresAt() === null || this.code === null) return { ok: false, reason: 'no_code' }
    const given = typeof input.code === 'string' ? input.code.trim().toUpperCase() : ''
    if (!timingSafeEqual(sha256(given), this.code.hash)) {
      this.code.failures += 1
      if (this.code.failures >= PAIRING_MAX_FAILURES) this.code = null
      return { ok: false, reason: 'wrong_code' }
    }
    if (this.devices.length >= MAX_DEVICES) return { ok: false, reason: 'device_limit' }
    const token = randomBytes(32).toString('base64url')
    const device: StoredDevice = {
      id: randomUUID(),
      name: deviceName(input.name),
      tokenHash: sha256(token).toString('hex'),
      pairedAt: this.now(),
      lastSeenAt: null,
    }
    // 디스크에 먼저 — 쓰기가 실패하면 등록도 코드 소모도 없다(예외가 부른 쪽으로 간다).
    this.persist([...this.devices, device])
    this.code = null
    return { ok: true, device: { id: device.id, name: device.name, pairedAt: device.pairedAt, lastSeenAt: null }, token }
  }

  /** 토큰 → 기기. 해시를 상수시간으로 비교한다. 없으면 null(없음·틀림·해지됨을 구별하지 않는다). */
  authenticate(token: unknown): Device | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null
    const hash = sha256(token)
    let found: StoredDevice | null = null
    for (const device of this.devices) {
      const stored = Buffer.from(device.tokenHash, 'hex')
      if (stored.length === hash.length && timingSafeEqual(stored, hash)) found = device
    }
    if (found === null) return null
    return { id: found.id, name: found.name, pairedAt: found.pairedAt, lastSeenAt: found.lastSeenAt }
  }

  /** 마지막 접속 시각. 기록 실패는 접속을 막지 않는다(표시용 값). */
  touch(id: string): void {
    const next = this.devices.map((device) => (device.id === id ? { ...device, lastSeenAt: this.now() } : device))
    try { this.persist(next) } catch { /* 표시용 — 다음 접속에 다시 쓴다 */ }
  }

  /** 해지 — 지운 뒤에야 true. 열린 연결을 닫는 것은 부른 쪽(서버)이다. */
  revoke(id: string): boolean {
    if (!this.devices.some((device) => device.id === id)) return false
    this.persist(this.devices.filter((device) => device.id !== id))
    return true
  }

  has(id: string): boolean {
    return this.devices.some((device) => device.id === id)
  }

  private persist(next: StoredDevice[]): void {
    atomicWrite(this.file, { version: FILE_VERSION, devices: next })
    this.devices = next
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function deviceName(value: unknown): string {
  const text = typeof value === 'string' ? [...value].filter((char) => { const code = char.codePointAt(0) ?? 0; return code >= 0x20 && code !== 0x7f }).join('').trim() : ''
  return text.length === 0 ? '이름 없는 기기' : text.slice(0, DEVICE_NAME_MAX)
}
