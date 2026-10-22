// LIFE-478 K1·K4ⓔ·K7 — 카드 메뉴의 GUI 쓰기·삭제가 CLI 와 **같은 런타임 명령·같은 디스패처**를 타는지, 실제 git 레포와 실제 런타임으로 본다.
// GUI 쪽 = `card-actions.ts` → `startRuntime().invoke`(main 이 쓰는 손), CLI 쪽 = 같은 런타임의 소켓.
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startRuntime } from '../runtime/server.js'
import { localCall, request, socketPath } from '../runtime/transport.js'
import { CommandRegistry } from '../runtime/registry.js'
import { workspaceModule } from '../runtime/workspace/index.js'
import type { ProcessObservation, WorkspaceDesktop } from '../runtime/workspace/model.js'
import { RuntimeError } from '../runtime/contracts.js'
import { isRecord } from '../shared/json.js'
import { RepoRegistry } from './registry.js'
import { listGitWorktrees } from './git-worktrees.js'
import { joinTree, parentPathOf } from './tree.js'
import { copyPath, deleteWorktree, openInEditor, previewWorktreeDelete, revealInFinder, setWorktreeMeta, type CardActionDeps } from './card-actions.js'

const env = { ...process.env }
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  process.env = { ...env }
})

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l478-')))
  const data = path.join(root, 'data')
  const repo = path.join(root, 'repo')
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  delete process.env.CORRAL_RUNTIME_SOCKET
  delete process.env.CORRAL_SESSION
  delete process.env.CORRAL_BACKEND_SOCKET
  process.env.CORRAL_REGISTRY = path.join(data, 'repos.json')
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  fs.mkdirSync(repo)
  git('init', '-b', 'main')
  git('commit', '--allow-empty', '-m', 'one')
  // 데스크톱 관측 — `worktree rm` 의 바쁨 판정이 쓰는 것. 시험마다 바꾼다.
  const closed: string[] = []
  const desktop = { live: new Map<string, number>(), unavailable: false, closed }
  const workspaceDesktop: WorkspaceDesktop = {
    changed: async () => {},
    observe: async (): Promise<ProcessObservation[]> => {
      if (desktop.unavailable) throw new RuntimeError('backend_unavailable', 'Desktop backend is not connected')
      return [...desktop.live].map(([target, count]) => ({ path: target, liveTerminalCount: count, hasAttachedPty: count > 0, isActive: false, status: 'open', agents: [] }))
    },
    activate: async () => ({ parentOpened: false }),
    close: async (target) => {
      desktop.closed.push(target)
    },
  }
  const runtime = await startRuntime({ userData: data, workspaceDesktop })
  cleanups.push(() => runtime.close())
  const parser = new CommandRegistry()
  parser.register(workspaceModule(data))
  const cli = (...args: string[]) => localCall(socketPath(data), request(parser.parse(args, repo)))
  expect((await cli('repo', 'add', '--path', repo)).ok).toBe(true)
  const registry = new RepoRegistry(data)
  let rows: Array<{ repoRoot: string; path: string; branch: string | null; isLinked: boolean }> = []
  const refresh = async () => {
    rows = (await listGitWorktrees(repo)).worktrees.map((row) => ({ repoRoot: repo, ...row }))
  }
  const shown: string[] = []
  const copied: string[] = []
  const deps: CardActionDeps = {
    invoke: () => runtime.invoke,
    worktrees: () => rows,
    repoRoots: () => registry.list(),
    parentPaths: () => new Map(Object.entries(registry.metadata()).map(([target, meta]) => [target, parentPathOf(meta.parentWorktreeId)])),
    observe: workspaceDesktop.observe,
    showItemInFolder: (target) => shown.push(target),
    writeClipboard: (text) => copied.push(text),
    launchEditor: async (target) => (target.includes('missing-editor') ? 'Unable to find application named VS Code' : null),
    cwd: root,
  }
  const create = async (name: string) => {
    expect((await cli('worktree', 'create', '--name', name)).ok).toBe(true)
    await refresh()
    return fs.realpathSync(path.join(repo, '.claude/worktrees', name))
  }
  await refresh()
  return { root, data, repo, git, cli, registry, deps, desktop, create, refresh, shown, copied }
}

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))

describe('LIFE-478 K1 — GUI 메타 쓰기 = CLI worktree set', () => {
  it('ⓒ GUI 로 쓴 표시 이름·comment 가 CLI show 에, CLI 로 쓴 값이 GUI 트리 조인에 보인다', async () => {
    const f = await fixture()
    const a = await f.create('feat-a')
    expect(await setWorktreeMeta(f.deps, { path: a, displayName: '  내 이름  ', comment: '메모\n둘째 줄' })).toEqual({ ok: true })
    expect(await f.cli('worktree', 'show', '--worktree', `path:${a}`)).toMatchObject({ ok: true, result: { worktree: { displayName: '내 이름', comment: '메모\n둘째 줄' } } })
    expect((await f.cli('worktree', 'set', '--worktree', `path:${a}`, '--display-name', 'cli-name', '--comment', 'null')).ok).toBe(true)
    const tree = joinTree(
      [{ root: f.repo, name: 'repo', error: null, openError: null, worktrees: [{ path: a, branch: 'feat-a', head: null, isLinked: true, openWorkspaceId: null, gitStatus: { branch: 'feat-a', upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null } }] }],
      [],
      f.registry.metadata(),
    )
    // CLI `worktree create` 는 cwd(주 체크아웃)를 부모로 적는다 — 그 링크도 GUI 에 그대로 보인다.
    expect(tree.repos[0]?.worktrees[0]).toMatchObject({ displayName: 'cli-name', comment: null, parentPath: f.repo })
  })

  it('ⓒ 빈 표시 이름 = 지움(브랜치로 되돌림) — CLI 의 null 과 같다', async () => {
    const f = await fixture()
    const a = await f.create('feat-a')
    await setWorktreeMeta(f.deps, { path: a, displayName: 'x' })
    expect(await setWorktreeMeta(f.deps, { path: a, displayName: '   ' })).toEqual({ ok: true })
    expect(await f.cli('worktree', 'show', '--worktree', `path:${a}`)).toMatchObject({ result: { worktree: { displayName: 'feat-a' } } })
    expect(f.registry.metadata()[a]?.displayName).toBeNull()
  })

  it('ⓑ 계보 순환은 GUI 에서도 CLI 와 같은 오류로 거절된다 · 부모 지정/해제 왕복', async () => {
    const f = await fixture()
    const a = await f.create('feat-a')
    const b = await f.create('feat-b')
    expect(await setWorktreeMeta(f.deps, { path: b, parentPath: a })).toEqual({ ok: true })
    const gui = await setWorktreeMeta(f.deps, { path: a, parentPath: b })
    const cli = await f.cli('worktree', 'set', '--worktree', `path:${a}`, '--parent-worktree', `path:${b}`)
    expect(gui).toEqual({ ok: false, code: 'invalid_argument', error: 'Lineage cycle is not allowed' })
    expect(cli.error).toMatchObject({ code: 'invalid_argument', message: 'Lineage cycle is not allowed' })
    expect(parentPathOf(f.registry.metadata()[b]?.parentWorktreeId)).toBe(a)
    expect(await setWorktreeMeta(f.deps, { path: b, parentPath: null })).toEqual({ ok: true })
    expect(f.registry.metadata()[b]?.parentWorktreeId).toBeNull()
    // 주 체크아웃도 부모가 될 수 있다(198 F5).
    expect(await setWorktreeMeta(f.deps, { path: b, parentPath: f.repo })).toEqual({ ok: true })
  })

  it('ⓓ 레지스트리 잠금이 다른 살아 있는 주인에게 있으면 GUI 쓰기는 오류(Registry busy)로 돌아오고 값은 안 바뀐다', async () => {
    const f = await fixture()
    const a = await f.create('feat-a')
    const lock = path.join(f.data, 'repos.json.lock')
    fs.mkdirSync(lock)
    fs.writeFileSync(path.join(lock, `${process.pid}-00000000-0000-4000-8000-000000000000`), '')
    const result = await setWorktreeMeta(f.deps, { path: a, displayName: 'blocked' })
    fs.rmSync(lock, { recursive: true, force: true })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toMatch(/Registry busy/)
    expect(f.registry.metadata()[a]?.displayName ?? null).toBeNull()
  })

  it('ⓔ·ⓕ 다른 칸(레포·setups·다른 워크트리 메타·createdBranch)은 보존되고 형식은 version 2 · 기존 칸만', async () => {
    const f = await fixture()
    const a = await f.create('feat-a')
    const b = await f.create('feat-b')
    expect((await f.cli('worktree', 'set', '--worktree', `path:${b}`, '--comment', 'keep me', '--issue', '7')).ok).toBe(true)
    const before = readJson(path.join(f.data, 'repos.json'))
    expect(await setWorktreeMeta(f.deps, { path: a, displayName: 'renamed' })).toEqual({ ok: true })
    const after = readJson(path.join(f.data, 'repos.json'))
    expect(after).toMatchObject({ version: 2 })
    if (!isRecord(before) || !isRecord(after) || !isRecord(before.worktrees) || !isRecord(after.worktrees)) throw new Error('registry shape')
    const { worktrees: beforeWorktrees, ...beforeRest } = before
    const { worktrees: afterWorktrees, ...afterRest } = after
    expect(afterRest).toEqual(beforeRest)
    expect(afterWorktrees[b]).toEqual(beforeWorktrees[b])
    const beforeA = beforeWorktrees[a]
    expect(afterWorktrees[a]).toEqual({ ...(isRecord(beforeA) ? beforeA : {}), displayName: 'renamed' })
    const allowed = new Set(['repoId', 'displayName', 'comment', 'linkedIssue', 'linkedLinearIssue', 'parentWorktreeId', 'workspaceStatus', 'createdBranch'])
    for (const meta of Object.values(afterWorktrees)) for (const key of Object.keys(isRecord(meta) ? meta : {})) expect(allowed.has(key)).toBe(true)
  })

  it('ⓑ 직렬화 — GUI 쓰기와 CLI 쓰기를 동시에 보내도 잃는 쓰기가 없다', async () => {
    const f = await fixture()
    const a = await f.create('feat-a')
    const b = await f.create('feat-b')
    const results = await Promise.all([
      ...Array.from({ length: 5 }, (_, index) => setWorktreeMeta(f.deps, { path: a, comment: `gui-${index}` })),
      ...Array.from({ length: 5 }, (_, index) => f.cli('worktree', 'set', '--worktree', `path:${b}`, '--display-name', `cli-${index}`)),
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    const meta = f.registry.metadata()
    expect(meta[a]?.comment).toMatch(/^gui-\d$/)
    expect(meta[b]?.displayName).toMatch(/^cli-\d$/)
  })
})

describe('LIFE-478 K4ⓔ — 등록된 경로만', () => {
  it('등록 안 된 경로·상대경로·없는 경로는 거절, 등록된 워크트리·레포는 그 경로로', async () => {
    const f = await fixture()
    const a = await f.create('feat-a')
    for (const bad of ['/etc', 'relative/path', path.join(f.root, 'nope'), f.data]) {
      expect(revealInFinder(f.deps, { path: bad, kind: 'worktree' }).ok).toBe(false)
      expect(copyPath(f.deps, { path: bad }).ok).toBe(false)
      expect((await openInEditor(f.deps, { path: bad })).ok).toBe(false)
      expect((await setWorktreeMeta(f.deps, { path: bad, displayName: 'x' })).ok).toBe(false)
      expect((await deleteWorktree(f.deps, { path: bad, force: true })).ok).toBe(false)
    }
    expect(revealInFinder(f.deps, { path: a, kind: 'repo' }).ok).toBe(false)
    expect(revealInFinder(f.deps, { path: a, kind: 'worktree' })).toEqual({ ok: true })
    expect(revealInFinder(f.deps, { path: f.repo, kind: 'repo' })).toEqual({ ok: true })
    expect(copyPath(f.deps, { path: a })).toEqual({ ok: true })
    expect(f.shown).toEqual([a, f.repo])
    expect(f.copied).toEqual([a])
    expect(await setWorktreeMeta(f.deps, { path: a, parentPath: '/etc' })).toMatchObject({ ok: false })
  })
  it('편집기 실행 실패는 오류로 돌아온다(조용한 실패 금지)', async () => {
    const f = await fixture()
    const a = await f.create('missing-editor')
    expect(await openInEditor(f.deps, { path: a })).toEqual({ ok: false, code: 'editor_failed', error: 'Unable to find application named VS Code' })
  })
})

describe('LIFE-478 K7 — GUI 삭제 = CLI worktree rm (격리 레포 매트릭스)', () => {
  const exists = (target: string) => fs.existsSync(target)

  it('clean · 한가 → 삭제, CLI 로 만든 브랜치는 -d 로 지운다(Q3)', async () => {
    const f = await fixture()
    const a = await f.create('clean')
    const preview = await previewWorktreeDelete(f.deps, { path: a })
    expect(preview).toMatchObject({ ok: true, dirtyCount: 0, liveSessions: 0, locked: false, isMain: false, childPaths: [] })
    expect(await deleteWorktree(f.deps, { path: a, force: false })).toEqual({ ok: true, preservedBranch: null, warning: null })
    expect(exists(a)).toBe(false)
    expect(f.git('branch', '--list', 'clean')).toBe('')
    expect(f.registry.metadata()[a]).toBeUndefined()
  })

  it('dirty·untracked → 강제 없이 거절(디스크 그대로), 강제면 삭제', async () => {
    const f = await fixture()
    const a = await f.create('dirty')
    fs.writeFileSync(path.join(a, 'untracked.txt'), 'x')
    expect(await previewWorktreeDelete(f.deps, { path: a })).toMatchObject({ ok: true, dirtyCount: 1 })
    expect(await deleteWorktree(f.deps, { path: a, force: false })).toMatchObject({ ok: false, code: 'dirty_worktree' })
    expect(exists(path.join(a, 'untracked.txt'))).toBe(true)
    expect((await deleteWorktree(f.deps, { path: a, force: true })).ok).toBe(true)
    expect(exists(a)).toBe(false)
  })

  it('busy(살아 있는 세션) → 강제 없이 거절·세션 안 닫음, 강제면 세션을 닫고 삭제', async () => {
    const f = await fixture()
    const a = await f.create('busy')
    f.desktop.live.set(a, 2)
    expect(await previewWorktreeDelete(f.deps, { path: a })).toMatchObject({ ok: true, liveSessions: 2 })
    expect(await deleteWorktree(f.deps, { path: a, force: false })).toMatchObject({ ok: false, code: 'worktree_busy' })
    expect(f.desktop.closed).toEqual([])
    expect((await deleteWorktree(f.deps, { path: a, force: true })).ok).toBe(true)
    expect(f.desktop.closed).toEqual([a])
  })

  it('잠김 → 강제여도 효과 전에 거절(세션 닫기 없음·디스크 그대로)', async () => {
    const f = await fixture()
    const a = await f.create('locked')
    f.git('worktree', 'lock', a)
    expect(await previewWorktreeDelete(f.deps, { path: a })).toMatchObject({ ok: true, locked: true })
    expect(await deleteWorktree(f.deps, { path: a, force: true })).toMatchObject({ ok: false, code: 'locked_worktree' })
    expect(f.desktop.closed).toEqual([])
    expect(exists(a)).toBe(true)
    expect(f.git('worktree', 'list', '--porcelain')).toContain('locked')
  })

  it('herdr 링크 없음 → 바쁨을 못 보니 삭제하지 않는다(미리보기도 세션 수 없음 + 사유)', async () => {
    const f = await fixture()
    const a = await f.create('nolink')
    f.desktop.unavailable = true
    expect(await previewWorktreeDelete(f.deps, { path: a })).toMatchObject({ ok: true, liveSessions: null, backendError: 'Desktop backend is not connected' })
    expect(await deleteWorktree(f.deps, { path: a, force: true })).toMatchObject({ ok: false, code: 'backend_unavailable' })
    expect(exists(a)).toBe(true)
  })

  it('자식 있음 → 부모만 지우고 자식의 상위 링크가 풀린다', async () => {
    const f = await fixture()
    const parent = await f.create('parent')
    const child = await f.create('child')
    await setWorktreeMeta(f.deps, { path: child, parentPath: parent })
    expect(await previewWorktreeDelete(f.deps, { path: parent })).toMatchObject({ ok: true, childPaths: [child] })
    expect((await deleteWorktree(f.deps, { path: parent, force: false })).ok).toBe(true)
    expect(exists(child)).toBe(true)
    expect(f.registry.metadata()[child]?.parentWorktreeId).toBeNull()
  })

  it('git 으로 직접 만든(createdBranch 없음) 워크트리 → 브랜치는 남고 결과에 적힌다(Q3)', async () => {
    const f = await fixture()
    const target = path.join(f.root, 'outside')
    f.git('worktree', 'add', '-b', 'manual', target)
    await f.refresh()
    const real = fs.realpathSync(target)
    expect(await deleteWorktree(f.deps, { path: real, force: false })).toEqual({ ok: true, preservedBranch: 'manual', warning: null })
    expect(f.git('branch', '--list', 'manual')).toContain('manual')
  })

  it('주 체크아웃 → 런타임이 protected_worktree 로 거절', async () => {
    const f = await fixture()
    expect(await previewWorktreeDelete(f.deps, { path: f.repo })).toMatchObject({ ok: true, isMain: true })
    expect(await deleteWorktree(f.deps, { path: f.repo, force: true })).toMatchObject({ ok: false, code: 'protected_worktree' })
    expect(exists(f.repo)).toBe(true)
  })

  it('CLI rm 도 잠김을 효과 전에 거절한다(같은 경로)', async () => {
    const f = await fixture()
    const a = await f.create('cli-locked')
    f.git('worktree', 'lock', a)
    expect((await f.cli('worktree', 'rm', '--worktree', `path:${a}`, '--force')).error?.code).toBe('locked_worktree')
    expect(exists(a)).toBe(true)
  })
})

// LIFE-603 F3 — 「작업에서 시작」 이 workspace 줄을 에이전트 ready 까지 잡는 동안, 카드 메뉴 쓰기는 그 뒤에 서서 60초 뒤 거짓 오류를
// 내는 대신 보내지 않고 바로 이유를 돌려준다. 시작이 끝나면(바쁨 false) 지금 그대로다.
describe('LIFE-603 F3 — 시작 진행 중의 카드 메뉴 쓰기', () => {
  it('시작 진행 중이면 이름 바꾸기·삭제가 런타임에 닿지 않고 start_in_progress, 끝나면 평소대로', async () => {
    const f = await fixture()
    const a = await f.create('feat-a')
    let busy = true
    let invoked = 0
    const deps: CardActionDeps = { ...f.deps, startBusy: () => busy, invoke: () => { const real = f.deps.invoke(); return real === null ? null : (invocation) => { invoked += 1; return real(invocation) } } }
    const started = Date.now()
    expect(await setWorktreeMeta(deps, { path: a, displayName: '바쁨' })).toEqual({ ok: false, code: 'start_in_progress', error: '작업 시작이 진행 중입니다 — 끝난 뒤 다시 시도하세요.' })
    expect(await deleteWorktree(deps, { path: a, force: false })).toMatchObject({ ok: false, code: 'start_in_progress' })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(invoked).toBe(0)
    expect(f.registry.metadata()[a]?.displayName).toBeUndefined()
    busy = false
    expect(await setWorktreeMeta(deps, { path: a, displayName: '평소' })).toEqual({ ok: true })
    expect(invoked).toBe(1)
  })
})
