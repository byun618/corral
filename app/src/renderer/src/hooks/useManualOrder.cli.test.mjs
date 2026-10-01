// LIFE-469 수정 라운드 3 (R3-01) — GUI 제거 뒤 **CLI** `repo add` 재등록이 대기 키를 푸는가.
// 실제 `RepoRegistry`(임시 파일)·실제 `workspaceModule.execute('repo add')`·main 이 쓰는 실제 `RegistryGeneration` 을
// 실제 git 저장소로 돌리고, 그 결과를 main `currentState` 와 같은 모양(`registry.state().roots` + 같은 읽기의 세대)으로
// 실제 hook 에 넘긴다. React 스케줄과 트리 스냅샷 전달(80ms 합침으로 「B 없는 트리」가 빠지는 것)만 가짜다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', () => import('./fake-react.test-helper.mjs'))

const { HookHost } = await import('./fake-react.test-helper.mjs')
const { useManualOrder } = await import('./useManualOrder.js')
const { orderRepos, orderWorktrees } = await import('../manual-order.js')
const { RepoRegistry } = await import('../../../main/registry.js')
const { RegistryGeneration } = await import('../../../main/registry-generation.js')
const { workspaceModule } = await import('../../../runtime/workspace/index.js')
const { CommandRegistry } = await import('../../../runtime/registry.js')

const cleanups = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=l469', '-c', 'user.email=l469@example.invalid', ...args], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  return fs.realpathSync(dir)
}

/** main 쪽 — 같은 레지스트리 파일을 GUI(main `addRepo`·`removeRepo`)와 runtime CLI(`workspaceModule`)가 따로 고친다. */
function world() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l469r3-'))
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const data = path.join(tmp, 'data')
  fs.mkdirSync(data)
  vi.stubEnv('CORRAL_REGISTRY', path.join(data, 'repos.json'))
  const roots = Object.fromEntries(['a', 'b', 'c', 'd'].map((name) => [name, gitRepo(path.join(tmp, name))]))
  const mainRegistry = new RepoRegistry(data)
  const generation = new RegistryGeneration()
  const parser = new CommandRegistry()
  const cli = workspaceModule(data, { changed: async () => {}, observe: async () => [], activate: async () => ({ parentOpened: false }), close: async () => {} })
  parser.register(cli)
  const ctx = { runtimeId: 'l469', instanceId: 'l469', userData: data, signal: new globalThis.AbortController().signal, remote: false, deadlineAt: Date.now() + 60_000 }
  return {
    roots,
    /** main `currentState` 와 같다 — 등록 목록과 세대를 같은 읽기에서. */
    state() {
      const registryState = mainRegistry.state()
      return { roots: registryState.roots, generation: generation.observe(registryState.roots) }
    },
    guiAdd(root) {
      expect(mainRegistry.add(root).ok).toBe(true)
    },
    /** main `removeRepo` 와 같다 — 제거 직후 관측한 세대를 응답에 싣는다. */
    guiRemove(root) {
      expect(mainRegistry.remove(root).ok).toBe(true)
      return generation.observe(mainRegistry.list())
    },
    async cliAdd(root) {
      const inv = parser.parse(['repo', 'add', '--path', root], tmp)
      cli.validate(inv)
      const result = await cli.execute(inv, ctx)
      expect(result.repo.path).toBe(root)
    },
  }
}

const worktree = (p, isLinked) => ({ path: p, branch: p.split('/').at(-1), isLinked, openWorkspaceId: null, workspace: null })

function renderer(w) {
  vi.stubGlobal('window', { corral: { setUiPrefs: () => {} } })
  const host = new HookHost()
  const linked = {}
  let repos = []
  let registry = w.state()
  const render = () => host.render(() => useManualOrder({ repos, registry }))
  return {
    linked,
    render,
    emit() {
      registry = w.state()
      return render()
    },
    tree(roots) {
      repos = roots.map((root) => ({ root, name: root, error: null, worktrees: [worktree(root, false), ...(linked[root] ?? []).map((p) => worktree(p, true))] }))
      return render()
    },
    visible(api) {
      return orderRepos({ repos, stored: api.order.repos }).map((row) => row.root)
    },
    cards(api, root) {
      const row = repos.find((item) => item.root === root)
      return orderWorktrees({ worktrees: row.worktrees, stored: api.order.worktrees[root] }).map((item) => item.path)
    },
  }
}

describe('R3-01 — GUI 제거 → CLI repo add 재등록(B 없는 트리 없이) → CLI D 추가 → B 새 워크트리', () => {
  async function scenario({ readdBy, deliverAbsentTree }) {
    const w = world()
    const { a, b, c, d } = w.roots
    for (const root of [a, b, c]) w.guiAdd(root)
    const r = renderer(w)
    r.linked[b] = [`${b}-wt/alpha`]
    let api = r.tree([a, b, c])
    api.hydrate({ manualRepoOrder: [b, a, c], manualWorktreeOrder: { [a]: [], [b]: [`${b}-wt/alpha`], [c]: [] } })
    api = r.render()
    api = r.emit()
    // GUI 제거 — 응답 세대를 들고 forget. 트리는 아직 B 를 담는다.
    api.forget({ root: b, registryGeneration: w.guiRemove(b) })
    api = r.render()
    api = r.emit()
    if (deliverAbsentTree) api = r.tree([a, c])
    // 재등록 — B 없는 트리는 main 의 80ms 합침·세대 버림으로 오지 않았다.
    if (readdBy === 'cli') await w.cliAdd(b)
    else w.guiAdd(b)
    api = r.emit()
    api = r.tree([a, b, c])
    await w.cliAdd(d)
    api = r.emit()
    api = r.tree([a, b, c, d])
    const visible = r.visible(api)
    const stored = api.order.repos
    r.linked[b] = [`${b}-wt/alpha`, `${b}-wt/zulu`]
    api = r.tree([a, b, c, d])
    return { want: [a, c, b, d], visible, stored, cards: r.cards(api, b), wantCards: [b, `${b}-wt/zulu`, `${b}-wt/alpha`] }
  }

  it('실제 workspaceModule repo add 경로 = [A,C,B,D] · B 카드 [main, zulu, alpha] (리뷰 r3 부록 C 재현)', async () => {
    const got = await scenario({ readdBy: 'cli', deliverAbsentTree: false })
    expect(got.visible).toEqual(got.want)
    expect(got.stored).toEqual(got.want)
    expect(got.cards).toEqual(got.wantCards)
  })

  it('GUI 재등록 경로도 같다', async () => {
    const got = await scenario({ readdBy: 'gui', deliverAbsentTree: false })
    expect(got.visible).toEqual(got.want)
    expect(got.cards).toEqual(got.wantCards)
  })

  it('양성 대조 — B 없는 트리를 한 번 받은 CLI 경로도 같다', async () => {
    const got = await scenario({ readdBy: 'cli', deliverAbsentTree: true })
    expect(got.visible).toEqual(got.want)
    expect(got.cards).toEqual(got.wantCards)
  })

  it('제거 직후 옛 상태(제거 전 목록·세대)를 다시 받아도 대기는 유지 — R1-04 가 다시 열리지 않는다', async () => {
    const w = world()
    const { a, b, c } = w.roots
    for (const root of [a, b, c]) w.guiAdd(root)
    const r = renderer(w)
    let api = r.tree([a, b, c])
    api.hydrate({ manualRepoOrder: [b, a, c], manualWorktreeOrder: {} })
    api = r.render()
    api = r.emit()
    // 렌더러가 마지막으로 받은 상태는 제거 전 것(B 등록·옛 세대) 그대로 두고 forget.
    api.forget({ root: b, registryGeneration: w.guiRemove(b) })
    api = r.render()
    expect(api.order.repos).toEqual([a, c])
    // CLI 로 다른 레포만 추가 — 세대는 오르지만 B 는 목록에 없다.
    await w.cliAdd(w.roots.d)
    api = r.emit()
    // 옛 트리(B 포함)가 아직 화면에 있다.
    api = r.tree([a, b, c, w.roots.d])
    expect(api.order.repos).toEqual([a, c, w.roots.d])
  })
})
