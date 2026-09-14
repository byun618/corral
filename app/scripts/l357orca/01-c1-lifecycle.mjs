// C1 — 라이프사이클 무결성. 좌표 클릭만으로: 레포 추가(ReposSectionHeader + → AddRepoModal →
// browse-stub) · worktree 생성(RepoRow + → CreateWorktreeModal) · worktree 선택(WorktreeBlock
// 클릭) · 세션 생성/닫기(이미 00-smoke·06-c8 로 실증) · 레포 제거(⋯메뉴 → RemoveRepoConfirm) ·
// pane 선택→터미널 표시. 전부 1회 이상 성공, 실패 0 을 목표로 한다.
import { makeScratchRepo, startApp, until, writeRaw } from './lib.mjs'

async function main() {
  const repo = makeScratchRepo('c1-lifecycle')
  const app = await startApp({ name: '01-c1-lifecycle' })
  const out = {}

  // ---------- 레포 추가 — UI 클릭 전체 경로(browseForRepos IPC 를 직접 부르지 않는다) ----------
  await app.send({ cmd: 'browse-stub', path: repo.root })
  const addClick = await app.click('[data-add-repo]')
  await until(async () => (await app.query('[data-add-repo-modal]')).found.length > 0, { timeoutMs: 5000, what: 'add-repo modal open' })
  const browseClick = await app.click('[data-browse-folder]')
  const repoAppeared = await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 8000,
    what: 'repo row mounted via UI add',
  })
  out.addRepo = { addClickHit: addClick.hit, browseClickHit: browseClick.hit, repoAppeared: repoAppeared.ok, pass: addClick.hit && browseClick.hit && repoAppeared.ok }
  console.log('[addRepo]', out.addRepo)

  // ---------- worktree 생성 — RepoRow hover 액션 + 텍스트 입력(OS 다이얼로그 아님, L7) ----------
  const createWtClick = await app.click(`[data-create-worktree="${repo.root}"]`)
  await until(async () => (await app.query('[data-create-worktree-modal]')).found.length > 0, { timeoutMs: 5000, what: 'create-worktree modal open' })
  await app.click('[data-worktree-branch-input]')
  await app.type('feature/c1-check')
  const submitClick = await app.click('[data-worktree-create-submit]')
  const worktreeAppeared = await until(
    async () => {
      const s = await app.state()
      return s.repos.flatMap((r) => r.worktrees).some((w) => w.branch === 'feature/c1-check')
    },
    { timeoutMs: 10000, what: 'new worktree row appeared' },
  )
  out.createWorktree = {
    createClickHit: createWtClick.hit,
    submitClickHit: submitClick.hit,
    worktreeAppeared: worktreeAppeared.ok,
    pass: createWtClick.hit && submitClick.hit && worktreeAppeared.ok,
  }
  console.log('[createWorktree]', out.createWorktree)

  // ---------- worktree 선택(WorktreeBlock 클릭) — 열린 뒤 pane 선택 → 터미널 표시 ----------
  const mainWtPath = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => !w.isLinked).path
  const openClick = await app.click(`[data-worktree="${mainWtPath}"]`)
  const opened = await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === mainWtPath)?.workspace !== null,
    { timeoutMs: 8000, what: 'worktree opened via click' },
  )
  const termPaneVisible = await until(async () => (await app.query('[data-term-pane]')).found.length > 0, {
    timeoutMs: 8000,
    what: 'terminal pane rendered after open+auto pane select',
  })
  out.selectWorktreeAndPane = { openClickHit: openClick.hit, opened: opened.ok, termPaneVisible: termPaneVisible.ok, pass: openClick.hit && opened.ok && termPaneVisible.ok }
  console.log('[selectWorktreeAndPane]', out.selectWorktreeAndPane)

  // ---------- 세션 생성 (+ 이미 00-smoke.mjs 로 실증됐지만 여기서도 1 회 재확인) ----------
  const workspaceId = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === mainWtPath).workspace.workspaceId
  const beforeTabs = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === mainWtPath).workspace.tabs.length
  const createRowClick = await app.click(`[data-create-row="${workspaceId}"][data-kind="shell"]`)
  const tabCreated = await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === mainWtPath).workspace.tabs.length > beforeTabs,
    { timeoutMs: 10000, what: 'new tab created' },
  )
  out.createSession = { createRowClickHit: createRowClick.hit, tabCreated: tabCreated.ok, pass: createRowClick.hit && tabCreated.ok }
  console.log('[createSession]', out.createSession)

  // ---------- 세션 닫기 (셸 전용 — 모달 없이 즉시, C8/L3 와 동일 메커니즘 재확인) ----------
  const newTab = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === mainWtPath).workspace.tabs.slice(-1)[0]
  const closeClick = await app.click(`[data-close-tab="${newTab.tabId}"]`)
  const tabClosed = await until(
    async () => !(await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === mainWtPath).workspace.tabs.some((t) => t.tabId === newTab.tabId),
    { timeoutMs: 10000, what: 'tab closed' },
  )
  out.closeSession = { closeClickHit: closeClick.hit, tabClosed: tabClosed.ok, pass: closeClick.hit && tabClosed.ok }
  console.log('[closeSession]', out.closeSession)

  // ---------- 레포 제거 — ⋯메뉴 → RemoveRepoConfirm → 확인 ----------
  const menuToggleClick = await app.click(`[data-repo-menu-toggle="${repo.root}"]`)
  await until(async () => (await app.query(`[data-repo-menu="${repo.root}"]`)).found.length > 0, { timeoutMs: 5000, what: 'repo menu open' })
  const removeMenuClick = await app.click(`[data-repo-menu-remove="${repo.root}"]`)
  await until(async () => (await app.query(`[data-confirm-remove="${repo.root}"]`)).found.length > 0, { timeoutMs: 5000, what: 'remove confirm modal open' })
  const confirmOkClick = await app.click('[data-confirm-ok]')
  const repoGone = await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length === 0, { timeoutMs: 8000, what: 'repo row removed' })
  out.removeRepo = {
    menuToggleClickHit: menuToggleClick.hit,
    removeMenuClickHit: removeMenuClick.hit,
    confirmOkClickHit: confirmOkClick.hit,
    repoGone: repoGone.ok,
    pass: menuToggleClick.hit && removeMenuClick.hit && confirmOkClick.hit && repoGone.ok,
  }
  console.log('[removeRepo]', out.removeRepo)

  await app.stop()

  out.allPass = Object.values(out).every((v) => v.pass === true)
  console.log('C1 allPass:', out.allPass)
  writeRaw('c1-lifecycle.json', out)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
