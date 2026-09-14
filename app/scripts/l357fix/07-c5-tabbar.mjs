// C5 — 메인 탭바 (게이트 ① 수정 라운드 재실행, 09-gate1-fix.md G).
//
// 재실행 사유·달라진 것: 탭바와 사이드바의 "세션" 정의가 **갈렸다**(01-criteria.md 부록
// "세션 용어 확정"). 탭바 `sessionCount` = 그 workspace 의 **전체 탭**, 사이드바 = **에이전트
// 세션**. 부록이 "둘이 같은 fixture 로는 이 구분이 증명되지 않는다"고 못 박았으므로,
// 에이전트 탭·셸 탭을 **섞어** 두 수가 실제로 다른 상태를 만들어 잰다 — 그게 곧 D 의 증거다.
//
// 이전 회차 원문: 수정 1회차(07-fix-orca1.md M-2) 전면 재작성: 1차 구현은 0/1/2/3 세션에서
// 탭바 유무·개수만 찍었다(보류 판정, grok M1). freeze 된 C5 본문은 **탭바 위에서** 전환·생성(+)·
// 닫기 좌표 클릭과 활성 탭 시각 구분을 요구한다 — 이번엔 그 넷을 전부 좌표 클릭(관문④)·
// getComputedStyle 실측으로 원자료에 남긴다. MainTabBar 에 닫기 컨트롤이 없던 것도 이번 수정
// 범위에서 추가했다(코디네이터 결정 — SessionRow 닫기로 갈음 불가).
import { agentTabsOf, buildMixedFixture, createTab, makeScratchRepo, startApp, tabsOf, until, writeRaw } from './lib.mjs'

async function tabBarState(app) {
  const bar = await app.query('[data-main-tabbar]')
  const tabs = await app.query('[data-main-tab]')
  return { barPresent: bar.found.length > 0, tabCount: tabs.found.length }
}

async function currentTabIds(app, workspaceId) {
  const s = await app.state()
  return (s.repos.flatMap((r) => r.worktrees).find((w) => w.workspace?.workspaceId === workspaceId)?.workspace?.tabs ?? []).map(
    (t) => t.tabId,
  )
}

// selectedPane 은 렌더러 로컬 상태(useLifecycleActions)라 main 의 `state` 커맨드엔 없다 —
// 어느 탭이 활성인지는 화면 자신의 `.is-active` 클래스로 읽는다(DOM 실측, 관문④ 취지와 같은 결).
async function activeTabIdViaDom(app) {
  const r = await app.send({ cmd: 'eval', code: "document.querySelector('.main-tab.is-active')?.getAttribute('data-main-tab') ?? null" })
  return r.result
}

async function main() {
  const repo = makeScratchRepo('c5-tabbar')
  const app = await startApp({ name: '05-c5-tabbar' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, { timeoutMs: 8000, what: 'worktree row mounted' })

  const zero = await tabBarState(app) // worktree 안 열림 — activeWorkspace 없음
  console.log('sessionCount=0 (unopened)', zero)

  await app.click(`[data-worktree="${repo.root}"]`)
  const workspaceId = await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace?.workspaceId ?? null,
    { timeoutMs: 8000, what: 'worktree opened' },
  ).then((r) => r.value)
  const one = await tabBarState(app) // 열자마자 기본 탭 1개
  console.log('sessionCount=1 (default tab)', one)

  // 세션 2개로 — worktree 메뉴가 아니라 **탭바 자신의 "+"** 로 만든다(C5 가 탭바 위 생성을 요구).
  // 탭바가 아직 없으니(1개뿐) 첫 번째 추가는 worktree 메뉴로 하고, 이후부터는 탭바의 + 를 쓴다.
  await createTab(app, repo.root, 'shell')
  await until(async () => (await currentTabIds(app, workspaceId)).length >= 2, { timeoutMs: 10000, what: 'tab count 2' })
  const two = await tabBarState(app)
  console.log('sessionCount=2', two)

  // ---------- 탭 2개(둘 다 셸)에서 사이드바는 0행 — 두 수가 갈리는 첫 지점 ----------
  const divergeAtTwo = {
    tabBarTabCount: two.tabCount,
    sidebarSessionRowCount: (await app.query('[data-tab]')).found.length,
    agentTabCount: agentTabsOf(await tabsOf(app, repo.root)).length,
  }
  divergeAtTwo.pass = divergeAtTwo.tabBarTabCount === 2 && divergeAtTwo.sidebarSessionRowCount === 0
  console.log('divergence (2 shell tabs)', divergeAtTwo)

  // ---------- 탭바 "+" 로 세 번째 탭 생성 (좌표 클릭, C5 요구) ----------
  const beforeCreate = await currentTabIds(app, workspaceId)
  const createClick = await app.click('[data-main-tabbar-add]')
  const created = await until(async () => (await currentTabIds(app, workspaceId)).length === beforeCreate.length + 1, {
    timeoutMs: 8000,
    what: 'tab created via tabbar +',
  })
  const three = await tabBarState(app)
  console.log('sessionCount=3 (탭바 + 로 생성)', three, { createClickHit: createClick.hit, created: created.ok })

  // ---------- 혼합 fixture 로 두 수를 확실히 갈라 놓는다: 에이전트 2 + 셸 3 ----------
  const fixture = await buildMixedFixture(app, repo.root, { agents: 2, shells: 3 })
  const mixed = await tabBarState(app)
  const divergeMixed = {
    fixture: { tabCount: fixture.tabCount, agentTabCount: fixture.agentTabCount, shellTabCount: fixture.shellTabCount },
    tabBarTabCount: mixed.tabCount,
    sidebarSessionRowCount: (await app.query('[data-tab]')).found.length,
    // 탭바는 전체 탭(App.tsx:193 `tabs={activeWorkspace.tabs}`), 사이드바는 에이전트 세션만(D).
    tabBarShowsAllTabs: mixed.tabCount === fixture.tabCount,
    sidebarShowsAgentsOnly: null,
    countsDiverge: null,
  }
  divergeMixed.sidebarShowsAgentsOnly = divergeMixed.sidebarSessionRowCount === fixture.agentTabCount
  divergeMixed.countsDiverge = divergeMixed.tabBarTabCount !== divergeMixed.sidebarSessionRowCount
  divergeMixed.pass = divergeMixed.tabBarShowsAllTabs && divergeMixed.sidebarShowsAgentsOnly && divergeMixed.countsDiverge
  console.log('divergence (mixed fixture)', divergeMixed)

  // ---------- 전환 (좌표 클릭으로 비활성 탭을 누르면 그 탭이 .is-active 로 바뀐다) ----------
  const tabIds = await currentTabIds(app, workspaceId)
  const activeTabIdBefore = await activeTabIdViaDom(app)
  const targetTabId = tabIds.find((id) => id !== activeTabIdBefore) ?? tabIds[0]
  const stateBeforeSwitch = await app.state()
  const targetPaneId = stateBeforeSwitch.repos
    .flatMap((r) => r.worktrees)
    .find((w) => w.workspace?.workspaceId === workspaceId)
    .workspace.tabs.find((t) => t.tabId === targetTabId)?.panes[0]?.paneId
  const switchClick = await app.click(`[data-main-tab="${targetTabId}"]`)
  const switched = await until(async () => (await app.query(`[data-main-tab="${targetTabId}"].is-active`)).found.length > 0, {
    timeoutMs: 6000,
    what: 'clicked tab became is-active',
  })
  const activeTabIdAfterSwitch = await activeTabIdViaDom(app) // app.stop() 전에 읽어야 한다 — 소켓이 죽은 뒤 읽으면 ENOENT

  // ---------- 활성 탭 시각 구분 — getComputedStyle 로 활성/비활성 배경이 실제로 다름을 실측 ----------
  const activeBg = await app.computedStyle(`[data-main-tab="${targetTabId}"]`, ['background-color'])
  const inactiveTabId = tabIds.find((id) => id !== targetTabId)
  const inactiveBg = inactiveTabId !== undefined ? await app.computedStyle(`[data-main-tab="${inactiveTabId}"]`, ['background-color']) : null

  // ---------- 닫기 (좌표 클릭 — MainTabBar 자체의 × 버튼, 이번 수정에서 추가) ----------
  const beforeClose = await currentTabIds(app, workspaceId)
  const closeTargetId = beforeClose.find((id) => id !== targetTabId) ?? beforeClose[0]
  const closeClick = await app.click(`[data-main-tab-close="${closeTargetId}"]`)
  const closed = await until(async () => !(await currentTabIds(app, workspaceId)).includes(closeTargetId), {
    timeoutMs: 8000,
    what: 'tab closed via tabbar ×',
  })

  await app.stop()

  const result = {
    divergeAtTwo,
    divergeMixed,
    // 탭바가 없으면 [data-main-tab] 자체가 DOM 에 없다 — tabCount 는 0 이어야 정상(세션 수와 무관).
    zero: { ...zero, expectAbsent: true, pass: zero.barPresent === false && zero.tabCount === 0 },
    one: { ...one, expectAbsent: true, pass: one.barPresent === false && one.tabCount === 0 },
    two: { ...two, expectPresent: true, pass: two.barPresent === true && two.tabCount === 2 },
    three: {
      ...three,
      createClickHit: createClick.hit,
      created: created.ok,
      expectPresent: true,
      pass: three.barPresent === true && three.tabCount === 3 && createClick.hit && created.ok,
    },
    switchTab: {
      activeTabIdBefore,
      targetTabId,
      targetPaneId,
      switchClickHit: switchClick.hit,
      becameActive: switched.ok,
      activeTabIdAfter: activeTabIdAfterSwitch,
      pass: switchClick.hit && switched.ok,
    },
    activeVisualDistinction: {
      activeTabId: targetTabId,
      activeBg: activeBg.values?.['background-color'] ?? null,
      inactiveTabId,
      inactiveBg: inactiveBg?.values?.['background-color'] ?? null,
      differs: activeBg.values?.['background-color'] !== inactiveBg?.values?.['background-color'],
      pass: inactiveTabId !== undefined && activeBg.values?.['background-color'] !== inactiveBg?.values?.['background-color'],
    },
    closeTab: {
      closeTargetId,
      closeClickHit: closeClick.hit,
      closed: closed.ok,
      pass: closeClick.hit && closed.ok,
    },
  }
  result.allPass =
    result.divergeAtTwo.pass &&
    result.divergeMixed.pass &&
    result.zero.pass &&
    result.one.pass &&
    result.two.pass &&
    result.three.pass &&
    result.switchTab.pass &&
    result.activeVisualDistinction.pass &&
    result.closeTab.pass
  console.log(JSON.stringify(result, null, 2))
  writeRaw('c5-tabbar.json', result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
