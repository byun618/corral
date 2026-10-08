// LIFE-561 C2·C3 단위 — 개발 실행의 레포 guard 해소 순서·영수증 대조·없음/낡음 갈림. 고정 자리는 /tmp 아래 가짜 칸으로 만든다.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkGuardReceipt, findDevGuard, guardBinaryPath, guardCellKey, type DevGuardLookup, type GuardSourceInfo } from './dev-guard.js'
import type { BackendBinary } from '../../../shared/types.js'
import { herdrAppDirFor, locateHerdr, onRepoGuard, type HerdrResolution } from './server.js'

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const brew = (): Promise<HerdrResolution> => Promise.resolve({ kind: 'found', binary: { path: '/opt/homebrew/bin/herdr', source: 'login-shell', version: null } })
const nothing = (): Promise<HerdrResolution> => Promise.resolve({ kind: 'missing', searched: ['로그인 셸 command -v herdr', '/opt/homebrew/bin/herdr'], bundled: false })
const guard = (lookup: DevGuardLookup) => () => Promise.resolve(lookup)

describe('locateHerdr — 개발 실행·바인딩 없음의 순서 (C2)', () => {
  it('CORRAL_HERDR_BIN 이 레포 guard 보다 먼저다', async () => {
    const devGuard = vi.fn(guard({ kind: 'ok', path: '/g/herdr' }))
    const result = await locateHerdr({ override: '/fake/herdr', bundled: null, devGuard, isExecutable: () => true, external: brew })
    expect(result).toEqual({ kind: 'found', binary: { path: '/fake/herdr', source: 'env', version: null } })
    expect(devGuard).not.toHaveBeenCalled()
  })
  it('guard 영수증 일치 → repo-guard 출처, 로그인 셸·알려진 위치를 부르지 않는다', async () => {
    const external = vi.fn(brew)
    const result = await locateHerdr({ override: undefined, bundled: null, devGuard: guard({ kind: 'ok', path: '/g/herdr' }), isExecutable: () => true, external })
    expect(result).toEqual({ kind: 'found', binary: { path: '/g/herdr', source: 'repo-guard', version: null } })
    expect(external).not.toHaveBeenCalled()
  })
  it('guard 없음(G3) → 종전 후보로 내려간다', async () => {
    const result = await locateHerdr({ override: undefined, bundled: null, devGuard: guard({ kind: 'absent', place: '/g/herdr' }), isExecutable: () => true, external: brew })
    expect(result.kind === 'found' && result.binary.source).toBe('login-shell')
  })
  it('guard 없음 + 종전 후보도 없음 → missing, 찾아 본 위치 맨 앞에 레포 guard 자리', async () => {
    const result = await locateHerdr({ override: undefined, bundled: null, devGuard: guard({ kind: 'absent', place: '/g/herdr' }), isExecutable: () => false, external: nothing })
    expect(result).toEqual({ kind: 'missing', searched: ['레포 guard /g/herdr', '로그인 셸 command -v herdr', '/opt/homebrew/bin/herdr'], bundled: false })
  })
  it('guard 낡음(G3) → stale, 종전 후보로 내려가지 않는다', async () => {
    const external = vi.fn(brew)
    const result = await locateHerdr({ override: undefined, bundled: null, devGuard: guard({ kind: 'stale', path: '/g/herdr', reason: '바이너리 sha256 이 영수증과 다르다' }), isExecutable: () => true, external })
    expect(result).toEqual({ kind: 'stale', path: '/g/herdr', reason: '바이너리 sha256 이 영수증과 다르다' })
    expect(external).not.toHaveBeenCalled()
  })
  it('바인딩 있는 개발 실행(devGuard null) → 종전 외부 해소 그대로, guard 를 보지 않는다', async () => {
    const result = await locateHerdr({ override: undefined, bundled: null, devGuard: null, isExecutable: () => true, external: brew })
    expect(result.kind === 'found' && result.binary.source).toBe('login-shell')
  })
  it('설치본은 동봉만 — guard 공급자가 와도 부르지 않는다', async () => {
    const devGuard = vi.fn(guard({ kind: 'ok', path: '/g/herdr' }))
    const result = await locateHerdr({ override: undefined, bundled: '/R/backend/herdr', devGuard, isExecutable: () => true, external: brew })
    expect(result.kind === 'found' && result.binary.source).toBe('bundled')
    expect(devGuard).not.toHaveBeenCalled()
  })
})

const source: GuardSourceInfo = {
  commit: 'c0ffee',
  archiveSHA256: 'a'.repeat(64),
  patches: ['p1.patch', 'p2.patch'],
  patchSHA256: { 'p1.patch': sha('one'), 'p2.patch': sha('two') },
}
const goodReceipt = (binarySHA256: string) => ({
  commit: source.commit,
  archiveSHA256: source.archiveSHA256,
  profile: 'debug',
  binarySHA256,
  patches: source.patches.map((name) => ({ name, sha256: source.patchSHA256[name] })),
})
const patchHashes = { 'p1.patch': sha('one'), 'p2.patch': sha('two') }

describe('checkGuardReceipt — 영수증 대조 (C3ⓑ 각 불일치 + 양성 대조)', () => {
  const bin = sha('binary')
  it('양성 대조: 전부 맞으면 null(쓴다)', () => {
    expect(checkGuardReceipt({ receipt: goodReceipt(bin), source, patchHashes, binarySHA256: bin })).toBeNull()
  })
  it('영수증 없음', () => {
    expect(checkGuardReceipt({ receipt: null, source, patchHashes, binarySHA256: bin })).toMatch(/영수증이 없거나/)
  })
  it('profile 불일치 (release 영수증)', () => {
    expect(checkGuardReceipt({ receipt: { ...goodReceipt(bin), profile: 'release' }, source, patchHashes, binarySHA256: bin })).toMatch(/debug 가 아니다/)
  })
  it('패치 파일 sha256 이 source.json 과 다름', () => {
    expect(checkGuardReceipt({ receipt: goodReceipt(bin), source, patchHashes: { ...patchHashes, 'p2.patch': sha('changed') }, binarySHA256: bin })).toMatch(/p2.patch 가 source.json/)
  })
  it('영수증의 패치 sha256 불일치', () => {
    const receipt = { ...goodReceipt(bin), patches: [{ name: 'p1.patch', sha256: sha('old') }, { name: 'p2.patch', sha256: sha('two') }] }
    expect(checkGuardReceipt({ receipt, source, patchHashes, binarySHA256: bin })).toMatch(/패치 sha256/)
  })
  it('상류 commit 불일치', () => {
    expect(checkGuardReceipt({ receipt: { ...goodReceipt(bin), commit: 'old' }, source, patchHashes, binarySHA256: bin })).toMatch(/commit/)
  })
  it('archive 불일치', () => {
    expect(checkGuardReceipt({ receipt: { ...goodReceipt(bin), archiveSHA256: 'b'.repeat(64) }, source, patchHashes, binarySHA256: bin })).toMatch(/archive/)
  })
  it('바이너리 sha256 불일치', () => {
    expect(checkGuardReceipt({ receipt: goodReceipt(bin), source, patchHashes, binarySHA256: sha('other') })).toMatch(/바이너리 sha256/)
  })
})

describe('findDevGuard — 고정 자리의 없음·낡음·일치 (C3ⓐⓑ)', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })
  /** 가짜 체크아웃(app/backend)과 가짜 고정 자리. 칸 이름은 실제 규칙(guardCellKey)대로 만든다. */
  const fixture = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l561-guard-'))
    roots.push(root)
    const backendDir = path.join(root, 'app/backend')
    fs.mkdirSync(backendDir, { recursive: true })
    fs.writeFileSync(path.join(backendDir, 'p1.patch'), 'one')
    fs.writeFileSync(path.join(backendDir, 'p2.patch'), 'two')
    fs.writeFileSync(path.join(backendDir, 'source.json'), JSON.stringify(source))
    const base = path.join(root, 'git/corral-herdr-dev')
    const cell = path.join(base, guardCellKey([Buffer.from('one'), Buffer.from('two')]))
    const build = (receipt: (binarySHA256: string) => unknown = goodReceipt): string => {
      const binary = guardBinaryPath(cell)
      fs.mkdirSync(path.dirname(binary), { recursive: true })
      fs.writeFileSync(binary, 'binary')
      fs.chmodSync(binary, 0o755)
      fs.writeFileSync(`${binary}.json`, JSON.stringify(receipt(sha('binary'))))
      return binary
    }
    return { backendDir, base, cell, build }
  }
  const executable = (file: string): boolean => fs.existsSync(file)

  it('자리 자체가 없으면 absent (종전 후보로 간다)', () => {
    const { backendDir, base } = fixture()
    expect(findDevGuard({ base, backendDir, isExecutable: executable }).kind).toBe('absent')
  })
  it('양성 대조: 이 체크아웃 칸의 영수증이 맞으면 ok', () => {
    const { backendDir, base, build } = fixture()
    const binary = build()
    expect(findDevGuard({ base, backendDir, isExecutable: executable })).toEqual({ kind: 'ok', path: binary })
  })
  it('패치가 바뀌어 이 칸이 없고 다른 칸만 있으면 stale (absent 가 아니다)', () => {
    const { backendDir, base, build } = fixture()
    build()
    fs.writeFileSync(path.join(backendDir, 'p2.patch'), 'two-changed')
    const result = findDevGuard({ base, backendDir, isExecutable: executable })
    expect(result.kind).toBe('stale')
    expect(result.kind === 'stale' && result.reason).toMatch(/칸이 없다/)
  })
  it('툴체인만 있는 자리(첫 빌드 전 실패)는 다른 칸으로 세지 않는다 → absent', () => {
    const { backendDir, base } = fixture()
    fs.mkdirSync(path.join(base, 'toolchain'), { recursive: true })
    expect(findDevGuard({ base, backendDir, isExecutable: executable }).kind).toBe('absent')
  })
  it('칸은 있는데 바이너리가 없다(빌드 미완) → stale', () => {
    const { backendDir, base, cell } = fixture()
    fs.mkdirSync(cell, { recursive: true })
    const result = findDevGuard({ base, backendDir, isExecutable: executable })
    expect(result.kind === 'stale' && result.reason).toMatch(/바이너리가 없다/)
  })
  it('바이너리를 영수증 뒤에 바꿨다 → stale', () => {
    const { backendDir, base, build } = fixture()
    const binary = build()
    fs.writeFileSync(binary, 'tampered')
    const result = findDevGuard({ base, backendDir, isExecutable: executable })
    expect(result.kind === 'stale' && result.reason).toMatch(/바이너리 sha256/)
  })
  it('release 영수증 → stale', () => {
    const { backendDir, base, build } = fixture()
    build((binarySHA256) => ({ ...goodReceipt(binarySHA256), profile: 'release' }))
    expect(findDevGuard({ base, backendDir, isExecutable: executable }).kind).toBe('stale')
  })
})

describe('herdrAppDirFor — 세션 폴백 폴더가 바이너리를 따른다 (C4ⓐ, F1)', () => {
  const found = (source: BackendBinary['source']): HerdrResolution => ({ kind: 'found', binary: { path: '/x/herdr', source, version: null } })
  it('레포 guard → herdr-dev, 낡음도 herdr-dev', () => {
    expect(herdrAppDirFor({ bundled: false, resolution: found('repo-guard') })).toBe('herdr-dev')
    expect(herdrAppDirFor({ bundled: false, resolution: { kind: 'stale', path: '/g/herdr', reason: 'r' } })).toBe('herdr-dev')
    expect(onRepoGuard(found('repo-guard'))).toBe(true)
  })
  it('로그인 셸·알려진 위치·CORRAL_HERDR_BIN·해소 전 → 종전 herdr', () => {
    const others: BackendBinary['source'][] = ['login-shell', 'known-location', 'env']
    for (const source of others) expect(herdrAppDirFor({ bundled: false, resolution: found(source) })).toBe('herdr')
    expect(herdrAppDirFor({ bundled: false, resolution: null })).toBe('herdr')
    expect(onRepoGuard(found('login-shell'))).toBe(false)
  })
  it('설치본 → corral-herdr', () => {
    expect(herdrAppDirFor({ bundled: true, resolution: found('repo-guard') })).toBe('corral-herdr')
  })
})
