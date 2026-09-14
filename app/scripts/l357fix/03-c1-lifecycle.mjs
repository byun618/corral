// C1 — 라이프사이클 무결성 (게이트 ① 수정 라운드 재실행, 09-gate1-fix.md G).
//
// 이전 회차와 달라진 것: **세션 닫기는 에이전트 탭으로 잰다.** 사이드바 SessionRow 가 이제
// 에이전트 세션만 그리므로(09-gate1-fix.md D), 셸 탭으로는 `[data-close-tab]` 이 애초에
// DOM 에 없어 "닫기 진입점이 있다"를 증명할 수 없다. 탭바 쪽 닫기(`[data-main-tab-close]`)도
// 같은 실행에서 함께 잰다 — 두 진입점이 갈렸으니 둘 다 살아 있는지 봐야 한다.
//
// 원문 의도 그대로: 좌표 클릭만으로: 레포 추가(ReposSectionHeader + → AddRepoModal →
// browse-stub) · worktree 생성(RepoRow + → CreateWorktreeModal) · worktree 선택(WorktreeBlock
// 클릭) · 세션 생성/닫기(이미 00-smoke·06-c8 로 실증) · 레포 제거(⋯메뉴 → RemoveRepoConfirm) ·
// pane 선택→터미널 표시. 전부 1회 이상 성공, 실패 0 을 목표로 한다.
import { agentTabsOf, createTab, makeScratchRepo, startApp, tabsOf, until, writeRaw } from './lib.mjs'

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

  // ---------- 세션 생성 — 셸 1개(탭바 몫) + 에이전트 1개(사이드바 몫) ----------
  const workspaceId = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === mainWtPath).workspace.workspaceId
  const beforeTabs = (await tabsOf(app, mainWtPath)).length
  const createRowClick = await app.click(`[data-create-row="${workspaceId}"][data-kind="shell"]`)
  const tabCreated = await until(async () => (await tabsOf(app, mainWtPath)).length > beforeTabs, { timeoutMs: 10000, what: 'new shell tab created' })

  const beforeAgents = agentTabsOf(await tabsOf(app, mainWtPath)).length
  const createAgentClick = await createTab(app, mainWtPath, 'claude')
  const agentTabCreated = await until(async () => agentTabsOf(await tabsOf(app, mainWtPath)).length > beforeAgents, {
    timeoutMs: 20000,
    everyMs: 200,
    what: 'new agent tab created',
  })
  out.createSession = {
    createRowClickHit: createRowClick.hit,
    tabCreated: tabCreated.ok,
    createAgentClickHit: createAgentClick.hit,
    agentTabCreated: agentTabCreated.ok,
    pass: createRowClick.hit && tabCreated.ok && createAgentClick.hit && agentTabCreated.ok,
  }
  console.log('[createSession]', out.createSession)

  // ---------- 세션 닫기 ① 사이드바 SessionRow(에이전트 탭만 존재한다) ----------
  const agentTab = agentTabsOf(await tabsOf(app, mainWtPath)).slice(-1)[0]
  const sidebarRowPresent = (await app.query(`[data-tab="${agentTab.tabId}"]`)).found.length > 0
  const closeClick = await app.click(`[data-close-tab="${agentTab.tabId}"]`)
  // 살아 있는 에이전트라 herdr `process_info` 가 "잃을 게 있다"고 답한다 → 확인 게이트(L4).
  // 이건 회귀가 아니라 **기대 동작**이다 — 모달이 떴는지까지 증거로 남기고 확인을 누른다.
  const confirmShown = await until(async () => (await app.query('[data-confirm-close-modal]')).found.length > 0, {
    timeoutMs: 6000,
    what: 'close-confirm gate (L4) shown for live agent',
  })
  const confirmOk = confirmShown.ok ? await app.click('[data-close-confirm-ok]') : { hit: null }
  const tabClosed = await until(async () => !(await tabsOf(app, mainWtPath)).some((t) => t.tabId === agentTab.tabId), {
    timeoutMs: 15000,
    what: 'agent tab closed via sidebar SessionRow',
  })
  out.closeSessionViaSidebar = {
    targetTabId: agentTab.tabId,
    isAgentTab: true,
    sidebarRowPresent,
    closeClickHit: closeClick.hit,
    confirmGateShown: confirmShown.ok,
    confirmOkClickHit: confirmOk.hit,
    tabClosed: tabClosed.ok,
    pass: sidebarRowPresent && closeClick.hit && tabClosed.ok,
  }
  console.log('[closeSessionViaSidebar]', out.closeSessionViaSidebar)

  // ---------- 세션 닫기 ② 메인 탭바(셸 탭 — 사이드바에는 애초에 없다) ----------
  const tabsNow = await tabsOf(app, mainWtPath)
  const shellTab = tabsNow.filter((t) => !t.panes.some((p) => p.agent !== null)).slice(-1)[0]
  const shellRowAbsentInSidebar = (await app.query(`[data-tab="${shellTab.tabId}"]`)).found.length === 0
  const tabbarCloseClick = await app.click(`[data-main-tab-close="${shellTab.tabId}"]`)
  const shellClosed = await until(async () => !(await tabsOf(app, mainWtPath)).some((t) => t.tabId === shellTab.tabId), {
    timeoutMs: 15000,
    what: 'shell tab closed via MainTabBar',
  })
  out.closeSessionViaTabBar = {
    targetTabId: shellTab.tabId,
    isAgentTab: false,
    // D 의 부수 증거 — 셸 탭은 사이드바에 행이 없다(그래서 탭바 진입점이 필요하다).
    shellRowAbsentInSidebar,
    closeClickHit: tabbarCloseClick.hit,
    tabClosed: shellClosed.ok,
    pass: shellRowAbsentInSidebar && tabbarCloseClick.hit && shellClosed.ok,
  }
  console.log('[closeSessionViaTabBar]', out.closeSessionViaTabBar)

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
