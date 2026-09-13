// M3 — worktree. L6(UI 로 열기) · L7(UI 로 만들기) · L8(빈 상태 회복).
//
// 오라클(관문 ⑤): 열림 상태는 herdr `worktree.list {cwd}` 의 `open_workspace_id`,
// 만들어졌는지는 `git worktree list` (파일시스템/깃) 로 교차 확인한다 — corral 출력이 아니다.
//
// 흐름을 사슬로: 레포 등록(빈 상태) → L8a(빈 상태에서 UI 만으로 행까지) → L7(+worktree 모달로
// 만들기) → L6(그 worktree 를 닫았다가 UI 열기 로 다시 열기) → L8b(마지막 workspace 닫아 0 으로
// 만든 뒤 UI 로 회복).

import { execFileSync } from 'node:child_process'
import { herdrRequest, makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

const app = await startApp({ name: 'm3-worktree' })
const out = { at: new Date().toISOString(), ready: app.ready, l6: {}, l7: {}, l8: {} }

async function worktreeOpenId(repoRoot, path) {
  const r = await herdrRequest('worktree.list', { cwd: repoRoot })
  const list = r.worktrees ?? r.worktree_list ?? []
  const hit = list.find((w) => w.path === path || w.worktree === path)
  return hit ? (hit.open_workspace_id ?? null) : undefined
}
function gitWorktrees(repoRoot) {
  const raw = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  const entries = []
  let cur = {}
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9) }
    else if (line.startsWith('branch ')) cur.branch = line.slice(7)
    else if (line.trim() === '') { if (cur.path) entries.push(cur); cur = {} }
  }
  if (cur.path) entries.push(cur)
  return entries
}
async function corralWorktrees(repoRoot) {
  const state = await app.state()
  const repo = state.repos.find((r) => r.root === repoRoot)
  return (repo?.worktrees ?? []).map((w) => ({ path: w.path, isLinked: w.isLinked, openWorkspaceId: w.openWorkspaceId }))
}
async function workspaceCount() {
  return (await herdrRequest('workspace.list', {})).workspaces.length
}
async function openPrimary(repoRoot) {
  await app.click(`[data-open-worktree="${repoRoot}"]`)
  const seen = await until(
    async () => {
      const wt = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repoRoot)
      return wt?.workspace?.workspaceId ?? null
    },
    { what: 'primary ws', timeoutMs: 15000 },
  )
  return seen.value
}

try {
  const repo = makeScratchRepo('m3')
  out.repo = repo.root
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { what: 'repo row' })

  // ---------- L8a: 빈 상태(workspace 0)에서 UI 만으로 행까지 ----------
  {
    const startCount = await workspaceCount()
    // 주 체크아웃은 닫힌 채로 보인다 — 열기 버튼이 있어야 한다
    const openBtn = (await app.query(`[data-open-worktree="${repo.root}"]`)).found.length > 0
    const workspaceId = await openPrimary(repo.root)
    const afterOpen = await workspaceCount()
    // 새 행(shell) — 좌표 클릭
    const before = (await herdrRequest('pane.list', {})).panes.filter((p) => p.workspace_id === workspaceId).length
    await app.click(`[data-create-row="${workspaceId}"][data-kind="shell"]`)
    const rowUp = await until(
      async () => {
        const n = (await herdrRequest('pane.list', {})).panes.filter((p) => p.workspace_id === workspaceId).length
        return n > before ? n : null
      },
      { what: 'row created', timeoutMs: 15000 },
    )
    out.l8.a = { startWorkspaceCount: startCount, openButtonPresent: openBtn, afterOpenCount: afterOpen, workspaceId, rowCreated: rowUp.ok, uiOnly: true }
    console.log(`[L8a] start=${startCount} openBtn=${openBtn} afterOpen=${afterOpen} rowCreated=${rowUp.ok}`)
  }

  const primaryWs = (await corralWorktrees(repo.root)).find((w) => w.path === repo.root)?.openWorkspaceId
    ?? (await openPrimary(repo.root))

  // ---------- L7: +worktree 모달로 만들기 ----------
  let linkedPath = null
  let linkedBranch = 'l356-l7'
  {
    await app.click(`[data-create-worktree="${repo.root}"]`)
    await until(async () => ((await app.query('[data-create-worktree-modal]')).found.length > 0 ? true : null), { what: 'worktree modal', timeoutMs: 6000 })
    // branch 입력칸에 좌표 클릭 후 타이핑 (경로는 자동 파생)
    await app.click('[data-worktree-branch-input]')
    await app.type(linkedBranch)
    await sleep(200)
    const derivedPath = (await app.query('[data-worktree-path-input]')).found[0]
    linkedPath = derivedPath
    const submit = await app.click('[data-worktree-create-submit]')
    // 모달이 닫힐 때까지 (성공) — 아니면 note 를 읽는다
    const done = await until(async () => ((await app.query('[data-create-worktree-modal]')).found.length === 0 ? true : null), { what: 'modal closed', timeoutMs: 20000, everyMs: 150 })
    const note = (await app.query('[data-worktree-create-note]')).found
    await sleep(600)
    // 수정 1회차 L-4: path 매치에 branch 검증이 가려지지 않게 **AND** 로 — 둘 다 확인
    const gwt = gitWorktrees(repo.root)
    const inGitPath = gwt.some((w) => w.path === linkedPath)
    const inGitBranch = gwt.some((w) => w.branch?.endsWith(`/${linkedBranch}`) || w.branch === linkedBranch)
    const inGit = inGitPath && inGitBranch
    const inCorral = (await corralWorktrees(repo.root)).some((w) => w.path === linkedPath)
    const openId = await worktreeOpenId(repo.root, linkedPath)
    out.l7 = { branch: linkedBranch, derivedPath, submitHit: submit.hit, modalClosed: done.ok, note, inGit, inGitPath, inGitBranch, inCorral, openWorkspaceIdAfterCreate: openId }
    console.log(`[L7] path=${linkedPath} inGit=${inGit}(path=${inGitPath} branch=${inGitBranch}) inCorral=${inCorral} openId=${openId}`)
  }

  // ---------- L6: 그 worktree 를 닫았다가 UI 열기 로 다시 열기 ----------
  {
    const openIdBefore = await worktreeOpenId(repo.root, linkedPath)
    // 닫는다 (하네스: linked 멤버만 닫기 — 게이트 없이 herdr 로 직접)
    if (openIdBefore) await herdrRequest('workspace.close', { workspace_id: openIdBefore }).catch(() => {})
    const closed = await until(async () => ((await worktreeOpenId(repo.root, linkedPath)) === null ? true : null), { what: 'worktree closed', timeoutMs: 12000 })
    // corral 이 닫힘으로 보이고 열기 버튼이 있나 (수정 1회차 L-2: 하드코딩 아닌 실측값)
    const openButton = await until(async () => ((await app.query(`[data-open-worktree="${linkedPath}"]`)).found.length > 0 ? true : null), { what: 'open button', timeoutMs: 12000, everyMs: 150 })
    const chipClosed = (await app.query(`[data-chip-worktree="${linkedPath}"]`)).found.length > 0
    // UI 열기 (좌표 클릭) — worktree.open 경로
    const openClick = await app.click(`[data-open-worktree="${linkedPath}"]`)
    const reopened = await until(async () => {
      const id = await worktreeOpenId(repo.root, linkedPath)
      return id ? id : null
    }, { what: 'reopened (open_workspace_id set)', timeoutMs: 15000, everyMs: 150 })
    const reopenedWs = reopened.value ?? null
    // 수정 1회차 M6 (통과선 꼬리): worktree.open 으로 연 그 workspace 에 **행 생성까지** UI 로 이어진다.
    let rowCreatedInReopened = false
    let reopenedRowPaneId = null
    if (reopenedWs) {
      const before = (await herdrRequest('pane.list', {})).panes.filter((p) => p.workspace_id === reopenedWs).length
      const createClick = await app.click(`[data-create-row="${reopenedWs}"][data-kind="shell"]`)
      const rowUp = await until(async () => {
        const panes = (await herdrRequest('pane.list', {})).panes.filter((p) => p.workspace_id === reopenedWs)
        return panes.length > before ? panes[panes.length - 1] : null
      }, { what: 'row in reopened ws', timeoutMs: 15000 })
      rowCreatedInReopened = rowUp.ok && createClick.hit
      reopenedRowPaneId = rowUp.value?.pane_id ?? null
    }
    out.l6 = {
      linkedPath,
      openIdBeforeClose: openIdBefore,
      closedOk: closed.ok,
      openButtonAfterClose: openButton.ok,
      chipPresent: chipClosed,
      openClickHit: openClick.hit,
      reopenedWorkspaceId: reopenedWs,
      reopenedViaUI: reopened.ok,
      rowCreatedInReopened, // ← M6 통과선 꼬리
      reopenedRowPaneId,
    }
    console.log(`[L6] closed=${closed.ok} reopened=${reopened.ok} newId=${reopenedWs} rowInReopened=${rowCreatedInReopened}`)
  }

  // ---------- L8b: 마지막 workspace 닫아 0 으로 → UI 회복 ----------
  {
    // 열린 workspace 전부 UI 로 닫는다 (linked 먼저, primary 나중 — L9 회피: 각자 게이트만)
    // 하네스 정리로 herdr 직접 닫되, "0 상태에서 UI 로 회복" 이 측정 대상이다.
    for (const w of (await herdrRequest('workspace.list', {})).workspaces) {
      await herdrRequest('workspace.close', { workspace_id: w.workspace_id, close_group: true }).catch(() => {})
    }
    const zero = await until(async () => ((await workspaceCount()) === 0 ? true : null), { what: '0 workspaces', timeoutMs: 12000 })
    await sleep(800)
    // corral 이 primary 를 닫힘으로 보이고 열기 버튼을 준다 (UI 만으로 회복 가능)
    const openBtn = await until(async () => ((await app.query(`[data-open-worktree="${repo.root}"]`)).found.length > 0 ? true : null), { what: 'open button after 0', timeoutMs: 12000, everyMs: 150 })
    const workspaceId = await openPrimary(repo.root)
    const recovered = await workspaceCount()
    // 행까지 UI 로
    const before = (await herdrRequest('pane.list', {})).panes.filter((p) => p.workspace_id === workspaceId).length
    await app.click(`[data-create-row="${workspaceId}"][data-kind="shell"]`)
    const rowUp = await until(async () => {
      const n = (await herdrRequest('pane.list', {})).panes.filter((p) => p.workspace_id === workspaceId).length
      return n > before ? n : null
    }, { what: 'row after recover', timeoutMs: 15000 })
    out.l8.b = { reachedZero: zero.ok, openButtonAfterZero: openBtn.ok, recoveredCount: recovered, workspaceId, rowCreated: rowUp.ok }
    console.log(`[L8b] zero=${zero.ok} openBtn=${openBtn.ok} recovered=${recovered} row=${rowUp.ok}`)
  }

  out.summary = {
    l6ReopenedViaUI: out.l6.reopenedViaUI,
    l6RowCreatedInReopened: out.l6.rowCreatedInReopened, // ← M6 통과선 꼬리
    l7CreatedInGit: out.l7.inGit,
    l7CreatedInCorral: out.l7.inCorral,
    l8aRecovered: out.l8.a.rowCreated && out.l8.a.openButtonPresent,
    l8bRecovered: out.l8.b.reachedZero && out.l8.b.openButtonAfterZero && out.l8.b.rowCreated,
  }
  out.verdict =
    out.l6.reopenedViaUI &&
    out.l6.rowCreatedInReopened &&
    out.l7.inGit &&
    out.l7.inCorral &&
    out.summary.l8aRecovered &&
    out.summary.l8bRecovered
      ? 'PASS'
      : 'FAIL'

  for (const w of (await herdrRequest('workspace.list', {})).workspaces) {
    await herdrRequest('workspace.close', { workspace_id: w.workspace_id, close_group: true }).catch(() => {})
  }
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}

out.rawChain = app.rawChain() // 수정 1회차 M4: _runs/app.ndjson sha256 사슬
out.clickEvidence = app.clickLog() // 수정 1회차 M3: 통과선 클릭 좌표·target
writeRaw('m3-worktree.json', out)
console.log('\nM3:', out.verdict, JSON.stringify(out.summary))
if (out.verdict !== 'PASS') process.exitCode = 1
