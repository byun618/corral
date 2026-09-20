import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import specs from './specs.json'
import { RuntimeError, stringFlag, reject, type CommandModule, type CommandSpec, type Invocation, type CommandContext } from '../contracts.js'
import { RepoRegistry, repoRootOf, type RepoRecord, type SetupRecord } from '../../main/registry.js'
import { contains, git, projects, repoSelect, repoSetup, resolvePath, unique, WorktreeMetadata, worktreeSelect, type Metadata, type WorkspaceDesktop, type WorktreeRecord } from './model.js'

export const workspaceSpecs: CommandSpec[] = specs
const required: Record<string, string[]> = {
  'repo add': ['path'], 'repo show': ['repo'], 'repo search-refs': ['repo', 'query'], 'repo set-base-ref': ['repo', 'ref'],
  'project setup-existing-folder': ['project', 'path'], 'project setup-clone': ['project', 'url', 'destination'],
  'project setup-create': ['project', 'host'], 'project setup-update': ['setup'], 'project setup-delete': ['setup'],
  'worktree create': ['name'], 'worktree set': ['worktree'], 'worktree show': ['worktree'], 'worktree rm': ['worktree'],
}
export function validateWorkspace(inv: Invocation): void {
  const f = inv.flags
  for (const key of ['pairing-code', 'environment']) if (key in f) throw new RuntimeError('unsupported', `--${key} requires LIFE-403`)
  if (f.host !== undefined && f.host !== 'local') throw new RuntimeError('unsupported', 'Remote hosts require LIFE-403')
  for (const key of ['agent', 'prompt']) if (key in f) throw new RuntimeError('unsupported', `--${key} requires LIFE-394`)
  if (f['run-hooks'] || (inv.command === 'worktree create' && f.setup === 'run')) throw new RuntimeError('unsupported', 'Setup/archive hooks require LIFE-412')
  for (const key of required[inv.command] ?? []) stringFlag(f, key, true)
  if (f['no-parent'] && f['parent-worktree'] !== undefined) reject('--parent-worktree and --no-parent are mutually exclusive')
  if (f.limit !== undefined && (!/^\d+$/.test(String(f.limit)) || Number(f.limit) < 1 || Number(f.limit) > 10000)) reject('--limit must be 1..10000')
  if (f.issue !== undefined && f.issue !== 'null' && (!/^[1-9]\d*$/.test(String(f.issue)) || !Number.isSafeInteger(Number(f.issue)))) reject('--issue must be a positive integer or null')
  for (const [key, values] of Object.entries({ kind: ['git', 'folder'], state: ['ready', 'not-set-up', 'setting-up', 'error', 'unsupported'], method: ['imported-existing-folder', 'cloned', 'provisioned', ...(inv.command === 'project setup-update' ? ['legacy-repo'] : [])] })) {
    if (f[key] !== undefined && !values.includes(String(f[key]))) reject(`Invalid --${key}`)
  }
  if (inv.command === 'worktree create') {
    if (['repo', 'project', 'project-host-setup'].filter(key => key in f).length > 1) reject('Choose one repo/project/setup selector')
    if (f.setup !== undefined && !['skip', 'inherit'].includes(String(f.setup))) reject('--setup must be skip or inherit')
  }
  if (f['linear-issue'] !== undefined) parseLinear(String(f['linear-issue']))
}
function parseLinear(value: string): Metadata['linkedLinearIssue'] {
  if (value === 'null') return null
  const url = /^https:\/\/linear\.app\/([^/]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^\s]*)?$/.exec(value)
  if (url) return { identifier: url[2]!.toUpperCase(), organizationKey: url[1]!, url: value }
  if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value)) reject('Invalid Linear identifier or URL')
  return { identifier: value.toUpperCase(), organizationKey: null, url: null }
}
const reads = new Set(['repo list', 'repo show', 'repo search-refs', 'project list', 'project setups', 'worktree list', 'worktree show', 'worktree current', 'worktree ps'])
const isMutation = (inv: Invocation) => !reads.has(inv.command)

export function workspaceModule(userData: string, desktop?: WorkspaceDesktop): CommandModule {
  const registry = new RepoRegistry(userData), metadata = new WorktreeMetadata(userData)
  return {
    specs: workspaceSpecs, validate: validateWorkspace, isMutation,
    serialKey: () => 'workspace',
    async execute(inv, ctx) {
      const f = inv.flags, flag = (key: string) => stringFlag(f, key), need = (key: string) => stringFlag(f, key, true)!
      const allRepos = registry.records()
      const project = (id: string) => unique(projects(registry).filter(row => row.id === id), id)
      const selectRepo = (selector: string) => repoSelect(registry.records(), selector, inv.cwd)
      const addRepo = (input: string, fields: Partial<RepoRecord> = {}) => {
        let root: string
        try { root = repoRootOf(resolvePath(input, inv.cwd)) } catch (error) { throw new RuntimeError('invalid_argument', `Not a Git checkout: ${String(error)}`) }
        if (registry.records().some(row => row.path === root)) throw new RuntimeError('already_exists', `Already registered: ${root}`)
        return registry.register(root, fields)
      }
      const setupFields = (): Partial<SetupRecord> => {
        const update: Partial<SetupRecord> = {}
        for (const [key, field] of [['display-name', 'displayName'], ['path', 'path'], ['worktree-base-path', 'worktreeBasePath'], ['git-username', 'gitUsername'], ['kind', 'kind'], ['state', 'state'], ['method', 'method']] as const) {
          const value = flag(key)
          if (value !== undefined) Object.assign(update, { [field]: value === 'null' && ['path', 'displayName', 'worktreeBasePath', 'gitUsername'].includes(field) ? null : ['path', 'worktreeBasePath'].includes(field) ? resolvePath(value, inv.cwd) : value })
        }
        return update
      }
      const createSetup = (projectId: string, overrides: Partial<SetupRecord> = {}) => {
        const setup: SetupRecord = { id: flag('setup-id') ?? randomUUID(), projectId, hostId: 'local', path: null, kind: 'git', displayName: null, worktreeBasePath: null, gitUsername: null, state: 'not-set-up', method: 'provisioned', ...setupFields(), ...overrides }
        registry.change(data => {
          if ([...data.repos, ...data.setups].some(row => row.id === setup.id)) throw new RuntimeError('already_exists', `Setup exists: ${setup.id}`)
          data.setups.push(setup)
        })
        return { project: project(projectId), setup }
      }
      let result: unknown
      switch (inv.command) {
        case 'repo list': return { repos: allRepos }
        case 'repo show': return { repo: selectRepo(need('repo')) }
        case 'repo add': result = { repo: addRepo(need('path')) }; break
        case 'repo search-refs': {
          const repo = selectRepo(need('repo'))
          const names = (await git(repo.path, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], ctx.signal)).split('\n').filter(name => name && name.toLowerCase().includes(need('query').toLowerCase()))
          const limit = Number(f.limit ?? 100)
          return { refs: names.slice(0, limit).map(ref => ({ name: ref.replace(/^refs\/(heads|remotes|tags)\//, ''), ref, type: ref.startsWith('refs/tags/') ? 'tag' : ref.startsWith('refs/remotes/') ? 'remote' : 'branch' })), truncated: names.length > limit }
        }
        case 'repo set-base-ref': {
          const repo = selectRepo(need('repo')), ref = need('ref')
          await verifyRef(repo.path, ref, ctx)
          registry.change(data => { data.repos.find(row => row.id === repo.id)!.baseRef = ref })
          result = { repo: selectRepo(repo.id) }; break
        }
        case 'project list': return { projects: projects(registry) }
        case 'project setups': {
          if (f.project) project(need('project'))
          return { setups: [...allRepos.map(repoSetup), ...registry.setups()].filter(setup => !f.project || setup.projectId === f.project) }
        }
        case 'project setup-create': {
          const selected = project(need('project'))
          result = createSetup(selected.id); break
        }
        case 'project setup-existing-folder': {
          const selected = project(need('project')), target = resolvePath(need('path'), inv.cwd)
          if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) reject('Folder does not exist')
          let root: string | undefined
          if (f.kind !== 'folder') { try { root = repoRootOf(target) } catch { /* Non-git folders are metadata only. */ } }
          if (root) {
            const repo = addRepo(root, { projectId: selected.id, displayName: flag('display-name') })
            result = { project: project(selected.id), setup: repoSetup(repo), repo }
          } else result = createSetup(selected.id, { path: target, kind: 'folder', state: 'ready', method: 'imported-existing-folder' })
          break
        }
        case 'project setup-clone': {
          const selected = project(need('project')), url = need('url'), destination = resolvePath(need('destination'), inv.cwd)
          let source: string
          if (url.startsWith('https://')) {
            let parsed: URL
            try { parsed = new URL(url) } catch { reject('Invalid clone URL') }
            if (parsed.username || parsed.password) throw new RuntimeError('unsupported', 'Authenticated clones are not supported')
            source = url
          } else {
            const local = resolvePath(url, inv.cwd)
            if (/^[\w+.-]+:/.test(url) || url.includes('@') || !fs.existsSync(local)) throw new RuntimeError('unsupported', 'Only local paths and unauthenticated HTTPS clones are supported')
            source = local
          }
          if (fs.existsSync(destination)) throw new RuntimeError('already_exists', `Destination exists: ${destination}`)
          try {
            await git(inv.cwd, ['-c', 'credential.helper=', '-c', 'core.askPass=', 'clone', '--', source, destination], ctx.signal)
            const repo = addRepo(destination, { projectId: selected.id, method: 'cloned', displayName: flag('display-name') })
            result = { project: project(selected.id), setup: repoSetup(repo), repo }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new RuntimeError(/Authentication|could not read Username|terminal prompts disabled/i.test(message) ? 'unsupported' : error instanceof RuntimeError ? error.code : 'git_failed', message, fs.existsSync(destination) ? { path: destination } : undefined)
          }
          break
        }
        case 'project setup-update':
        case 'project setup-delete': {
          const id = need('setup'), repo = allRepos.find(row => row.id === id)
          const setup = unique([...allRepos.map(repoSetup), ...registry.setups()].filter(row => row.id === id), id)
          const selected = project(setup.projectId)
          if (inv.command.endsWith('delete')) {
            registry.change(data => { data.repos = data.repos.filter(row => row.id !== id); data.setups = data.setups.filter(row => row.id !== id) })
            result = { project: selected, setup }
          } else {
            if (repo && ['path', 'kind', 'state', 'method'].some(key => key in f)) reject('Repo-backed setups only allow display-name, git-username and worktree-base-path updates')
            const update = setupFields()
            registry.change(data => Object.assign((repo ? data.repos : data.setups).find(row => row.id === id)!, update))
            const updatedRepo = registry.records().find(row => row.id === id)
            result = { project: project(setup.projectId), setup: updatedRepo ? repoSetup(updatedRepo) : registry.setups().find(row => row.id === id), ...(updatedRepo ? { repo: updatedRepo } : {}) }
          }
          break
        }
        default: result = await executeWorktree(inv, ctx, registry, metadata, desktop)
      }
      if (isMutation(inv)) await desktop?.changed()
      return result
    },
  }
}
async function verifyRef(root: string, ref: string, ctx: CommandContext): Promise<void> {
  try { await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], ctx.signal) }
  catch { reject(`Invalid commit ref: ${ref}`) }
}
async function executeWorktree(inv: Invocation, ctx: CommandContext, registry: RepoRegistry, metadata: WorktreeMetadata, desktop?: WorkspaceDesktop): Promise<unknown> {
  const f = inv.flags, flag = (key: string) => stringFlag(f, key), need = (key: string) => stringFlag(f, key, true)!
  const repos = registry.records(), records = await metadata.list(repos, ctx.signal)
  const select = async (value: string) => worktreeSelect(records, value, inv.cwd, value === 'active' && desktop ? (await desktop.observe()).find(row => row.isActive)?.path ?? '' : undefined)
  const updateMetadata = async (target?: WorktreeRecord): Promise<Metadata> => {
    const update: Metadata = {}
    for (const [key, field] of [['display-name', 'displayName'], ['comment', 'comment'], ['workspace-status', 'workspaceStatus']] as const) {
      const value = flag(key)
      if (value !== undefined) update[field] = value === 'null' ? null : value
    }
    if (f.issue !== undefined) update.linkedIssue = f.issue === 'null' ? null : Number(f.issue)
    if (f['linear-issue'] !== undefined) update.linkedLinearIssue = parseLinear(need('linear-issue'))
    if (f['no-parent']) update.parentWorktreeId = null
    else if (f['parent-worktree'] !== undefined) {
      const parent = await select(need('parent-worktree'))
      let cursor: WorktreeRecord | undefined = parent
      const visited = new Set<string>()
      while (cursor) {
        if (cursor.id === target?.id || visited.has(cursor.id)) reject('Lineage cycle is not allowed')
        visited.add(cursor.id)
        cursor = records.find(row => row.id === cursor!.parentWorktreeId)
      }
      update.parentWorktreeId = parent.id
    } else if (inv.command === 'worktree create') {
      update.parentWorktreeId = records.filter(row => contains(row.path, resolvePath(inv.cwd, inv.cwd))).sort((a, b) => b.path.length - a.path.length)[0]?.id ?? null
    }
    return update
  }
  const page = (rows: unknown[]) => ({ worktrees: rows.slice(0, Number(f.limit ?? 100)), hostScope: { hostIds: ['local'], omittedHostIds: [], omittedHostSelectors: [] }, totalCount: rows.length, truncated: rows.length > Number(f.limit ?? 100) })
  if (inv.command === 'worktree list') {
    const repo = f.repo ? repoSelect(repos, need('repo'), inv.cwd) : undefined
    return page(records.filter(row => !repo || row.repoId === repo.id))
  }
  if (inv.command === 'worktree ps') {
    if (!desktop) throw new RuntimeError('backend_unavailable', 'Process observation requires the connected desktop backend')
    const observed = await desktop.observe()
    return page(records.map(row => ({ ...row, ...observed.find(item => item.path === row.path) })))
  }
  if (inv.command === 'worktree current' || inv.command === 'worktree show') return { worktree: await select(inv.command === 'worktree current' ? 'current' : need('worktree')) }
  if (inv.command === 'worktree set') {
    const target = await select(need('worktree'))
    metadata.put(target.path, await updateMetadata(target))
    return { worktree: (await metadata.list(repos, ctx.signal)).find(row => row.id === target.id) }
  }
  if (inv.command === 'worktree create') {
    if (f.activate && !desktop) throw new RuntimeError('ui_unavailable', '--activate requires a desktop')
    if (f.activate) await desktop!.observe() // Connection preflight before git effects.
    let repo: RepoRecord
    if (f.repo) repo = repoSelect(repos, need('repo'), inv.cwd)
    else if (f.project) {
      unique(projects(registry).filter(row => row.id === f.project), need('project'))
      repo = unique(repos.filter(row => row.projectId === f.project), need('project'))
    } else if (f['project-host-setup']) {
      repo = unique(repos.filter(row => row.id === f['project-host-setup']), need('project-host-setup'))
    } else {
      const inferred = records.filter(row => contains(row.path, resolvePath(inv.cwd, inv.cwd))).sort((a, b) => b.path.length - a.path.length)[0]
      if (!inferred) reject('Cannot infer repo from cwd; specify --repo')
      repo = repos.find(row => row.id === inferred.repoId)!
    }
    const name = need('name')
    try { await git(repo.path, ['check-ref-format', '--branch', name], ctx.signal) } catch { reject('Invalid branch name') }
    if (name.startsWith('-') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.')) reject('Invalid worktree name')
    const target = resolvePath(path.join(repo.path, '.claude/worktrees', name), inv.cwd)
    if (!contains(resolvePath(path.join(repo.path, '.claude/worktrees'), inv.cwd), target)) reject('Worktree path escapes base directory')
    const existingBranch = await git(repo.path, ['for-each-ref', '--format=%(refname)', `refs/heads/${name}`], ctx.signal)
    if (fs.existsSync(target) || records.some(row => row.path === target) || existingBranch) throw new RuntimeError('already_exists', `Branch or path exists: ${name}`)
    const base = flag('base-branch') ?? repo.baseRef ?? 'HEAD'
    await verifyRef(repo.path, base, ctx)
    const update = await updateMetadata()
    await git(repo.path, ['worktree', 'add', '-b', name, target, base], ctx.signal)
    try {
      metadata.put(target, { ...update, createdBranch: true })
      const activated = f.activate ? await desktop!.activate(repo.path, target) : undefined
      const worktree = (await metadata.list(repos, ctx.signal)).find(row => row.path === target)!
      return { worktree, lineage: { parentWorktreeId: worktree.parentWorktreeId, childWorktreeIds: worktree.childWorktreeIds }, warnings: [], setupReceipt: { policy: flag('setup') ?? 'inherit', status: 'skipped', ...(activated ?? {}) } }
    } catch (error) {
      throw new RuntimeError(error instanceof RuntimeError ? error.code : 'git_failed', `Worktree created, follow-up failed: ${String(error)}`, { path: target, branch: name })
    }
  }
  if (inv.command === 'worktree rm') {
    const target = await select(need('worktree')), repo = repos.find(row => row.id === target.repoId)!
    if (target.isMainWorktree) throw new RuntimeError('protected_worktree', 'Cannot remove the main checkout')
    const dirty = await git(target.path, ['status', '--porcelain', '--untracked-files=all'], ctx.signal)
    if (dirty && !f.force) throw new RuntimeError('dirty_worktree', 'Worktree has uncommitted changes; use --force')
    let warning: string | undefined
    if (desktop) {
      const observation = (await desktop.observe()).find(row => row.path === target.path)
      if (observation?.liveTerminalCount && !f.force) throw new RuntimeError('worktree_busy', 'Worktree has live terminals; use --force')
      await desktop.close(target.path)
    } else warning = 'Terminal state is unavailable in headless mode; running processes were not checked.'
    const ownedBranch = metadata.read()[target.path]?.createdBranch
    await git(repo.path, ['worktree', 'remove', ...(f.force ? ['--force'] : []), target.path], ctx.signal)
    let preservedBranch: { branchName: string; head: string } | undefined
    if (target.branch) {
      if (ownedBranch) {
        try { await git(repo.path, ['branch', '-d', '--', target.branch], ctx.signal) }
        catch { preservedBranch = { branchName: target.branch, head: target.head } }
      } else preservedBranch = { branchName: target.branch, head: target.head }
    }
    try { metadata.remove(target) } catch (error) { throw new RuntimeError('git_failed', `Worktree removed but metadata cleanup failed: ${String(error)}`, { path: target.path, removed: true, preservedBranch }) }
    return { removed: true, ...(preservedBranch ? { preservedBranch } : {}), ...(warning ? { warning } : {}) }
  }
  reject(`Unknown workspace command: ${inv.command}`)
}
