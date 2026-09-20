import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RepoRegistry, type RepoRecord, type SetupRecord, expandPath } from '../../main/registry.js'
import { canonicalPath } from '../../main/canonical-path.js'
import { RuntimeError } from '../contracts.js'
import { atomicWrite, readFile } from '../storage.js'

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

export function unique<T extends { id: string }>(items: T[], selector: string): T {
  if (!items.length) throw new RuntimeError('not_found', `No match for ${selector}`)
  if (items.length > 1) throw new RuntimeError('ambiguous_target', `Ambiguous target ${selector}: ${items.map(item => item.id).join(', ')}`, { candidates: items.map(item => item.id) })
  return items[0]!
}
export function repoSelect(repos: RepoRecord[], selector: string, cwd: string): RepoRecord {
  const prefixed = /^(id|name|path):(.*)$/.exec(selector)
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
export interface Metadata {
  displayName?: string | null
  comment?: string | null
  linkedIssue?: number | null
  linkedLinearIssue?: { identifier: string; organizationKey: string | null; url: string | null } | null
  parentWorktreeId?: string | null
  workspaceStatus?: string | null
  createdBranch?: boolean
}
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
  readonly file: string
  constructor(userData: string) { this.file = path.join(userData, 'worktree-metadata.json') }
  read(): Record<string, Metadata> { return readFile(this.file, () => ({})) }
  put(target: string, update: Metadata): void {
    const data = this.read()
    data[target] = { ...data[target], ...update }
    atomicWrite(this.file, data)
  }
  remove(target: WorktreeRecord): void {
    const data = this.read()
    delete data[target.path]
    for (const value of Object.values(data)) if (value.parentWorktreeId === target.id) value.parentWorktreeId = null
    atomicWrite(this.file, data)
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
        const branch = field('branch')?.replace(/^refs\/heads\//, '') ?? null
        records.push({ id: `${repo.id}::${root}`, repoId: repo.id, projectId: repo.projectId, hostId: 'local', path: root, branch,
          head: field('HEAD') ?? '', displayName: meta.displayName ?? branch ?? path.basename(root), isMainWorktree: index === 0,
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
  const prefixed = /^(id|path|branch|name|issue):(.*)$/.exec(selector)
  const value = prefixed?.[2] ?? selector
  return unique(records.filter(record => {
    switch (prefixed?.[1]) {
      case 'id': return record.id === value
      case 'path': return record.path === resolvePath(value, cwd)
      case 'branch': return record.branch === value
      case 'name': return record.displayName === value
      case 'issue': return String(record.linkedIssue) === value || record.linkedLinearIssue?.identifier === value
      default: return record.id === value || record.path === resolvePath(value, cwd) || record.branch === value || record.displayName === value
    }
  }), selector)
}
