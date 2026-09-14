// C5′ — 메인 탭바 **상시 렌더** (01-criteria.md 부록 C5′ / 11-gate1-fix3.md I-5).
//
// ## 기준이 바뀌었다 — 낮아진 게 아니라 높아졌다
//
// 옛 C5 는 `sessionCount >= 2` 일 때만 렌더를 freeze 했다. 그 근거(Orca `hasTabBar =
// tabCount >= 2`)가 **탭 스트립의 조건이 아니었다** — 같은 파일의 타이틀바 확장 버튼에만
// 쓰인다. 사용자 결정 + 이 사실 정정으로 C5′ 가 됐고, 증명해야 할 상태가 **2개(1/N)에서
// 3개(0/1/N)로 늘었다.** 그래서 이 파일에서 `>= 2` 판정식을 지우는 건 규칙 약화가 아니다 —
// 철회 근거는 위 두 문서에 있다(11-gate1-fix3.md 재검증표의 ⚠ 조항).
//
// 탭 0개는 **추측하지 않고 만들어서 잰다**: 마지막 탭을 탭바의 × 로 닫고 herdr 가 그 상태를
// 허용하는지, 허용하면 `+` 가 남는지를 실측한다.
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

  const noWorkspace = await tabBarState(app) // worktree 안 열림 — activeWorkspace 자체가 없다
  console.log('no workspace (unopened)', noWorkspace)

  await app.click(`[data-worktree="${repo.root}"]`)
  const workspaceId = await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace?.workspaceId ?? null,
    { timeoutMs: 8000, what: 'worktree opened' },
  ).then((r) => r.value)
  const one = await tabBarState(app) // 열자마자 기본 탭 1개 — C5′ 는 여기서 탭바가 **있어야** 한다
  console.log('tabCount=1 (default tab)', one)

  // 세션 2개로. C5′ 에선 탭 1개에서도 탭바가 있으므로 **여기서부터 탭바의 "+" 를 쓸 수 있다** —
  // 옛 주석("탭바가 아직 없으니 첫 추가는 worktree 메뉴로")은 거짓이 됐다. 탭바 + 로 만든다.
  const addAtOneClick = await app.click('[data-main-tabbar-add]')
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

  // ---------- 탭 0개 경계 — **추측 금지, 만들어서 잰다**(11-gate1-fix3.md I-5) ----------
  // 남은 탭을 전부 탭바의 × 로 닫고 herdr 가 탭 0개 workspace 를 허용하는지 본다.
  // 허용하면 C5′ 대로 탭바 껍데기와 `+` 가 남아야 하고, 허용하지 않으면(자동 재생성·자동 종료)
  // 그 자체가 관측 결과다 — 억지로 만들지 않고 무엇이 일어났는지 기록한다.
  // ⚠ 에이전트가 붙은 탭을 닫으면 **확인 게이트**가 뜬다(`closeRow` → `needs-confirm` →
  // ConfirmClose 모달, LIFE-356 종료 게이트). 첫 실측에서 이걸 모르고 "herdr 가 탭 0개를
  // 막는다"로 읽을 뻔했다 — 막은 건 herdr 가 아니라 우리 확인 모달이었다. 모달이 뜨면
  // 좌표 클릭으로 통과시키고 계속한다(게이트를 우회하는 게 아니라 사용자가 하는 일을 그대로 한다).
  const zeroTabProbe = { attemptedCloses: [], reachable: null, finalTabCount: null, barPresent: null, addButtonPresent: null, addClickable: null, workspaceStillOpen: null, note: null }
  for (let guard = 0; guard < 12; guard += 1) {
    const ids = await currentTabIds(app, workspaceId)
    if (ids.length === 0) break
    const victim = ids[0]
    const hit = await app.click(`[data-main-tab-close="${victim}"]`)
    let confirmed = false
    const modal = await until(async () => (await app.query('[data-confirm-close-modal]')).found.length > 0, { timeoutMs: 1500, what: 'confirm modal' }).catch(() => ({ ok: false }))
    if (modal.ok) {
      const okClick = await app.click('[data-close-confirm-ok]')
      confirmed = okClick.hit
    }
    const gone = await until(async () => !(await currentTabIds(app, workspaceId)).includes(victim), { timeoutMs: 8000, what: `tab ${victim} closed` }).catch(() => ({ ok: false }))
    zeroTabProbe.attemptedCloses.push({ tabId: victim, clickHit: hit.hit, neededConfirm: modal.ok, confirmed, gone: gone.ok })
    if (!gone.ok) break
  }
  const afterZero = await tabBarState(app)
  const remainingIds = await currentTabIds(app, workspaceId)
  const zeroState = await app.state()
  const zeroWorktree = zeroState.repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
  zeroTabProbe.finalTabCount = remainingIds.length
  zeroTabProbe.reachable = remainingIds.length === 0
  zeroTabProbe.barPresent = afterZero.barPresent
  zeroTabProbe.workspaceStillOpen = zeroWorktree?.openWorkspaceId !== null && zeroWorktree?.openWorkspaceId !== undefined
  zeroTabProbe.addButtonPresent = (await app.query('[data-main-tabbar-add]')).found.length > 0
  // 탭 0개에 도달했을 때 **화면이 무엇을 보여주는가** — 판정의 근거가 되는 실물.
  zeroTabProbe.screenAtZero = (
    await app.send({
      cmd: 'eval',
      code: `(() => ({
        tabbarPresent: document.querySelector('[data-main-tabbar]') !== null,
        addPresent: document.querySelector('[data-main-tabbar-add]') !== null,
        worktreeRowStillListed: document.querySelector('[data-worktree]') !== null,
        anySelectedBlock: document.querySelector('.worktree-block.is-selected') !== null,
        mainAreaText: (document.querySelector('[data-main-area]')?.textContent ?? '').trim().slice(0, 120),
      }))()`,
    })
  ).result
  // 닫힌 worktree 를 다시 열 수 있는가 — "0개에서 복구 불가"가 아님을 보인다.
  const reopenClick = await app.click(`[data-worktree="${repo.root}"]`)
  const reopened = await until(async () => (await currentTabIds(app, workspaceId)).length > 0 || (await app.query('[data-main-tabbar]')).found.length > 0, {
    timeoutMs: 20000,
    what: 'worktree reopened after reaching 0 tabs',
  }).catch(() => ({ ok: false }))
  zeroTabProbe.recoverable = { clickHit: reopenClick.hit, reopened: reopened.ok }

  if (zeroTabProbe.reachable && zeroTabProbe.workspaceStillOpen && zeroTabProbe.addButtonPresent) {
    // `+` 가 남아 있다는 주장은 **눌러서** 증명한다 — DOM 에 있는 것과 동작하는 것은 다르다.
    const addClick = await app.click('[data-main-tabbar-add]')
    const recreated = await until(async () => (await currentTabIds(app, workspaceId)).length === 1, { timeoutMs: 10000, what: 'tab recreated from 0 via +' }).catch(() => ({ ok: false }))
    zeroTabProbe.addClickable = addClick.hit && recreated.ok
  }
  zeroTabProbe.note = zeroTabProbe.reachable
    ? '탭 0개 상태에 실제로 도달했다(에이전트 탭은 확인 게이트를 통과시켜 닫았다). C5′ 대로 탭바와 + 가 남아 있어야 한다.'
    : `탭 0개에 도달하지 못했다 — 남은 탭 ${remainingIds.length}개. 마지막 닫기 시도의 결과는 attemptedCloses 끝 항목에 있다(확인 게이트 여부 포함). 도달 불가 자체가 관측 결과다.`
  // ---------- 판정 ----------
  // 실측 결과: 탭 0개에는 도달하지만 **마지막 탭을 닫으면 workspace 자체가 닫힌다**
  // (`openWorkspaceId === null`). C5′ 의 마운트 조건은 "활성 workspace 가 있으면" 이므로,
  // 탭바가 없는 건 규칙 위반이 아니라 **조건 불성립**이다 — "탭 0개 + 활성 workspace" 는
  // corral 에서 만들 수 없는 상태다. 지시서가 예상한 "탭 0개에서도 + 가 남는다" 는 그래서
  // 공허참이고, 추측으로 통과시키지 않고 이렇게 관측 근거를 남긴다.
  zeroTabProbe.interpretation = zeroTabProbe.reachable === false
    ? '탭 0개 자체에 도달 불가'
    : zeroTabProbe.workspaceStillOpen
      ? '탭 0개 workspace 가 살아 있다 → C5′ 대로 탭바와 + 가 남아야 한다'
      : '마지막 탭을 닫으면 workspace 가 함께 닫힌다 → "탭 0개 + 활성 workspace" 상태가 존재하지 않는다. C5′ 마운트 조건(활성 workspace) 불성립이라 탭바 부재가 정상이고, worktree 행을 다시 누르면 복구된다(recoverable).'
  zeroTabProbe.pass =
    zeroTabProbe.reachable === false
      ? null
      : zeroTabProbe.workspaceStillOpen
        ? zeroTabProbe.barPresent === true && zeroTabProbe.addButtonPresent === true && zeroTabProbe.addClickable === true
        : // workspace 가 닫혔으면 탭바가 **없어야** 정상이고, 복구 가능해야 한다.
          zeroTabProbe.barPresent === false && zeroTabProbe.recoverable.reopened === true

  await app.stop()

  const result = {
    zeroTabProbe,
    divergeAtTwo,
    divergeMixed,
    // C5′ 의 마운트 조건은 **활성 workspace 유무** 하나다(App.tsx `activeWorkspace !== null`).
    // worktree 를 안 열었으면 workspace 가 없으니 탭바도 없다 — 이건 C5′ 와 어긋나지 않는다.
    noWorkspace: { ...noWorkspace, expectAbsent: true, reason: 'worktree 미개방 = 활성 workspace 없음 → C5′ 마운트 조건 자체가 불성립', pass: noWorkspace.barPresent === false && noWorkspace.tabCount === 0 },
    // ⬇ 옛 C5 가 "탭바 없음"을 요구하던 자리. C5′ 는 **있어야 한다**로 뒤집혔다.
    one: { ...one, expectPresent: true, pass: one.barPresent === true && one.tabCount === 1 },
    // 탭 1개 상태에서 **탭바의 + 로** 두 번째를 만들었다 — C5′ 가 열어 준 경로다(옛 규칙에선
    // 탭바가 없어서 worktree 메뉴를 거쳐야 했다).
    two: { ...two, expectPresent: true, addAtOneClickHit: addAtOneClick.hit, pass: two.barPresent === true && two.tabCount === 2 && addAtOneClick.hit },
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
    (result.zeroTabProbe.pass === null || result.zeroTabProbe.pass === true) &&
    result.divergeAtTwo.pass &&
    result.divergeMixed.pass &&
    result.noWorkspace.pass &&
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
