// C3 — 접기/펼치기 (게이트 ① 수정 라운드 재실행, 09-gate1-fix.md G).
//
// 재실행 사유 + 달라진 것: 사이드바가 **에이전트 세션만** 그리게 되어(D) 행 수가 바뀌었고,
// C3ⓑ 의 `AgentGroupHeader` 임계값도 01-criteria.md 부록 "세션 용어 확정" 대로 **에이전트
// 세션 3개 이상**에 걸린다. fixture 를 셸 탭 3개가 아니라 **에이전트 탭 3개 + 셸 탭 2개**로
// 짠다 — 셸 탭을 섞어야 "그룹 임계값이 에이전트 수로 걸린다"가 실제로 증명된다(셸만 늘려도
// 그룹이 안 생기는지까지 본다).
//
// 원문 의도 그대로: 수정 1회차(07-fix-orca1.md M-1) 전면 재작성: 1차 구현은 ⓐ레포 collapse
// 한 방향만 쟀다(expand·ⓑAgentGroupHeader 는 원자료 0건, codex M1·grok 동조로 보류 판정).
// 이번엔 세션 3개 이상 worktree fixture 로 ⓐ레포·ⓑ그룹 **양방향**(collapse→expand) 각 1회 이상,
// 접힌 자식의 DOM 미존재 확인, 재기동 후 ⓐⓑ 상태 유지까지 좌표 클릭(관문④)으로 원자료에 남긴다.
import fs from 'node:fs'
import path from 'node:path'
import { agentTabsOf, buildMixedFixture, createTab, makeScratchRepo, RAW_DIR, RAW_SUBDIR, startApp, tabsOf, until, writeRaw } from './lib.mjs'

const uiPrefsFile = path.join(RAW_DIR, RAW_SUBDIR, '_runs', '03-c3-collapse-ui-prefs.json')

async function tabCountVia(app, workspaceId) {
  const s = await app.state()
  return s.repos.flatMap((r) => r.worktrees).find((w) => w.workspace?.workspaceId === workspaceId)?.workspace?.tabs.length ?? 0
}

async function ensureOpen(app, repoRoot) {
  const already = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repoRoot)?.workspace !== null
  if (already) return
  await app.click(`[data-worktree="${repoRoot}"]`)
  await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repoRoot)?.workspace !== null, {
    timeoutMs: 8000,
    what: 'worktree opened',
  })
}

async function main() {
  fs.mkdirSync(path.dirname(uiPrefsFile), { recursive: true })
  fs.rmSync(uiPrefsFile, { force: true })

  const repo = makeScratchRepo('c3-collapse')
  const app = await startApp({ name: '03-c3-collapse', env: { CORRAL_UI_PREFS: uiPrefsFile } })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { timeoutMs: 8000, what: 'repo row mounted' })
  await ensureOpen(app, repo.root)
  const workspaceId = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root).workspace.workspaceId

  // ---------- 음성 대조: 셸 탭만 늘려서는 그룹 헤더가 안 생긴다 ----------
  // worktree 를 열면 herdr 가 기본 셸 탭 1개를 준다. 여기에 셸 2개를 더해 **탭 3개**를 만든다 —
  // 옛 기준(전체 탭 3개)이었다면 여기서 그룹이 떠야 하고, 새 기준(에이전트 3개)이면 안 떠야 한다.
  for (let i = 0; i < 2; i++) {
    await createTab(app, repo.root, 'shell')
    await until(async () => (await tabCountVia(app, workspaceId)) >= i + 2, { timeoutMs: 10000, what: `shell tab ${i + 2}` })
  }
  const shellOnlyTabs = await tabsOf(app, repo.root)
  const groupAbsentWithShellsOnly = (await app.query(`[data-agent-group="${repo.root}"]`)).found.length === 0
  const negativeControl = {
    totalTabs: shellOnlyTabs.length,
    agentTabs: agentTabsOf(shellOnlyTabs).length,
    sessionRowsInSidebar: (await app.query('[data-tab]')).found.length,
    groupHeaderPresent: !groupAbsentWithShellsOnly,
    pass: shellOnlyTabs.length >= 3 && agentTabsOf(shellOnlyTabs).length === 0 && groupAbsentWithShellsOnly,
    note: '탭 3개(전부 셸) 상태에서 AgentGroupHeader 가 없어야 한다 — 임계값이 전체 탭이 아니라 에이전트 세션으로 걸린다는 증거(01-criteria.md 부록).',
  }
  console.log('negativeControl (shell-only)', negativeControl)

  // ---------- 혼합 fixture: 에이전트 3 + 셸 3(기본 1 + 추가 2) ----------
  const fixture = await buildMixedFixture(app, repo.root, { agents: 3, shells: 3 })
  console.log('fixture', { tabCount: fixture.tabCount, agentTabCount: fixture.agentTabCount, shellTabCount: fixture.shellTabCount })
  const tabCountBefore = fixture.agentTabCount // 사이드바가 그리는 행 수 = 에이전트 세션 수

  // ---------- ⓐ 레포 collapse → expand (양방향) ----------
  const repoCollapseClick = await app.click(`[data-repo-toggle="${repo.root}"]`)
  const repoCollapsed = await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length === 0, {
    timeoutMs: 4000,
    what: 'ⓐ repo collapsed — worktree hidden',
  })
  const caretCollapsed = await app.query(`[data-repo-caret="${repo.root}"]`)
  const repoExpandClick = await app.click(`[data-repo-toggle="${repo.root}"]`)
  const repoExpanded = await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 4000,
    what: 'ⓐ repo expanded — worktree visible again',
  })
  const caretExpanded = await app.query(`[data-repo-caret="${repo.root}"]`)

  // ---------- ⓑ AgentGroupHeader collapse → expand (양방향) — 그룹 헤더는 남고 세션 행만 사라진다 ----------
  const groupPresent = await until(async () => (await app.query(`[data-agent-group="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 4000,
    what: 'AgentGroupHeader mounted (tabCount>=3)',
  })
  const tabRowsBefore = (await app.query('[data-tab]')).found.length
  const groupCollapseClick = await app.click(`[data-agent-group="${repo.root}"]`)
  const groupCollapsed = await until(async () => (await app.query('[data-tab]')).found.length === 0, {
    timeoutMs: 4000,
    what: 'ⓑ group collapsed — session rows hidden',
  })
  const headerStillThereWhileCollapsed = (await app.query(`[data-agent-group="${repo.root}"]`)).found.length > 0
  const groupExpandClick = await app.click(`[data-agent-group="${repo.root}"]`)
  const groupExpanded = await until(async () => (await app.query('[data-tab]')).found.length === tabRowsBefore, {
    timeoutMs: 4000,
    what: 'ⓑ group expanded — session rows visible again',
  })

  const phase1 = {
    negativeControl,
    fixture,
    sidebarSessionRowCount: tabCountBefore,
    repo: {
      collapseClickHit: repoCollapseClick.hit,
      collapsed: repoCollapsed.ok,
      caretWhileCollapsed: caretCollapsed.found[0] ?? null,
      expandClickHit: repoExpandClick.hit,
      expanded: repoExpanded.ok,
      caretWhileExpanded: caretExpanded.found[0] ?? null,
    },
    group: {
      mounted: groupPresent.ok,
      tabRowsBefore,
      collapseClickHit: groupCollapseClick.hit,
      collapsed: groupCollapsed.ok,
      headerStillThereWhileCollapsed,
      expandClickHit: groupExpandClick.hit,
      expanded: groupExpanded.ok,
    },
    pass:
      negativeControl.pass &&
      repoCollapseClick.hit &&
      repoCollapsed.ok &&
      repoExpandClick.hit &&
      repoExpanded.ok &&
      groupPresent.ok &&
      groupCollapseClick.hit &&
      groupCollapsed.ok &&
      headerStillThereWhileCollapsed &&
      groupExpandClick.hit &&
      groupExpanded.ok,
  }
  console.log('phase1 (collapse/expand both directions)', phase1)
  writeRaw('c3-collapse-phase1.json', phase1)

  // ---------- 재기동 후 ⓐⓑ 둘 다 유지되는지 — 그룹부터 collapse(ⓐ가 펼쳐져 있어야 DOM 이 있다),
  // 그 다음 레포를 collapse 한다. ----------
  await app.click(`[data-agent-group="${repo.root}"]`) // ⓑ collapse
  await until(async () => (await app.query('[data-tab]')).found.length === 0, { timeoutMs: 4000, what: 'ⓑ collapsed before restart' })
  await app.click(`[data-repo-toggle="${repo.root}"]`) // ⓐ collapse
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length === 0, { timeoutMs: 4000, what: 'ⓐ collapsed before restart' })
  const prefsBeforeRestart = await app.send({ cmd: 'eval', code: 'window.corral.getUiPrefs().then((p) => ({ collapsedRepos: p.collapsedRepos, collapsedGroups: p.collapsedGroups }))' })
  await app.stop()

  const app2 = await startApp({ name: '03-c3-collapse-restart', env: { CORRAL_UI_PREFS: uiPrefsFile } })
  await app2.addRepo(repo.root)
  await until(async () => (await app2.query(`[data-repo="${repo.root}"]`)).found.length > 0, { timeoutMs: 8000, what: 'repo row mounted (restart)' })
  const worktreeHiddenAfterRestart = await until(async () => (await app2.query(`[data-worktree="${repo.root}"]`)).found.length === 0, {
    timeoutMs: 4000,
    what: 'ⓐ still collapsed after restart',
  })
  // ⓐ 를 펼쳐서 그 밑의 ⓑ(그룹) 상태를 들여다본다.
  await app2.click(`[data-repo-toggle="${repo.root}"]`)
  await until(async () => (await app2.query(`[data-worktree="${repo.root}"]`)).found.length > 0, { timeoutMs: 4000, what: 'ⓐ expanded to inspect ⓑ' })
  const groupStillCollapsedAfterRestart = await until(
    async () => {
      const group = await app2.query(`[data-agent-group="${repo.root}"]`)
      const tabRows = await app2.query('[data-tab]')
      return group.found.length > 0 && tabRows.found.length === 0 ? true : null
    },
    { timeoutMs: 4000, what: 'ⓑ still collapsed after restart (group header present, no session rows)' },
  )
  const prefsAfterRestart = await app2.send({ cmd: 'eval', code: 'window.corral.getUiPrefs().then((p) => ({ collapsedRepos: p.collapsedRepos, collapsedGroups: p.collapsedGroups }))' })
  await app2.stop()

  const phase2 = {
    prefsBeforeRestart: prefsBeforeRestart.result,
    repoStillCollapsedAfterRestart: worktreeHiddenAfterRestart.ok,
    groupStillCollapsedAfterRestart: groupStillCollapsedAfterRestart.ok,
    prefsAfterRestart: prefsAfterRestart.result,
    pass: worktreeHiddenAfterRestart.ok && groupStillCollapsedAfterRestart.ok,
  }
  console.log('phase2 (restart persistence, both ⓐⓑ)', phase2)
  writeRaw('c3-collapse-phase2.json', phase2)

  const overall = { phase1Pass: phase1.pass, phase2Pass: phase2.pass, allPass: phase1.pass && phase2.pass }
  console.log('C3 overall', overall)
  writeRaw('c3-collapse-summary.json', overall)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
