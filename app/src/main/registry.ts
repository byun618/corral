// Repo roots and setup metadata have one owner: repos.json. Git owns worktree existence.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isRecord } from '../shared/json.js'
import { canonicalPath } from './canonical-path.js'
import { readStoredWorkLink, type StoredWorkLink } from '../shared/work-link.js'
import type { AddRepoResult, RegistryState, RemoveRepoResult } from '../shared/types.js'

export interface RepoRecord {
  id: string
  path: string
  name: string
  projectId: string
  baseRef: string | null
  displayName?: string | null
  worktreeBasePath?: string | null
  gitUsername?: string | null
  method: string
  /** LIFE-813: the command `worktree create`/`worktree setup` run in a new worktree. Absent = none. */
  setupCommand?: string | null
}
export interface SetupRecord {
  id: string
  projectId: string
  hostId: string
  path: string | null
  kind: string
  displayName: string | null
  worktreeBasePath: string | null
  gitUsername: string | null
  state: string
  method: string
}
export interface WorktreeMetadataRecord {
  repoId?: string
  displayName?: string | null
  comment?: string | null
  linkedIssue?: number | null
  linkedLinearIssue?: { identifier: string; organizationKey: string | null; url: string | null } | null
  parentWorktreeId?: string | null
  workspaceStatus?: string | null
  createdBranch?: boolean
  /** LIFE-603 명시 작업 링크 — 「작업에서 시작」 이 적는다. 모르는 모양은 읽을 때 버린다(`droppedLinks`). */
  workLink?: StoredWorkLink | null
  /** LIFE-603 자동 연결 예외 — 「작업 떼기」 로 끊은 worktree. */
  workLinkSuppressed?: boolean
}
/** 읽다가 버린 작업 링크 칸(손상·모르는 모양) — 앱은 산다. main 이 로그로 남긴다. */
export type DroppedLink = { path: string; field: 'workLink' | 'workLinkSuppressed' }
interface RegistryData { version: 2; repos: RepoRecord[]; setups: SetupRecord[]; worktrees: Record<string, WorktreeMetadataRecord> }

/** Delete metadata and cross-repo parent references in the same registry transaction. */
export function unregisterRepo(data: RegistryData, id: string): void {
  const repo = data.repos.find(row => row.id === id)
  if (!repo) return
  // Old metadata has no repoId. Ask Git for exact membership; directory
  // containment cannot distinguish another repository nested under this one.
  const ownedPaths = new Set([repo.path])
  if (Object.values(data.worktrees).some(metadata => !metadata.repoId)) {
    try {
      const output = execFileSync('git', ['-C', repo.path, 'worktree', 'list', '--porcelain', '-z'], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      })
      const targets = output.split('\0\0').flatMap(block => {
        const target = block.split('\0').find(field => field.startsWith('worktree '))?.slice(9)
        return target ? [canonicalPath(target)] : []
      })
      // If .git disappeared, Git may discover an enclosing repository instead.
      if (targets[0] === repo.path) for (const target of targets) ownedPaths.add(target)
    } catch {
      // Missing/unreadable repositories must still be unregisterable. Keep
      // unowned legacy entries when Git cannot establish their ownership.
    }
  }
  data.repos = data.repos.filter(row => row.id !== id)
  for (const [target, metadata] of Object.entries(data.worktrees)) {
    if (metadata.repoId === id || (!metadata.repoId && ownedPaths.has(canonicalPath(target)))) delete data.worktrees[target]
    else if (metadata.parentWorktreeId?.startsWith(id + '::')) metadata.parentWorktreeId = null
  }
}

export class RepoRegistry {
  private readonly file: string
  private readonly legacyMetadata: string
  private lastError: string | null = null
  private dropped: DroppedLink[] = []

  constructor(userDataDir: string) {
    this.file = process.env.CORRAL_REGISTRY || path.join(userDataDir, 'repos.json')
    this.legacyMetadata = path.join(userDataDir, 'worktree-metadata.json')
  }

  load(): void {
    try { this.read(); this.lastError = null } catch (error) { this.lastError = String(error) }
  }

  state(): RegistryState {
    this.load()
    return { file: this.file, roots: this.lastError ? [] : this.list(), lastError: this.lastError }
  }

  list(): string[] { return this.records().map(repo => repo.path).sort() }
  records(): RepoRecord[] { return this.read().repos }
  setups(): SetupRecord[] { return this.read().setups }
  metadata(): Record<string, WorktreeMetadataRecord> { return this.read().worktrees }
  /** 마지막 읽기에서 버린 작업 링크 칸. */
  droppedLinks(): DroppedLink[] { return [...this.dropped] }

  private read(): RegistryData {
    let data: unknown
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')) }
    catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
      data = { version: 2, repos: [], setups: [] }
    }
    if (!Array.isArray(data) && !isRecord(data)) throw new Error('Invalid registry')
    const entries: unknown = Array.isArray(data) ? data : data.repos
    if (!Array.isArray(entries)) throw new Error('Invalid repo registry')
    const repos: RepoRecord[] = []
    for (const entry of entries) {
      if (typeof entry === 'string') {
        const root = canonicalPath(entry)
        // Stable UUID during read-only v1 migration, even across GUI/CLI processes.
        const hex = createHash('sha256').update(root).digest('hex')
        const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
        if (!repos.some(repo => repo.path === root)) repos.push({ id, path: root, name: path.basename(root), projectId: `repo:${id}`, baseRef: null, method: 'imported-existing-folder' })
      } else if (isRepo(entry)) {
        repos.push(entry)
      } else throw new Error('Invalid repo record')
    }
    const setups: unknown = Array.isArray(data) ? [] : data.setups ?? []
    if (!Array.isArray(setups) || !setups.every(isSetup)) throw new Error('Invalid setups')
    let worktrees: unknown = Array.isArray(data) ? undefined : data.worktrees
    if (worktrees === undefined) {
      try { worktrees = JSON.parse(fs.readFileSync(this.legacyMetadata, 'utf8')) }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; worktrees = {} }
    }
    if (!isRecord(worktrees)) throw new Error('Invalid worktree metadata')
    const metadata: Record<string, WorktreeMetadataRecord> = {}
    const dropped: DroppedLink[] = []
    for (const [target, value] of Object.entries(worktrees)) {
      if (!isMetadata(value)) throw new Error('Invalid worktree metadata')
      // LIFE-603: the work-link fields are optional extras. A damaged one is dropped on read (and so on the next
      // write) instead of failing the whole registry — the other keys of that worktree stay exactly as they were.
      if (value.workLink !== undefined && value.workLink !== null && readStoredWorkLink(value.workLink) === null) {
        delete value.workLink
        dropped.push({ path: target, field: 'workLink' })
      }
      if (value.workLinkSuppressed !== undefined && typeof value.workLinkSuppressed !== 'boolean') {
        delete value.workLinkSuppressed
        dropped.push({ path: target, field: 'workLinkSuppressed' })
      }
      metadata[target] = value
    }
    this.dropped = dropped
    return { version: 2, repos, setups, worktrees: metadata }
  }

  /** Synchronous read-modify-rename, shared by GUI and runtime. No stale cached records. */
  change<T>(mutate: (data: RegistryData) => T): T {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const release = acquireRegistryLock(this.file)
    const tmp = `${this.file}.${randomUUID()}.tmp`
    try {
      const data = this.read()
      const result = mutate(data)
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      fs.rmSync(this.legacyMetadata, { force: true })
      this.lastError = null
      return result
    } finally {
      fs.rmSync(tmp, { force: true })
      release()
    }
  }

  register(root: string, fields: Partial<RepoRecord> = {}): RepoRecord {
    return this.change(data => {
      if (data.repos.some(repo => repo.path === root)) throw new Error(`Repo already registered: ${root}`)
      const id = randomUUID()
      const repo: RepoRecord = { id, path: root, name: path.basename(root), projectId: `repo:${id}`, baseRef: null, method: 'imported-existing-folder', ...fields }
      data.repos.push(repo)
      return repo
    })
  }

  add(input: string): AddRepoResult {
    try {
      const root = repoRootOf(input)
      if (!this.records().some(repo => repo.path === root)) this.register(root)
      return { ok: true, root }
    } catch (error) { return { ok: false, error: String(error) } }
  }

  /**
   * 제거 성공이면 `rootsAfter` = 제거를 쓴 **그 트랜잭션 안(잠금 보유 중)** 의 등록 목록 — 잠금이 풀린 뒤 다른 작성자가
   * 바꾼 내용이 섞이지 않는다(LIFE-469 R4-01, 세대 관측용). IPC 로 내보내기 전에 main 이 떼어 낸다.
   */
  remove(input: string): RemoveRepoResult & { rootsAfter?: string[] } {
    try {
      const resolved = canonicalPath(expandPath(input))
      const records = this.records()
      const root = records.some(repo => repo.path === resolved) ? resolved : repoRootOf(input)
      return this.change(data => {
        if (!data.repos.some(repo => repo.path === root)) throw new Error(`목록에 없다: ${root}`)
        unregisterRepo(data, data.repos.find(repo => repo.path === root)!.id)
        return { ok: true as const, root, rootsAfter: data.repos.map(repo => repo.path).sort() }
      })
    } catch (error) { return { ok: false, error: String(error) } }
  }
}

export function expandPath(input: string): string {
  if (!input.trim()) throw new Error('경로가 비었다')
  return input.startsWith('~/') ? path.join(process.env.HOME ?? '', input.slice(2)) : input
}

export function repoRootOf(input: string): string {
  const target = canonicalPath(expandPath(input))
  const cwd = fs.statSync(target).isDirectory() ? target : path.dirname(target)
  const run = (args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  run(['rev-parse', '--show-toplevel'])
  const common = canonicalPath(path.resolve(cwd, run(['rev-parse', '--git-common-dir'])))
  const main = run(['worktree', 'list', '--porcelain', '-z']).split('\0').find(line => line.startsWith('worktree '))?.slice(9)
  return main ? canonicalPath(main) : path.dirname(common)
}

function isRepo(value: unknown): value is RepoRecord {
  return isRecord(value) && ['id', 'path', 'name', 'projectId', 'method'].every(key => typeof value[key] === 'string') && (value.baseRef === null || typeof value.baseRef === 'string')
    && (value.setupCommand === undefined || value.setupCommand === null || typeof value.setupCommand === 'string')
}
function isSetup(value: unknown): value is SetupRecord {
  return isRecord(value) && ['id', 'projectId', 'hostId', 'kind', 'state', 'method'].every(key => typeof value[key] === 'string') && ['path', 'displayName', 'worktreeBasePath', 'gitUsername'].every(key => value[key] === null || typeof value[key] === 'string')
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
function isMetadata(value: unknown): value is WorktreeMetadataRecord {
  if (!isRecord(value)) return false
  for (const key of ['repoId', 'displayName', 'comment', 'parentWorktreeId', 'workspaceStatus']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') return false
  }
  if (value.createdBranch !== undefined && typeof value.createdBranch !== 'boolean') return false
  if (value.linkedIssue !== undefined && value.linkedIssue !== null && !Number.isSafeInteger(value.linkedIssue)) return false
  const linear = value.linkedLinearIssue
  return linear === undefined || linear === null || (isRecord(linear) && typeof linear.identifier === 'string' &&
    ['organizationKey', 'url'].every(key => linear[key] === null || typeof linear[key] === 'string'))
}

/** Atomic directory rename: an acquired lock is never empty. Reapers only unlink
 * the observed dead owner's unique file, never recursively remove the lock path.
 * Thus a late reaper cannot delete a new owner's file or nonempty directory. */
function acquireRegistryLock(file: string): () => void {
  const lock = file + '.lock'
  const owner = `${process.pid}-${randomUUID()}`
  const candidate = lock + '.' + owner
  fs.mkdirSync(candidate, { mode: 0o700 })
  try {
    fs.writeFileSync(path.join(candidate, owner), '', { mode: 0o600 })
    const deadline = Date.now() + 1500
    while (true) {
      try {
        fs.renameSync(candidate, lock)
        return () => {
          fs.unlinkSync(path.join(lock, owner))
          try { fs.rmdirSync(lock) } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].some(code => hasCode(error, code))) throw error
          }
        }
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].some(code => hasCode(error, code))) throw error
      }
      try {
        for (const entry of fs.readdirSync(lock)) {
          if (!/^\d+-[a-f0-9-]+$/.test(entry)) continue
          const pid = Number(entry.split('-')[0])
          if (pid <= 0) continue
          try { process.kill(pid, 0) } catch (error) {
            if (hasCode(error, 'ESRCH')) {
              try { fs.unlinkSync(path.join(lock, entry)) } catch (unlinkError) {
                if (!hasCode(unlinkError, 'ENOENT')) throw unlinkError
              }
            }
          }
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].some(code => hasCode(error, code))) throw error
      }
      if (Date.now() >= deadline) throw new Error(`Registry busy: ${lock}; retry after the owner finishes. For a legacy or malformed lock, stop all profile owners before removing it.`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  } finally { fs.rmSync(candidate, { recursive: true, force: true }) }
}
