// C9 — 디자인 핸드오프 정합성 (01-criteria.md 본문 C9, freeze v2).
//
// **판정 기준이 C9′ → C9 로 바뀌었다** (09-gate1-fix.md G). C9′ 는 Orca 를 그라운드 트루스로
// 재는 항목인데 선행 결정 1(배경 서열 원안 복귀)로 그 축을 접었다. C9 는 같은 freeze v2 본문에
// 이미 있던 통과선이라, **낮추는 게 아니라 이미 있는 다른 통과선으로 갈아타는 것**이다(관문③).
//
// C9′ 와 셈법이 다르다 — 여기서 (a)는 **서열 대조가 아니라 값 일치**다. 그라운드 트루스가
// 외부 앱(Orca)이 아니라 이 프로젝트 자신의 핸드오프라, hue 가 다를 이유가 없다.
//
// 여유분(01-criteria.md 부록 권고: 색 7+·치수 4+)을 따라 (a) 8개·(b) 6개를 잰다.
// (b) 는 전부 렌더 실측치(rect/computedStyle 반환값)가 pass 식에 직접 들어간다 — 토큰·상수
// 인용이나 `pass: true` 리터럴은 미측정으로 0개로 센다(부록 규칙 승계).
import {
  agentTabsOf,
  buildMixedFixture,
  makeScratchRepo,
  sleep,
  startApp,
  tabsOf,
  until,
  writeRaw,
} from './lib.mjs'

// --- 그라운드 트루스 --------------------------------------------------------
// 전부 design-handoff.md / specs/design-tokens.css / 목업 리터럴에서 온 값이며, 앱이 실행 중
// 계산한 값이 아니다(관문⑤ — 판별자가 재는 대상 자신의 출력이면 안 된다).
// `mockupMeasured` 표시가 붙은 것은 코디네이터가 목업을 브라우저로 직접 열어 잰 값과도 일치
// 확인된 항목이다(2026-09-14 보정 메시지).
const HANDOFF = {
  colors: {
    bgWindow: { hex: '#0e1011', at: 'specs/design-tokens.css --bg-window · handoff §4 "창 크롬 --bg-window(#0e1011)"', mockupMeasured: 'rgb(14,16,17)' },
    bgSurface: { hex: '#141718', at: 'specs/design-tokens.css --bg-surface · handoff §4 "터미널 --bg-surface(#141718)"', mockupMeasured: 'rgb(20,23,24)' },
    bgSelected: { hex: '#1d2122', at: 'handoff §2 WorktreeBlock 표 "선택 | --bg-selected #1d2122" · §3', mockupMeasured: 'rgb(29,33,34)' },
    accent: { hex: '#7dd3a0', at: 'specs/design-tokens.css --accent · handoff §2 WorktreeBlock 표 "선택 도트 --accent"' },
    bgStatusbar: { hex: '#0b0d0e', at: 'specs/design-tokens.css --bg-statusbar · handoff §2 StatusBar' },
    bgRaised: { hex: '#181b1c', at: 'handoff §2 CreateWorktreeModal "패널 400px / --bg-raised"' },
    fg: { hex: '#e6e9e8', at: 'specs/design-tokens.css --fg · handoff §2 RepoRow "이름 12.5px/600 --fg"' },
    fgMuted: { hex: '#9aa3a1', at: 'specs/design-tokens.css --fg-muted · handoff §2 ReposSectionHeader "Repos 11px/600 대문자 --fg-muted"' },
  },
  dims: {
    brandbar: { px: 38, at: 'handoff §2 SidebarBrandBar "높이 --h-brandbar(38px)"', mockupMeasured: 38 },
    tabbar: { px: 33, at: 'handoff §2 MainTabBar "높이 --h-tabbar(33px)"', mockupMeasured: 33 },
    statusbar: { px: 25, at: 'handoff §2 StatusBar "높이 --h-statusbar(25px)"' },
    repoRow: { px: 28, at: 'handoff §2 RepoRow "높이 28px"', mockupMeasured: 28 },
    sessionRow: { px: 21, at: 'handoff §2 SessionRow "높이 21px"', mockupMeasured: 21 },
    groupRow: { px: 22, at: 'handoff §2 AgentGroupHeader "높이 22px"', mockupMeasured: 22 },
    sidebarW: { px: 322, at: 'specs/design-tokens.css --sidebar-w · 목업 인라인 width:322px', mockupMeasured: 322 },
  },
}

function hexToRgbCss(hex) {
  const c = hex.replace('#', '')
  return `rgb(${parseInt(c.slice(0, 2), 16)}, ${parseInt(c.slice(2, 4), 16)}, ${parseInt(c.slice(4, 6), 16)})`
}

async function computedProp(app, selector, prop) {
  const r = await app.computedStyle(selector, [prop])
  return r.values?.[prop] ?? null
}

/** 렌더 실측 색 하나 vs 핸드오프 리터럴 하나. 실측이 없으면(null) 미측정 → 불일치로 센다. */
function colorCheck({ label, selector, prop, rendered, truth, reason }) {
  const expected = hexToRgbCss(truth.hex)
  return {
    label,
    corral: { selector, prop, renderedColor: rendered },
    handoff: { hex: truth.hex, expectedCss: expected, at: truth.at, mockupMeasured: truth.mockupMeasured ?? null },
    measured: rendered !== null,
    matches: rendered !== null && rendered === expected,
    reason,
  }
}

function dimCheck({ label, selector, renderedPx, truth, tolerance = 0.5, reason }) {
  return {
    label,
    corral: { selector, renderedPx },
    handoff: { px: truth.px, at: truth.at, mockupMeasured: truth.mockupMeasured ?? null },
    measured: typeof renderedPx === 'number' && Number.isFinite(renderedPx),
    diffPx: typeof renderedPx === 'number' ? Math.abs(renderedPx - truth.px) : null,
    pass: typeof renderedPx === 'number' && Math.abs(renderedPx - truth.px) <= tolerance,
    reason,
  }
}

async function main() {
  const repo = makeScratchRepo('c9-handoff')
  const app = await startApp({ name: '08-c9-handoff' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { timeoutMs: 8000, what: 'repo row mounted' })

  // ---------- (c) 규칙 ③ RepoRow hover 액션 — hover 전: opacity:0 이되 레이아웃은 점유 ----------
  // "레이아웃 점유 유지" 는 hover 시 이름이 밀리지 않는다는 뜻이라, **rect 가 0 이 아님**을 재야
  // 한다(display:none 이면 0×0 이 된다). hover 는 raw-mouse mouseMove 로 실제로 만든다.
  const actionsSelector = `[data-repo-row-actions="${repo.root}"]`
  const actionsRectBefore = (await app.rect(actionsSelector)).rect
  const actionsOpacityBefore = await computedProp(app, actionsSelector, 'opacity')
  const nameRectBefore = (await app.rect(`[data-repo-toggle="${repo.root}"] .repo-row-name`)).rect

  const repoRowRect = (await app.rect(`[data-repo-toggle="${repo.root}"]`)).rect
  // 먼저 **행 바깥**으로 한 번 뺐다가 들어간다 — 포인터가 이미 목표 좌표에 있으면 mouseMove 가
  // 상태 전이를 안 만들어 mouseenter 가 안 뜬다. 그리고 고정 sleep 대신 opacity 가 실제로
  // 바뀔 때까지 기다린다(250ms 로는 앱 기동 직후 첫 상호작용에서 놓친 적이 있다).
  await app.send({ cmd: 'raw-mouse', type: 'mouseMove', x: 5, y: Math.round(repoRowRect.top + 400) })
  await sleep(120)
  await app.send({
    cmd: 'raw-mouse',
    type: 'mouseMove',
    x: Math.round(repoRowRect.left + repoRowRect.width / 2),
    y: Math.round(repoRowRect.top + repoRowRect.height / 2),
  })
  await until(async () => (await computedProp(app, actionsSelector, 'opacity')) === '1', {
    timeoutMs: 5000,
    everyMs: 100,
    what: 'RepoRow hover actions opacity -> 1',
  })
  const actionsOpacityHover = await computedProp(app, actionsSelector, 'opacity')
  const actionsRectHover = (await app.rect(actionsSelector)).rect
  const nameRectHover = (await app.rect(`[data-repo-toggle="${repo.root}"] .repo-row-name`)).rect
  // hover 를 뗀다 — 이후 측정이 hover 상태에 오염되지 않게.
  await app.send({ cmd: 'raw-mouse', type: 'mouseMove', x: 5, y: Math.round(repoRowRect.top + 400) })
  await sleep(200)

  const ruleHoverActions = {
    label: 'c_rule3_repoRowHoverActions',
    opacityBeforeHover: actionsOpacityBefore,
    opacityOnHover: actionsOpacityHover,
    rectBeforeHover: actionsRectBefore,
    rectOnHover: actionsRectHover,
    // 레이아웃 점유: hover 전에도 폭이 0 이 아니고, hover 전/후 레포 이름의 x 위치가 안 밀린다.
    occupiesLayoutWhileHidden: actionsRectBefore !== null && actionsRectBefore.width > 0,
    nameDidNotShift: nameRectBefore !== null && nameRectHover !== null && Math.abs(nameRectHover.width - nameRectBefore.width) <= 0.5,
    nameRectBefore,
    nameRectHover,
    pass: null,
    reason: 'handoff §2 RepoRow 표 — 기본 opacity:0(레이아웃 점유 유지), hover 시 opacity:1. hover 는 raw-mouse mouseMove 로 실제 좌표에 만들고 computedStyle/rect 실측으로 잰다.',
  }
  ruleHoverActions.pass =
    actionsOpacityBefore === '0' &&
    actionsOpacityHover === '1' &&
    ruleHoverActions.occupiesLayoutWhileHidden &&
    ruleHoverActions.nameDidNotShift

  // ---------- worktree 열기 ----------
  await app.click(`[data-worktree="${repo.root}"]`)
  const workspaceId = await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace?.workspaceId ?? null,
    { timeoutMs: 10000, what: 'worktree opened' },
  ).then((r) => r.value)

  // ---------- (c) 규칙 ① 탭바 표시 규칙 (C5′ 상시 렌더) — 1개일 때 **있음** → N개일 때도 있음 ----------
  // 옛 규칙은 "탭 1개면 DOM 부재"였다. 01-criteria.md 부록 C5′ 가 그것을 **개정**했다
  // (11-gate1-fix3.md I-5 — 원 근거였던 Orca 인용이 사실이 아니었다). 규칙을 약화한 게 아니라
  // 양쪽 상태 모두에서 **존재**를 요구하는 쪽으로 바뀐 것이다.
  const tabbarAtOne = (await app.query('[data-main-tabbar]')).found.length
  const tabsAtOne = (await tabsOf(app, repo.root)).length

  // ---------- (c) 규칙 ② AgentGroupHeader — 에이전트 2개에선 없음, 3개에서 등장 ----------
  const mixedTwo = await buildMixedFixture(app, repo.root, { agents: 2, shells: 2 })
  const tabbarAtMany = (await app.query('[data-main-tabbar]')).found.length
  const groupAtTwoAgents = (await app.query(`[data-agent-group="${repo.root}"]`)).found.length

  const mixedThree = await buildMixedFixture(app, repo.root, { agents: 3, shells: 2 })
  const groupAtThreeAgents = await until(async () => (await app.query(`[data-agent-group="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 6000,
    what: 'AgentGroupHeader mounted at 3 agent sessions',
  })

  const ruleTabBar = {
    label: 'c_rule1_tabBarAlwaysRendered',
    tabsAtOne,
    tabbarPresentAtOne: tabbarAtOne > 0,
    tabsAtMany: mixedThree.tabCount,
    tabbarPresentAtMany: tabbarAtMany > 0,
    pass: tabsAtOne === 1 && tabbarAtOne > 0 && mixedThree.tabCount >= 2 && tabbarAtMany > 0,
    supersedes: '옛 판정식 `tabsAtOne === 1 && tabbarAtOne === 0` (탭 1개면 부재)',
    reason:
      '01-criteria.md 부록 C5′ "활성 workspace 가 있으면 탭 수와 무관하게 렌더". 탭 1개일 때와 N개일 때 **둘 다 존재**함을 같은 실행에서 잰다. 탭 0개 경계는 herdr 허용 여부가 걸려 있어 C5 하네스(c5-tabbar.json zeroTabProbe)에서 따로 만들어 잰다. 여기서 탭 수는 **전체 탭**이다(부록 "세션 용어 확정" — 그 정의는 유효하고, 개정된 건 임계값 출처뿐).',
  }

  const ruleGroupHeader = {
    label: 'c_rule2_agentGroupHeaderAtThreeAgentSessions',
    atTwoAgents: { agentTabCount: mixedTwo.agentTabCount, totalTabCount: mixedTwo.tabCount, groupHeaderPresent: groupAtTwoAgents > 0 },
    atThreeAgents: { agentTabCount: mixedThree.agentTabCount, totalTabCount: mixedThree.tabCount, groupHeaderPresent: groupAtThreeAgents.ok },
    pass: mixedTwo.agentTabCount === 2 && groupAtTwoAgents === 0 && mixedThree.agentTabCount === 3 && groupAtThreeAgents.ok,
    reason: 'handoff §2 AgentGroupHeader "세션 3개 이상일 때". 01-criteria.md 부록대로 여기 "세션"은 **에이전트 세션**이라, 셸 탭을 섞어 전체 탭은 이미 3개를 넘긴 상태에서 에이전트만 2→3 으로 올려 임계값이 에이전트 수에 걸리는 것을 본다.',
  }

  // ---------- (a) 색 8개 — 실행 중 getComputedStyle 실측 ----------
  const sidebarBg = await computedProp(app, '[data-sidebar]', 'background-color')
  const mainAreaBg = await computedProp(app, '[data-main-area]', 'background-color')
  const selectedBg = await computedProp(app, '.worktree-block.is-selected', 'background-color')
  await until(async () => (await app.query('.worktree-block.is-selected .worktree-dot.tone-accent')).found.length > 0, {
    timeoutMs: 5000,
    what: 'selected worktree dot renders accent tone',
  })
  const accentBg = await computedProp(app, '.worktree-block.is-selected .worktree-dot', 'background-color')
  const statusbarBg = await computedProp(app, '[data-statusbar]', 'background-color')
  const repoNameColor = await computedProp(app, `[data-repo-toggle="${repo.root}"] .repo-row-name`, 'color')
  const reposHeaderColor = await computedProp(app, '.repos-header-label', 'color')

  // 모달(raised)은 열어서 잰 뒤 닫는다 — DOM 에 없는 대상은 "있는 상태를 만들어서 잰다"(부록).
  await app.click(`[data-create-worktree="${repo.root}"]`)
  await until(async () => (await app.query('[data-create-worktree-modal]')).found.length > 0, { timeoutMs: 6000, what: 'create-worktree modal open' })
  const raisedBg = await computedProp(app, '[data-create-worktree-modal]', 'background-color')
  await app.click('[data-create-worktree-cancel]')
  await until(async () => (await app.query('[data-create-worktree-modal]')).found.length === 0, { timeoutMs: 5000, what: 'modal closed' })

  const colors = [
    colorCheck({ label: 'a1_sidebarBg', selector: '[data-sidebar]', prop: 'background-color', rendered: sidebarBg, truth: HANDOFF.colors.bgWindow, reason: '사이드바 배경 = --bg-window. 선행 결정 1 로 원안(#0e1011)에 복귀한 값 — 이 항목이 곧 복귀가 실제로 화면에 닿았다는 증거다.' }),
    colorCheck({ label: 'a2_mainAreaBg', selector: '[data-main-area]', prop: 'background-color', rendered: mainAreaBg, truth: HANDOFF.colors.bgSurface, reason: '메인/터미널 영역 = --bg-surface(#141718). a1 과 짝을 이뤄 배경 서열(사이드바가 더 어둡다)을 값으로 고정한다.' }),
    colorCheck({ label: 'a3_selectedWorktreeBlockBg', selector: '.worktree-block.is-selected', prop: 'background-color', rendered: selectedBg, truth: HANDOFF.colors.bgSelected, reason: 'handoff §2 WorktreeBlock 선택 상태 배경 --bg-selected.' }),
    colorCheck({ label: 'a4_accentDot', selector: '.worktree-block.is-selected .worktree-dot', prop: 'background-color', rendered: accentBg, truth: HANDOFF.colors.accent, reason: '선택된 블록의 상태 도트 = --accent.' }),
    colorCheck({ label: 'a5_statusBarBg', selector: '[data-statusbar]', prop: 'background-color', rendered: statusbarBg, truth: HANDOFF.colors.bgStatusbar, reason: 'handoff §2 StatusBar 배경 --bg-statusbar.' }),
    colorCheck({ label: 'a6_modalPanelBg', selector: '[data-create-worktree-modal]', prop: 'background-color', rendered: raisedBg, truth: HANDOFF.colors.bgRaised, reason: 'handoff §2 CreateWorktreeModal 패널 --bg-raised. 모달을 실제로 열어서 쟀다.' }),
    colorCheck({ label: 'a7_repoNameFg', selector: `[data-repo-toggle="${repo.root}"] .repo-row-name`, prop: 'color', rendered: repoNameColor, truth: HANDOFF.colors.fg, reason: 'handoff §2 RepoRow 이름 색 --fg — 주 텍스트 단.' }),
    colorCheck({ label: 'a8_reposHeaderFgMuted', selector: '.repos-header-label', prop: 'color', rendered: reposHeaderColor, truth: HANDOFF.colors.fgMuted, reason: 'handoff §2 ReposSectionHeader 라벨 --fg-muted — 보조 텍스트 단.' }),
  ]
  const colorPassCount = colors.filter((c) => c.matches === true).length

  // ---------- (b) 치수 6개 — 전부 rect 실측치가 pass 식에 들어간다 ----------
  const brandbarRect = (await app.rect('[data-brandbar]')).rect
  const tabbarRect = (await app.rect('[data-main-tabbar]')).rect
  const statusbarRect = (await app.rect('[data-statusbar]')).rect
  const repoRowRect2 = (await app.rect(`[data-repo-toggle="${repo.root}"]`)).rect
  const sessionRowRect = (await app.rect('[data-tab]')).rect
  const groupRowRect = (await app.rect(`[data-agent-group="${repo.root}"]`)).rect

  const dimensions = [
    dimCheck({ label: 'b1_brandbarHeight', selector: '[data-brandbar]', renderedPx: brandbarRect?.height, truth: HANDOFF.dims.brandbar, reason: 'handoff §2 SidebarBrandBar 38px — rect.height 실측.' }),
    dimCheck({ label: 'b2_tabbarHeight', selector: '[data-main-tabbar]', renderedPx: tabbarRect?.height, truth: HANDOFF.dims.tabbar, reason: 'handoff §2 MainTabBar 33px — 탭 2개 이상을 실제로 띄워 마운트시킨 뒤 rect.height 실측.' }),
    dimCheck({ label: 'b3_statusbarHeight', selector: '[data-statusbar]', renderedPx: statusbarRect?.height, truth: HANDOFF.dims.statusbar, reason: 'handoff §2 StatusBar 25px — rect.height 실측.' }),
    dimCheck({ label: 'b4_repoRowHeight', selector: `[data-repo-toggle="${repo.root}"]`, renderedPx: repoRowRect2?.height, truth: HANDOFF.dims.repoRow, reason: 'handoff §2 RepoRow 28px — rect.height 실측.' }),
    dimCheck({ label: 'b5_sessionRowHeight', selector: '[data-tab]', renderedPx: sessionRowRect?.height, truth: HANDOFF.dims.sessionRow, reason: 'handoff §2 SessionRow 21px — 에이전트 세션 행이 실제로 있는 상태에서 rect.height 실측.' }),
    dimCheck({ label: 'b6_groupRowHeight', selector: `[data-agent-group="${repo.root}"]`, renderedPx: groupRowRect?.height, truth: HANDOFF.dims.groupRow, reason: 'handoff §2 AgentGroupHeader 22px — 에이전트 세션 3개 상태에서 rect.height 실측.' }),
  ]
  const dimensionPassCount = dimensions.filter((d) => d.pass === true).length

  const shots = [await app.shot('c9-final')]
  const rawChain = app.rawChain()
  await app.stop()

  const structureRules = [ruleTabBar, ruleGroupHeader, ruleHoverActions]
  const structurePassCount = structureRules.filter((r) => r.pass === true).length

  const result = {
    criterion: 'C9 (01-criteria.md 본문, freeze v2) — design-handoff 정합성',
    switchedFrom: 'C9′ (Orca ground truth). 09-gate1-fix.md 선행 결정 1 로 그 축을 접었다 — 통과선을 낮춘 게 아니라 같은 freeze 문서 안의 다른 통과선으로 갈아탄 것이라 관문③ 위반이 아니다.',
    passLine: { colors: 5, dimensions: 3, structureRules: 3 },
    margin: { colorsMeasured: colors.length, dimensionsMeasured: dimensions.length, note: '부록 여유분 권고(색 7+·치수 4+) 이행' },
    colors,
    colorPassCount,
    dimensions,
    dimensionPassCount,
    structureRules,
    structurePassCount,
    allPass: colorPassCount >= 5 && dimensionPassCount >= 3 && structurePassCount === 3,
    knownDeviations: [
      {
        item: '리사이저 폭',
        handoff: '--resizer-w: 3px (§4 "리사이저 3px")',
        corral: '--resizer-hit-w: 12px (비가시 히트존) + --resizer-line-w: 1px (가시선)',
        reason: '09-gate1-fix.md A 에서 유지 결정 — 보이는 선은 오히려 얇아지고(1px<3px) 집기는 쉬워진다. **의도적 편차이므로 (b) 일치 개수에 넣지 않는다**(부록 규칙).',
      },
    ],
    shots,
    rawChain,
  }
  console.log(JSON.stringify(result, null, 2))
  writeRaw('c9-handoff-parity.json', result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
