// 자격 금고 (LIFE-600 C6 · D4) — 토큰은 OS 암호화(`safeStorage`)로 싸서 암호문만 디스크에 둔다. **평문 폴백 없음.**
//
// - 키체인 질문은 동기 API 에서 호출 스레드(main)를 막는다(Electron 문서) → **비동기 API 만** 쓴다
//   (`isAsyncEncryptionAvailable`·`encryptStringAsync`·`decryptStringAsync`, Electron 44.3 에 있음 — 00-analysis §6.1).
// - **풀기는 필요할 때만**(연결 테스트·작업 요청이 처음 그 연결을 쓸 때). 앱 기동 경로는 금고를 건드리지 않는다.
// - 같은 연결을 동시에 여러 번 풀면 질문이 겹친다 → 진행 중인 풀기를 하나로 합친다.
// - 풀기 실패는 「지금 못 읽음」 이지 「자격 없음」 이 아니다 — 암호문을 지우거나 덮지 않는다(C6). 다음 요청이 다시 푼다.
// - 푼 토큰은 이 객체의 메모리에만 있다. 해제·교체 때 지운다.
//
// Electron 을 import 하지 않는다 — `SecretCipher` 를 주입받는다(테스트는 가짜 cipher, 앱은 `electronCipher(safeStorage)`).

import type { WorkError } from '../../shared/work.js'
import { workError } from './errors.js'

export interface SecretCipher {
  available(): Promise<boolean>
  encrypt(plain: string): Promise<Buffer>
  decrypt(sealed: Buffer): Promise<string>
}

/** `safeStorage` 의 비동기 면만 쓰는 cipher. 타입은 쓰는 메서드만 요구한다(Electron 타입을 끌고 오지 않으려고). */
export function electronCipher(storage: {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plain: string): Promise<Buffer>
  decryptStringAsync(sealed: Buffer): Promise<{ result: string }>
}): SecretCipher {
  return {
    available: () => storage.isAsyncEncryptionAvailable(),
    encrypt: (plain) => storage.encryptStringAsync(plain),
    decrypt: async (sealed) => (await storage.decryptStringAsync(sealed)).result,
  }
}

/**
 * 계측 실행 전용 cipher — **제어 소켓이 열린 격리 실행(`CORRAL_CONTROL_SOCKET`)에서 `CORRAL_WORK_TEST_CIPHER=1` 일 때만** main 이 고른다.
 * 격리 실행이 사용자 로그인 키체인에 「<앱 이름> Safe Storage」 항목을 만들거나 허용 대화상자를 띄우지 않게 한다(네이티브 관문 C13 의 첫 질문을 오염시키지 않는다).
 * 바이트를 뒤섞을 뿐 암호가 아니다 — 평시 앱에서는 고를 길이 없다.
 */
export function measurementCipher(): SecretCipher {
  const flip = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0xa5))
  return {
    available: async () => true,
    encrypt: async (plain) => flip(Buffer.from(plain, 'utf8')),
    decrypt: async (sealed) => flip(sealed).toString('utf8'),
  }
}

export type SealResult = { ok: true; sealed: string } | { ok: false; error: WorkError }
export type OpenResult = { ok: true; token: string } | { ok: false; error: WorkError }

const KEYCHAIN_DENIED = '키체인에서 저장된 토큰을 읽지 못했습니다. 키체인 접근을 거부했거나 항목이 지워졌습니다.'
const KEYCHAIN_UNAVAILABLE = 'macOS 키체인 암호화를 쓸 수 없습니다 — 토큰을 저장하지 않았습니다(평문으로는 저장하지 않습니다).'

export class CredentialVault {
  private readonly cipher: SecretCipher
  private readonly open = new Map<string, string>()
  private readonly opening = new Map<string, Promise<OpenResult>>()

  constructor(cipher: SecretCipher) {
    this.cipher = cipher
  }

  /** 새 토큰을 싼다 — 못 싸면(가용 아님·키체인 거부) 키체인 오류. 부르는 쪽은 그때 아무것도 저장하지 않는다. */
  async seal(token: string): Promise<SealResult> {
    try {
      if (!(await this.cipher.available())) return { ok: false, error: workError({ kind: 'keychain', message: KEYCHAIN_UNAVAILABLE }) }
      const sealed = await this.cipher.encrypt(token)
      return { ok: true, sealed: sealed.toString('base64') }
    } catch (error) {
      return { ok: false, error: workError({ kind: 'keychain', message: `키체인에 토큰을 넣지 못했습니다 (${errorName(error)}). 아무것도 저장하지 않았습니다.` }) }
    }
  }

  /** 저장 성공 뒤 — 방금 쓴 토큰을 메모리에 둬서 바로 다시 풀지 않게 한다. */
  remember({ connectionId, token }: { connectionId: string; token: string }): void {
    this.open.set(connectionId, token)
  }

  isOpen(connectionId: string): boolean {
    return this.open.has(connectionId)
  }

  /** 연결의 토큰 — 메모리에 없으면 암호문을 푼다(이때 macOS 가 허용을 물을 수 있다). */
  unseal({ connectionId, sealed }: { connectionId: string; sealed: string }): Promise<OpenResult> {
    const token = this.open.get(connectionId)
    if (token !== undefined) return Promise.resolve({ ok: true, token })
    const running = this.opening.get(connectionId)
    if (running !== undefined) return running
    const started: Promise<OpenResult> = this.decrypt(sealed).then((result) => {
      // 푸는 동안 해제·교체됐으면(forget) 결과를 메모리에 두지 않는다.
      if (this.opening.get(connectionId) !== started) return result
      this.opening.delete(connectionId)
      if (result.ok) this.open.set(connectionId, result.token)
      return result
    })
    this.opening.set(connectionId, started)
    return started
  }

  forget(connectionId: string): void {
    this.open.delete(connectionId)
    this.opening.delete(connectionId)
  }

  private async decrypt(sealed: string): Promise<OpenResult> {
    try {
      if (!(await this.cipher.available())) return { ok: false, error: workError({ kind: 'keychain', message: KEYCHAIN_DENIED }) }
      const token = await this.cipher.decrypt(Buffer.from(sealed, 'base64'))
      if (token.length === 0) return { ok: false, error: workError({ kind: 'keychain', message: KEYCHAIN_DENIED }) }
      return { ok: true, token }
    } catch {
      return { ok: false, error: workError({ kind: 'keychain', message: KEYCHAIN_DENIED }) }
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '알 수 없는 오류'
}
