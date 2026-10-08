// 레포 guard herdr (LIFE-561) — 개발 실행이 바인딩 없이 쓰는 debug 빌드의 고정 자리와 영수증 대조.
//
// 자리는 `npm --prefix app run herdr:guard`(scripts/build-dev-guard.mjs)가 정한다: `<git-common-dir>/corral-herdr-dev/<패치 digest 16자>/`.
// 본체와 모든 worktree 가 같은 자리를 보고, 패치 집합이 같은 체크아웃끼리 한 바이너리를 쓴다(G1).
// 영수증 대조 규칙은 빌드 래퍼의 `receiptProblem` 과 같다 — 두 곳을 같이 고친다.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { isRecord } from '../../../shared/json.js'

const run = promisify(execFile)

/** debug guard 의 herdr 앱 폴더 — `cfg!(debug_assertions)` 이면 상류가 `herdr-dev` 를 쓴다(herdr-bundle.patch 문맥). */
export const DEV_GUARD_APP_DIR = 'herdr-dev'
/** `<git-common-dir>` 아래 고정 자리 이름. 빌드 래퍼와 같은 값이다. */
export const DEV_GUARD_DIR = 'corral-herdr-dev'
/** 칸끼리 공유하는 툴체인 폴더 — 칸이 아니다. */
const TOOLCHAIN_DIR = 'toolchain'

/**
 * 레포 guard 조회 결과. `absent` 는 이 레포에서 guard 를 빌드한 적이 없다(자리 자체가 없다) — 종전 후보로 내려간다(G3).
 * `stale` 은 자리는 있는데 이 체크아웃과 맞는 바이너리가 없다 — 쓰지도, 내려가지도 않는다(G3).
 */
export type DevGuardLookup = { kind: 'ok'; path: string } | { kind: 'stale'; path: string; reason: string } | { kind: 'absent'; place: string }

export type GuardSourceInfo = { commit: string; archiveSHA256: string; patches: string[]; patchSHA256: Record<string, string> }

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** 칸 이름 — build-terminal-backend.sh 의 patch digest(패치를 source.json 순서로 이은 sha256) 앞 16자. */
export function guardCellKey(patchBytes: readonly Buffer[]): string {
  return sha256(Buffer.concat(patchBytes)).slice(0, 16)
}

export function guardBinaryPath(cell: string): string {
  return path.join(cell, 'herdr-0.9.0', 'target', 'debug', 'herdr')
}

/**
 * 영수증이 지금 체크아웃과 맞는가 — 순수 함수. 어긋나면 무엇이 어긋났는지 한 줄(null 이면 일치).
 * `bundle-herdr.mjs` 의 release 대조와 같은 항목이고 profile 만 debug 다: 프로필 · 패치 파일 sha256(source.json) ·
 * 영수증의 패치 목록 · 상류 commit·archive · 바이너리 sha256.
 */
export function checkGuardReceipt(input: {
  receipt: unknown
  source: GuardSourceInfo
  /** 지금 체크아웃의 패치 파일 sha256 (이름 → 값). */
  patchHashes: Record<string, string>
  /** 바이너리 sha256. 바이너리가 없으면 null. */
  binarySHA256: string | null
}): string | null {
  const { receipt, source } = input
  if (!isRecord(receipt)) return '영수증이 없거나 읽지 못했다'
  if (receipt['profile'] !== 'debug') return `영수증 프로필이 debug 가 아니다 (${String(receipt['profile'])})`
  const changed = source.patches.find((name) => input.patchHashes[name] !== source.patchSHA256[name])
  if (changed !== undefined) return `${changed} 가 source.json 의 sha256 과 다르다`
  const expected = source.patches.map((name) => ({ name, sha256: source.patchSHA256[name] }))
  if (JSON.stringify(receipt['patches']) !== JSON.stringify(expected)) return '영수증의 패치 sha256 이 source.json 과 다르다'
  if (receipt['commit'] !== source.commit) return '영수증의 상류 commit 이 source.json 과 다르다'
  if (receipt['archiveSHA256'] !== source.archiveSHA256) return '영수증의 상류 archive sha256 이 source.json 과 다르다'
  if (input.binarySHA256 === null) return '바이너리가 없다'
  if (input.binarySHA256 !== receipt['binarySHA256']) return '바이너리 sha256 이 영수증과 다르다'
  return null
}

function readSource(backendDir: string): { source: GuardSourceInfo; patchBytes: Buffer[] } {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(backendDir, 'source.json'), 'utf8'))
  if (!isRecord(parsed)) throw new Error('source.json 이 객체가 아니다')
  const patches = Array.isArray(parsed['patches']) ? parsed['patches'].filter((name): name is string => typeof name === 'string') : []
  const hashes = isRecord(parsed['patchSHA256']) ? parsed['patchSHA256'] : {}
  const patchSHA256: Record<string, string> = {}
  for (const name of patches) if (typeof hashes[name] === 'string') patchSHA256[name] = hashes[name]
  const source = {
    commit: typeof parsed['commit'] === 'string' ? parsed['commit'] : '',
    archiveSHA256: typeof parsed['archiveSHA256'] === 'string' ? parsed['archiveSHA256'] : '',
    patches,
    patchSHA256,
  }
  return { source, patchBytes: patches.map((name) => fs.readFileSync(path.join(backendDir, name))) }
}

/**
 * 고정 자리에서 이 체크아웃의 guard 를 찾는다. `base` = `<git-common-dir>/corral-herdr-dev`, `backendDir` = 체크아웃의 `app/backend`.
 * 칸이 없을 때 — 자리에 다른 칸이 있으면 낡음(이 패치로 빌드한 적이 없다), 자리 자체가 비었으면 없음.
 */
export function findDevGuard(input: { base: string; backendDir: string; isExecutable: (file: string) => boolean }): DevGuardLookup {
  let read: { source: GuardSourceInfo; patchBytes: Buffer[] }
  try {
    read = readSource(input.backendDir)
  } catch (error) {
    return { kind: 'stale', path: input.base, reason: `app/backend/source.json·패치를 읽지 못했다 (${String(error)})` }
  }
  const key = guardCellKey(read.patchBytes)
  const cell = path.join(input.base, key)
  const binary = guardBinaryPath(cell)
  if (!fs.existsSync(cell)) {
    const others = listCells(input.base)
    if (others.length === 0) return { kind: 'absent', place: binary }
    return { kind: 'stale', path: binary, reason: `이 체크아웃의 패치(${key})로 빌드한 칸이 없다 — 다른 패치 칸 ${others.length}개만 있다` }
  }
  if (!input.isExecutable(binary)) return { kind: 'stale', path: binary, reason: '바이너리가 없다 — 빌드가 끝나지 않았다' }
  let receipt: unknown = null
  try {
    receipt = JSON.parse(fs.readFileSync(`${binary}.json`, 'utf8'))
  } catch {
    receipt = null
  }
  const patchHashes = Object.fromEntries(read.source.patches.map((name, index) => [name, sha256(read.patchBytes[index] ?? Buffer.alloc(0))]))
  let binarySHA256: string | null = null
  try {
    binarySHA256 = sha256(fs.readFileSync(binary))
  } catch {
    binarySHA256 = null
  }
  const problem = checkGuardReceipt({ receipt, source: read.source, patchHashes, binarySHA256 })
  return problem === null ? { kind: 'ok', path: binary } : { kind: 'stale', path: binary, reason: problem }
}

function listCells(base: string): string[] {
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== TOOLCHAIN_DIR)
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** 레포의 고정 자리 — `git rev-parse --git-common-dir` 기준. git 이 답하지 않으면 null(= guard 없음으로 다룬다). */
export async function devGuardBase(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, timeout: 5000 })
    const common = stdout.trim()
    return common.length > 0 ? path.join(common, DEV_GUARD_DIR) : null
  } catch {
    return null
  }
}
