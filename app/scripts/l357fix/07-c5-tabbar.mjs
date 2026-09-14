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
import { agentTabsOf, buildMixedFixture, createTab, makeScratchRepo, sleep, startApp, tabsOf, until, writeRaw } from './lib.mjs'

async function tabBarState(app) {
  const bar = await app.query('[data-main-tabbar]')
  const tabs = await app.query('[data-main-tab]')
  return { barPresent: bar.found.length > 0, tabCount: tabs.found.length }
}

/**
 * workspace 가 **정말** 살아 있는가 — 한 번 읽고 단정하지 않는다 (fix4).
 *
 * 4회차 1차 실행에서 `openWorkspaceId` 는 살아 있다는데 탭바는 없는, **서로 모순된 한 컷**이
 * 나왔다. 마지막 탭이 사라진 직후에는 herdr 푸시와 골격 재조회(`scheduleTree`)가 아직
 * 안 맞은 상태라 한 컷이 거짓말한다. 그래서 몇 초간 **연속 샘플**을 남기고 **정착값**으로 판정한다.
 */
async function sampleWorkspace(app, repoRoot, { count = 8, everyMs = 800 } = {}) {
  const samples = []
  for (let i = 0; i < count; i += 1) {
    const st = await app.state()
    const wt = st.repos.flatMap((r) => r.worktrees).find((w) => w.path === repoRoot)
    const bar = await tabBarState(app)
    samples.push({
      at: Date.now(),
      openWorkspaceId: wt?.openWorkspaceId ?? null,
      tabCountInState: wt?.workspace?.tabs.length ?? 0,
      barPresent: bar.barPresent,
      tabCountInDom: bar.tabCount,
    })
    if (i < count - 1) await sleep(everyMs)
  }
  const settled = samples[samples.length - 1]
  return {
    samples,
    settled,
    stable: samples.slice(-3).every((s) => s.openWorkspaceId === settled.openWorkspaceId && s.barPresent === settled.barPresent),
    workspaceOpen: settled.openWorkspaceId !== null,
    // 화면과 상태가 어긋난 채로 굳으면 그것 자체가 결함이다 — 조용히 한쪽만 믿지 않는다.
    consistent: (settled.openWorkspaceId !== null) === settled.barPresent,
  }
}

/**
 * 탭 목록이 **안정될 때까지** 기다렸다 읽는다 (fix4 J-6 2차 정정).
 *
 * workspace 를 다시 열면 herdr 가 기본 탭을 **한 박자 늦게** 붙인다. 그 전에 목록을 읽고
 * "탭 1개"라고 믿으면, `exit` 를 친 순간엔 이미 2개라 **마지막 탭 실험이 아니게 된다**
 * (1차·2차 실행이 연달아 이 함정에 빠졌다 — 둘 다 공허한 '도달'이었다).
 */
async function stableTabIds(app, workspaceId, { settleMs = 900, rounds = 4 } = {}) {
  let last = null
  let same = 0
  for (let i = 0; i < 20; i += 1) {
    const ids = await currentTabIds(app, workspaceId)
    const key = ids.join(',')
    same = key === last ? same + 1 : 0
    last = key
    if (same >= rounds - 1) return ids
    await sleep(settleMs)
  }
  return currentTabIds(app, workspaceId)
}

/**
 * 그 workspace 의 탭 id 들. **workspace 가 목록에 없으면 `null`** 이다 (fix4 정정).
 *
 * 예전엔 `?? []` 라 "탭이 0개"와 "workspace 를 못 찾았다"가 **같은 값**이었다. workspace 가
 * 잠깐 안 보이는 순간(골격 재조회 중)을 "탭 0개 도달"로 읽어 `exit` 실측이 거짓 통과했다.
 */
async function tabIdsOrNull(app, workspaceId) {
  const s = await app.state()
  const ws = s.repos.flatMap((r) => r.worktrees).find((w) => w.workspace?.workspaceId === workspaceId)?.workspace
  return ws === undefined || ws === null ? null : ws.tabs.map((t) => t.tabId)
}

async function currentTabIds(app, workspaceId) {
  return (await tabIdsOrNull(app, workspaceId)) ?? []
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
  zeroTabProbe.firstShot = { barPresent: afterZero.barPresent, openWorkspaceId: zeroWorktree?.openWorkspaceId ?? null }
  // **한 컷으로 단정하지 않는다** — 위 `sampleWorkspace` 주석 참조.
  zeroTabProbe.settling = zeroTabProbe.reachable ? await sampleWorkspace(app, repo.root) : null
  zeroTabProbe.barPresent = zeroTabProbe.settling?.settled.barPresent ?? afterZero.barPresent
  zeroTabProbe.workspaceStillOpen = zeroTabProbe.settling?.workspaceOpen ?? false
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
  // ⚠ note 와 interpretation 이 서로 다른 말을 하던 자리다 (J-6 문구 모순 정리, fix3 리뷰 M4).
  // note 는 **무슨 일이 있었는지**만 적고, 통과선은 아래 정정된 기준서 조항이 정한다:
  // 01-criteria.md C5′ 정정문 — ⓐ workspace 가 살아 있으면 탭바 + **눌러지는** `+`,
  // ⓑ workspace 가 함께 닫혔으면 탭바 부재 + worktree 행 클릭으로 복구 가능.
  zeroTabProbe.note = zeroTabProbe.reachable
    ? `탭바 × 로 남은 탭을 전부 닫아 탭 0개에 도달했다(에이전트 탭은 확인 게이트를 통과시켜 닫았다). workspace 는 ${zeroTabProbe.workspaceStillOpen ? '살아 있다 → ⓐ 칸' : '함께 닫혔다 → ⓑ 칸'}.`
    : `탭 0개에 도달하지 못했다 — 남은 탭 ${remainingIds.length}개. **이 브랜치에서 이건 제품 거동이 아니라 측정 실패다**(J-5): 설치 herdr 0.9.0 은 마지막 탭 종료를 허용한다. 마지막 닫기 시도의 결과는 attemptedCloses 끝 항목에 있다.`
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
  // J-5 — **`null` 탈출구를 없앴다.** 예전엔 `reachable === false → pass: null → allPass` 통과라,
  // 닫기 클릭이 빗나가거나 확인 모달이 안 눌리면 0개 칸이 **증명 없이** 통과했다.
  // 도달 실패는 이제 **실패**다. 정말 upstream 거동 차이라면 herdr 거절 코드 같은 별도 근거를
  // 들고 와서 보류 칸을 새로 만들어야 하고, 그때도 allPass 에서 빼지 않는다.
  zeroTabProbe.pass =
    zeroTabProbe.reachable === false
      ? false
      : zeroTabProbe.workspaceStillOpen
        ? zeroTabProbe.barPresent === true && zeroTabProbe.addButtonPresent === true && zeroTabProbe.addClickable === true
        : // workspace 가 닫혔으면 탭바가 **없어야** 정상이고, 복구 가능해야 한다.
          zeroTabProbe.barPresent === false && zeroTabProbe.recoverable.reopened === true

  // ---------- J-6: **다른 경로로도** 탭 0개에 닿는가 — 셸에서 `exit` ----------
  // 기준서 C5′ 정정문의 사정거리가 "탭바 × 로 닫는 경로"로 좁혀졌다(fix3 리뷰 M4).
  // 그 경로 말고 사용자가 실제로 쓰는 다른 경로 하나를 잰다. 결과가 ⓐ(workspace 생존)면
  // **정정문을 다시 고쳐야 한다** — 그때는 "눌러지는 +" 를 실제로 눌러 증명한다.
  const exitPathProbe = { path: '셸 pane 에서 exit', reachable: null, workspaceStillOpen: null, barPresent: null, addButtonPresent: null, addClickable: null, focusedTerminal: null, note: null, pass: null }
  {
    // 0) fixture 를 **다시 세운다.** 앞 단계에서 workspace 가 닫혔을 수 있으므로 worktree 를
    //    다시 열고, 탭이 하나도 없으면 worktree 메뉴로 셸 탭을 만든다. 이 준비가 안 되면
    //    "탭 0개에서 시작해 탭 0개로 끝났다"는 **공허한 도달**이 된다(1차 실행이 그랬다).
    await app.click(`[data-worktree="${repo.root}"]`)
    await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.openWorkspaceId != null, {
      timeoutMs: 25000,
      what: 'exit 실측용 workspace 재개방',
    }).catch(() => ({ ok: false }))
    const reopenedState = await app.state()
    const reopenedWs = reopenedState.repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
    const exitWorkspaceId = reopenedWs?.openWorkspaceId ?? workspaceId
    exitPathProbe.workspaceId = exitWorkspaceId
    const openIds = await currentTabIds(app, exitWorkspaceId)
    let addClickForExit = { hit: null }
    if (openIds.length === 0) {
      await createTab(app, repo.root, 'shell')
    } else {
      addClickForExit = await app.click('[data-main-tabbar-add]')
    }
    const grew = await until(async () => (await currentTabIds(app, exitWorkspaceId)).length > openIds.length, { timeoutMs: 20000, what: 'exit 실측용 셸 탭' }).catch(() => ({ ok: false }))
    // 목록이 **굳은 뒤에** 읽는다 — 늦게 붙는 기본 탭을 놓치면 실험이 통째로 무효다.
    const idsNow = await stableTabIds(app, exitWorkspaceId)
    const shellTabId = idsNow.find((id) => !openIds.includes(id)) ?? idsNow[0] ?? null
    for (const victim of idsNow.filter((id) => id !== shellTabId)) {
      await app.click(`[data-main-tab-close="${victim}"]`)
      const modal = await until(async () => (await app.query('[data-confirm-close-modal]')).found.length > 0, { timeoutMs: 1500, what: 'confirm modal' }).catch(() => ({ ok: false }))
      if (modal.ok) await app.click('[data-close-confirm-ok]')
      await until(async () => !(await currentTabIds(app, exitWorkspaceId)).includes(victim), { timeoutMs: 8000, what: `tab ${victim} closed` }).catch(() => ({ ok: false }))
    }
    // 2) 그 탭을 활성화하고 **타이핑이 그 터미널에 간다는 걸 확인한 뒤에** 친다.
    //    이 확인을 빼면 `exit` 가 어디로 갔는지 모르는 채로 "도달 불가"라는 결론이 나온다
    //    (fix2 1회차·15-title-probe3 1차가 그 함정이었다).
    if (shellTabId !== null) await app.click(`[data-main-tab="${shellTabId}"]`)
    // **기능으로 확인한다.** `document.activeElement` 가 textarea 인지 보는 방식은 이 실행에서
    // 계속 false 였는데(창 포커스 등 다른 요인) 정작 타이핑은 닿는다 — 우리가 알아야 하는 건
    // "글자가 이 터미널에 들어가는가" 하나다. 표식을 한 줄 쳐서 화면에 뜨는지로 잰다
    // (17-rename 의 양성 대조와 같은 결).
    const FOCUS_MARK = 'probe-focus-ok'
    // ⚠ **터미널이 붙은 뒤에** 친다. 마운트 전에 치면 글자가 아무 데도 안 가고, 그걸 "포커스
    // 실패"로 읽으면 원인을 잘못 짚는다(1차 실행이 그랬다).
    const shellPaneId = (await app.state()).repos
      .flatMap((r) => r.worktrees)
      .find((w) => w.workspace?.workspaceId === exitWorkspaceId)
      ?.workspace?.tabs.find((t) => t.tabId === shellTabId)
      ?.panes[0]?.paneId ?? null
    exitPathProbe.shellPaneId = shellPaneId
    exitPathProbe.termMounted = (
      await until(
        async () => (await app.query(`.term-host[data-term-pane="${shellPaneId}"]`)).found.length > 0,
        { timeoutMs: 20000, what: '셸 pane 터미널 마운트' },
      )
    ).ok
    await sleep(900)
    // 터미널을 **눌러서** 포커스를 준다 — 사용자가 하는 그대로다. 앞 단계에서 확인 모달·`+`
    // 버튼을 누르느라 포커스가 딴 데 가 있으면 `char` 이벤트가 그 요소로 가서 아무 일도 안 난다.
    exitPathProbe.termClick = (await app.click(`.term-host[data-term-pane="${shellPaneId}"]`)).hit
    await sleep(400)
    await app.type(`# ${FOCUS_MARK}\r`)
    const focusCheck = (
      await until(
        async () => {
          const r = await app.send({ cmd: 'term-read' }).catch(() => null)
          const term = r?.term ?? {}
          return (term.lines ?? term.rows ?? []).join('\n').includes(FOCUS_MARK)
        },
        { timeoutMs: 15000, what: '셸 터미널에 타이핑 도달' },
      )
    ).ok
    exitPathProbe.focusProbe = { mark: FOCUS_MARK, reachedTerminal: focusCheck }
    exitPathProbe.focusedTerminal = focusCheck
    exitPathProbe.tabsBefore = await stableTabIds(app, exitWorkspaceId)
    // **유효성**: 탭이 정확히 1개여야 "마지막 탭을 exit 로 없앤다"는 실험이 성립한다.
    // 0개에서 시작하면 도달이 공허참이 되고, 2개 이상이면 마지막 탭이 아니다.
    exitPathProbe.fixtureValid = exitPathProbe.tabsBefore.length === 1 && focusCheck
    if (exitPathProbe.fixtureValid) {
      await app.type('exit\r')
      const victimId = exitPathProbe.tabsBefore[0]
      exitPathProbe.victimId = victimId
      // 그 탭이 사라졌을 뿐 아니라 **탭이 0개**여야 한다 — 둘을 같이 건다.
      // ⚠ 0개 창은 **짧다**: herdr 가 곧 새 탭을 채운다(아래 refill). 그래서 0개를 본 그 순간
      // 화면을 같이 찍어 둔다 — 나중에 읽으면 이미 1개라 "0탭에서 탭바가 있었나"를 못 잔다.
      exitPathProbe.reachable = (
        await until(
        async () => {
          const ids = await tabIdsOrNull(app, exitWorkspaceId)
          // `null` 은 두 가지다: ① 골격 재조회 중 잠깐 안 보임 ② workspace 가 **함께 닫힘**.
          // 둘 다 "그 탭이 사라졌다"에는 해당하므로 도달로 친다 — 어느 쪽인지는 아래 정착
          // 샘플이 가른다(살아 있으면 ⓐ, 닫혔으면 ⓑ). `null` 을 기다리기만 하면 ⓑ 에서
          // 영원히 도달 못 한 것으로 읽힌다(4차 실행이 그랬다).
          if (ids !== null && ids.includes(victimId)) return false
          // 탭 0개인데 workspace 는 살아 있는 **그 순간**만 찍는다 — ⓐ 의 유일한 증거다.
          if (ids !== null && ids.length === 0 && exitPathProbe.atZero === undefined) {
            exitPathProbe.atZero = (
              await app.send({
                cmd: 'eval',
                code: `(() => ({
                  at: Date.now(),
                  tabbarPresent: document.querySelector('[data-main-tabbar]') !== null,
                  addPresent: document.querySelector('[data-main-tabbar-add]') !== null,
                  tabCountInDom: document.querySelectorAll('[data-main-tab]').length,
                  worktreeLabel: document.querySelector('[data-main-tabbar-worktree]')?.textContent ?? null,
                }))()`,
              })
            ).result
            // 0개를 본 **즉시** + 를 눌러 본다. 재충전이 먼저 이기면 그 사실도 기록으로 남는다.
            const addAtZero = await app.click('[data-main-tabbar-add]')
            exitPathProbe.addAtZero = { hit: addAtZero.hit, tabCountWhenClicked: exitPathProbe.atZero.tabCountInDom }
          }
          return true
        },
          { timeoutMs: 20000, what: 'exit 로 탭 0개' },
        )
      ).ok
      const afterSettle = await stableTabIds(app, exitWorkspaceId)
      exitPathProbe.refill = {
        tabsAfter: afterSettle,
        newTabAppeared: afterSettle.length > 0 && !afterSettle.includes(victimId),
        note: '탭 0개 창이 유지되지 않는다면 herdr 가 workspace 에 탭을 다시 채운 것이다 — corral 에는 그런 경로가 없다(workspace.create 는 worktree 열기 전용).',
      }
    } else {
      exitPathProbe.reachable = false
    }
    exitPathProbe.settling = await sampleWorkspace(app, repo.root)
    exitPathProbe.workspaceStillOpen = exitPathProbe.settling.workspaceOpen
    exitPathProbe.barPresent = exitPathProbe.settling.settled.barPresent
    exitPathProbe.addButtonPresent = (await app.query('[data-main-tabbar-add]')).found.length > 0
    if (exitPathProbe.reachable && exitPathProbe.workspaceStillOpen && exitPathProbe.addButtonPresent) {
      // ⓐ 가 실재한다 — DOM 에 있는 것과 **눌리는** 것은 다르므로 눌러서 증명한다.
      // `+` 가 **눌린다**는 주장은 누른 뒤 탭이 하나 늘어야 증명된다. 누르기 직전 개수를 찍어
      // 둔다 — 이미 1개인 상태에서 `length === 1` 을 기다리면 아무것도 증명하지 않는다.
      const beforeAdd = await currentTabIds(app, exitWorkspaceId)
      const addClick = await app.click('[data-main-tabbar-add]')
      const recreated = await until(async () => (await currentTabIds(app, exitWorkspaceId)).length === beforeAdd.length + 1, { timeoutMs: 10000, what: '+ 로 탭 생성' }).catch(() => ({ ok: false }))
      exitPathProbe.addFrom = beforeAdd.length
      exitPathProbe.addClickable = addClick.hit && recreated.ok
    } else if (exitPathProbe.reachable) {
      const reopenClick2 = await app.click(`[data-worktree="${repo.root}"]`)
      const reopened2 = await until(async () => (await app.query('[data-main-tabbar]')).found.length > 0, { timeoutMs: 20000, what: 'exit 뒤 복구' }).catch(() => ({ ok: false }))
      exitPathProbe.recoverable = { clickHit: reopenClick2.hit, reopened: reopened2.ok }
    }
    exitPathProbe.addClickForExitHit = addClickForExit.hit
    exitPathProbe.shellTabCreated = grew.ok === undefined ? grew : grew.ok
    exitPathProbe.note = exitPathProbe.fixtureValid !== true
      ? `실험 불성립 — 시작 탭 ${exitPathProbe.tabsBefore.length}개 / 터미널 포커스 ${focusCheck}. 도달 여부를 판정하지 않는다(공허참 방지).`
      : !exitPathProbe.reachable
      ? '`exit` 로 탭 0개에 도달하지 못했다 — 포커스 확인 결과(focusedTerminal)를 같이 보라. 도달 실패는 측정 실패로 센다(J-5 와 같은 기준).'
      : exitPathProbe.workspaceStillOpen
        ? '**ⓐ 칸이 실재한다** — `exit` 로 마지막 탭이 사라져도 workspace 가 살아 있다. 다만 0개 상태는 **일시적**이다(herdr 가 탭을 다시 채운다). 0개를 본 순간의 화면은 atZero 에 있다. C5′ 정정문을 다시 고쳐야 한다(코디네이터 보고 대상).'
        : 'workspace 가 함께 닫혔다 → ⓑ. 탭바 × 경로와 같은 결론이고, 정정문의 사정거리를 그만큼 넓힐 근거가 된다.'
    exitPathProbe.pass = exitPathProbe.fixtureValid !== true || !exitPathProbe.reachable
      ? false
      : exitPathProbe.workspaceStillOpen
        ? // ⓐ: workspace 가 살아 있으면 **0개를 본 그 순간** 탭바와 `+` 가 화면에 있어야 하고,
          // `+` 는 실제로 눌려 탭을 늘려야 한다(0개 창이 짧아 클릭은 재충전 뒤가 될 수 있다 —
          // 그래서 존재는 0개 순간 값으로, 눌림은 그 뒤 값으로 나눠 건다).
          exitPathProbe.atZero?.tabbarPresent === true &&
          exitPathProbe.atZero?.addPresent === true &&
          exitPathProbe.barPresent === true &&
          exitPathProbe.addClickable === true
        : exitPathProbe.barPresent === false && exitPathProbe.recoverable?.reopened === true
  }

  await app.stop()

  const result = {
    zeroTabProbe,
    exitPathProbe,
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
    result.zeroTabProbe.pass === true &&
    result.exitPathProbe.pass === true &&
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
