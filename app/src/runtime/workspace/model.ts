import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RepoRegistry, type RepoRecord, type SetupRecord, type WorktreeMetadataRecord, expandPath } from '../../main/registry.js'
import { canonicalPath } from '../../main/canonical-path.js'
import { RuntimeError } from '../contracts.js'

const run = promisify(execFile)
export async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30000, signal, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    return stdout.trim()
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : String(error)
    throw new RuntimeError('git_failed', stderr)
  }
}
export const resolvePath = (input: string, cwd: string) => canonicalPath(path.resolve(cwd, expandPath(input)))
export const contains = (root: string, target: string) => target === root || target.startsWith(root + path.sep)

/**
 * LIFE-423 M1: selecting a repo or worktree is a registry read, so neither refusal has begun an
 * effect. `terminal create --worktree` and `worktree create` make that selection inside their
 * `Receipts.run`, where the outcome is what decides whether the `--request-id` stays unspent; the
 * stage is left alone (b2), since these codes have never carried one.
 */
export function unique<T extends { id: string }>(items: T[], selector: string): T {
  if (!items.length) throw new RuntimeError('not_found', `No match for ${selector}`, undefined, undefined, 'not_started')
  if (items.length > 1) throw new RuntimeError('ambiguous_target', `Ambiguous target ${selector}: ${items.map(item => item.id).join(', ')}`, { candidates: items.map(item => item.id) }, undefined, 'not_started')
  return items[0]!
}
export function repoSelect(repos: RepoRecord[], selector: string, cwd: string): RepoRecord {
  const prefixed = /^(id|name|path):(.*)$/s.exec(selector)
  const value = prefixed?.[2] ?? selector
  return unique(repos.filter(repo => {
    if (prefixed?.[1] === 'id') return repo.id === value
    if (prefixed?.[1] === 'name') return (repo.displayName ?? repo.name) === value
    if (prefixed?.[1] === 'path') return repo.path === resolvePath(value, cwd)
    return repo.id === value || repo.name === value || repo.displayName === value || repo.path === resolvePath(value, cwd)
  }), selector)
}
export function projects(registry: RepoRegistry) {
  const repos = registry.records(), setups = registry.setups()
  return [...new Set([...repos.map(repo => repo.projectId), ...setups.map(setup => setup.projectId)])].map(id => ({
    id, name: repos.find(repo => repo.projectId === id)?.name ?? id,
    sourceRepoIds: repos.filter(repo => repo.projectId === id).map(repo => repo.id),
  }))
}
export function repoSetup(repo: RepoRecord): SetupRecord {
  return { id: repo.id, projectId: repo.projectId, hostId: 'local', path: repo.path, kind: 'git', displayName: repo.displayName ?? repo.name, worktreeBasePath: repo.worktreeBasePath ?? null, gitUsername: repo.gitUsername ?? null, state: 'ready', method: repo.method }
}
export type Metadata = WorktreeMetadataRecord
export interface WorktreeRecord {
  id: string
  repoId: string
  projectId: string
  hostId: string
  path: string
  branch: string | null
  head: string
  displayName: string
  isMainWorktree: boolean
  comment: string | null
  linkedIssue: number | null
  linkedLinearIssue: Metadata['linkedLinearIssue']
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  workspaceStatus: string | null
}
export class WorktreeMetadata {
  constructor(private readonly registry: RepoRegistry) {}
  read(): Record<string, Metadata> { return this.registry.metadata() }
  put(target: string, update: Metadata): void {
    this.registry.change(data => { data.worktrees[target] = { ...data.worktrees[target], ...update } })
  }
  /** LIFE-603 R1-J: a newly created worktree does not inherit a stale work link or detach exception left at the same path
   *  (e.g. a worktree removed outside corral). Other existing keys merge as `put` does. */
  create(target: string, update: Metadata): void {
    this.registry.change(data => {
      const next: Metadata = { ...data.worktrees[target], ...update }
      delete next.workLink
      delete next.workLinkSuppressed
      data.worktrees[target] = next
    })
  }
  remove(target: WorktreeRecord): void {
    this.registry.change(data => {
      delete data.worktrees[target.path]
      for (const value of Object.values(data.worktrees)) if (value.parentWorktreeId === target.id) value.parentWorktreeId = null
    })
  }
  async list(repos: RepoRecord[], signal?: AbortSignal): Promise<WorktreeRecord[]> {
    const metadata = this.read(), records: WorktreeRecord[] = []
    for (const repo of repos) {
      const output = await git(repo.path, ['worktree', 'list', '--porcelain', '-z'], signal)
      const blocks = output.split('\0\0').filter(Boolean)
      for (const [index, block] of blocks.entries()) {
        const lines = block.split('\0')
        const field = (key: string) => lines.find(line => line.startsWith(key + ' '))?.slice(key.length + 1)
        const target = field('worktree')
        if (!target || !fs.existsSync(target)) continue
        const root = canonicalPath(target), meta = metadata[root] ?? {}
        const branch = field('branch') ?? null
        records.push({ id: `${repo.id}::${root}`, repoId: repo.id, projectId: repo.projectId, hostId: 'local', path: root, branch,
          head: field('HEAD') ?? '', displayName: meta.displayName ?? branch?.replace(/^refs\/heads\//, '') ?? path.basename(root), isMainWorktree: index === 0,
          comment: meta.comment ?? null, linkedIssue: meta.linkedIssue ?? null, linkedLinearIssue: meta.linkedLinearIssue ?? null,
          parentWorktreeId: meta.parentWorktreeId ?? null, childWorktreeIds: [], workspaceStatus: meta.workspaceStatus ?? null })
      }
    }
    for (const record of records) record.childWorktreeIds = records.filter(child => child.parentWorktreeId === record.id).map(child => child.id)
    return records
  }
}
export interface ProcessObservation {
  path: string
  liveTerminalCount: number
  hasAttachedPty: boolean
  isActive: boolean
  status: string
  agents: { paneKey: string; agentType: string; state: string }[]
}
/** UI capabilities are injected; the headless domain has no Electron/backend wire imports. */
export interface WorkspaceDesktop {
  changed(): Promise<void>
  observe(): Promise<ProcessObservation[]>
  activate(repoRoot: string, target: string): Promise<{ parentOpened: boolean }>
  close(target: string): Promise<void>
}
export function worktreeSelect(records: WorktreeRecord[], selector: string, cwd: string, active?: string): WorktreeRecord {
  if (/^(identity|folder):/.test(selector)) throw new RuntimeError('invalid_argument', 'identity: and folder: selectors are not supported')
  if (selector === 'active' && active === undefined) throw new RuntimeError('ui_unavailable', 'Active worktree requires a desktop')
  if (selector === 'current') {
    const target = canonicalPath(cwd)
    const matches = records.filter(record => contains(record.path, target)).sort((a, b) => b.path.length - a.path.length)
    return unique(matches.slice(0, 1), selector)
  }
  if (selector === 'active') return unique(records.filter(record => record.path === active), selector)
  const prefixed = /^(id|path|branch|name|issue):(.*)$/s.exec(selector)
  const value = prefixed?.[2] ?? selector
  return unique(records.filter(record => {
    switch (prefixed?.[1]) {
      case 'id': return record.id === value
      case 'path': return record.path === resolvePath(value, cwd)
      case 'branch': return (record.branch === value || record.branch === `refs/heads/${value}`)
      case 'name': return record.displayName === value
      case 'issue': return String(record.linkedIssue) === value || record.linkedLinearIssue?.identifier === value
      default: return record.id === value || record.path === resolvePath(value, cwd) || (record.branch === value || record.branch === `refs/heads/${value}`) || record.displayName === value
    }
  }), selector)
}
