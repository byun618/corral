// 작업 출처 테스트 도구 (LIFE-600) — 테스트만 import 한다(앱 진입점이 닿지 않아 번들에 안 들어간다).
// 가짜 토큰은 `life_pat_` + 고정 문자열뿐이다(킥오프 비밀값 규칙). 가짜 cipher 는 평문이 암호문에 그대로 보이지 않게 바이트를 뒤섞는다.

import type { WorkSettingsState } from '../../shared/work.js'
import { MemoryActivity } from './activity-store.js'
import { LaMcpFixture } from './la-mcp-fixture.js'
import { laSourceEntry } from './la-source.js'
import { mockSourceEntry, type MockDefect } from './mock-source.js'
import { WorkService, type WorkRepoRef } from './service.js'
import { WorkSourceRegistry, type WorkSourceEntry } from './source.js'
import type { WorkStoreData, WorkStoreWrite } from './store.js'
import { CredentialVault, type SecretCipher } from './vault.js'

export const FAKE_LA_TOKEN = 'life_pat_fixture000000000000000000000000000000000000'
export const FAKE_LA_READ_TOKEN = 'life_pat_fixtureread0000000000000000000000000000000'
export const FAKE_MOCK_TOKEN = 'mock_fixture_token_0000'

export class MemoryStore {
  data: WorkStoreData = { connections: [], repoDefaults: {} }
  failWrites = false
  writes = 0

  get(): WorkStoreData {
    return structuredClone(this.data)
  }

  write(next: WorkStoreData): WorkStoreWrite {
    if (this.failWrites) return { ok: false, error: 'Error: EACCES (test)' }
    this.writes += 1
    this.data = structuredClone(next)
    return { ok: true }
  }
}

export type FakeCipherMode = 'ok' | 'unavailable' | 'deny-encrypt' | 'deny-decrypt'

export class FakeCipher implements SecretCipher {
  mode: FakeCipherMode = 'ok'
  decrypts = 0
  encrypts = 0
  /** 풀기를 붙잡아 둘 수 있다 — 「키체인 질문이 떠 있는 동안」. */
  hold: Promise<void> | null = null

  async available(): Promise<boolean> {
    return this.mode !== 'unavailable'
  }

  async encrypt(plain: string): Promise<Buffer> {
    this.encrypts += 1
    if (this.mode === 'deny-encrypt') throw new Error('User denied keychain access')
    return Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a))
  }

  async decrypt(sealed: Buffer): Promise<string> {
    this.decrypts += 1
    if (this.hold !== null) await this.hold
    if (this.mode === 'deny-decrypt') throw new Error('User denied keychain access')
    return Buffer.from(sealed.map((byte) => byte ^ 0x5a)).toString('utf8')
  }
}

export type WorkHarness = {
  service: WorkService
  store: MemoryStore
  cipher: FakeCipher
  vault: CredentialVault
  emitted: WorkSettingsState[]
  repos: WorkRepoRef[]
  activity: MemoryActivity
}

export function workHarness({ entries, repos = [] }: { entries: WorkSourceEntry[]; repos?: WorkRepoRef[] }): WorkHarness {
  const store = new MemoryStore()
  const cipher = new FakeCipher()
  const vault = new CredentialVault(cipher)
  const emitted: WorkSettingsState[] = []
  const activity = new MemoryActivity()
  let n = 0
  const service = new WorkService({
    store,
    vault,
    sources: new WorkSourceRegistry(entries),
    repos: () => repos,
    onChange: (state) => emitted.push(state),
    activity,
    now: () => 1_791_800_000_000,
    newId: () => `conn-${++n}`,
  })
  return { service, store, cipher, vault, emitted, repos, activity }
}

export async function laFixtureHarness({ timeoutMs }: { timeoutMs?: number } = {}): Promise<WorkHarness & { fixture: LaMcpFixture; url: string }> {
  const fixture = new LaMcpFixture()
  fixture.tokens.set(FAKE_LA_TOKEN, 'write')
  fixture.tokens.set(FAKE_LA_READ_TOKEN, 'read')
  const url = await fixture.start()
  const harness = workHarness({ entries: [laSourceEntry({ url, clientVersion: 'test', timeoutMs })] })
  return { ...harness, fixture, url }
}

export function mockHarness({ defect = 'none' }: { defect?: MockDefect } = {}): WorkHarness {
  return workHarness({ entries: [mockSourceEntry({ defect })] })
}
