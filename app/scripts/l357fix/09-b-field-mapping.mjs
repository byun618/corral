// B — §2.5 필드 매핑 실측 (09-gate1-fix.md B). C9 의 색·치수·구조규칙으로는 **어떤 내용이
// 어떤 슬롯에 들어가는지**를 구조적으로 못 잡는다(01-criteria.md "C9/C9′ 검증 구멍"). 그 구멍을
// 이 스크립트가 메운다 — 렌더된 텍스트를 DOM 에서 직접 읽어 §2.5 표와 대조한다.
//
// fixture 브랜치 3종으로 leaf/풀네임 분리를 재는 게 핵심이다:
//   · `main`                     → leaf == 풀네임 → 2줄 미렌더, 블록 높이 축소
//   · `issue/LIFE-89`            → leaf `LIFE-89` ≠ 풀네임 → 2줄 렌더
//   · `LIFE-357-layout-redesign` → 슬래시 없음 → leaf == 풀네임 → 2줄 미렌더
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { agentTabsOf, buildMixedFixture, makeScratchRepo, startApp, tabsOf, until, writeRaw } from './lib.mjs'

async function blockText(app, worktreePath) {
  const r = await app.send({
    cmd: 'eval',
    code: `(() => {
      const block = document.querySelector('[data-worktree="${worktreePath}"]')
      if (block === null) return null
      const name = block.querySelector('.worktree-name')
      const sub = block.querySelector('.worktree-sub')
      const mark = block.querySelector('.worktree-mark')
      const rect = block.getBoundingClientRect()
      return {
        line1Text: name === null ? null : name.textContent,
        line1Title: name === null ? null : name.getAttribute('title'),
        line1DataAttr: name === null ? null : name.getAttribute('data-worktree-branch'),
        line2Present: sub !== null,
        line2Text: sub === null ? null : sub.textContent,
        markPresent: mark !== null,
        markText: mark === null ? null : mark.textContent,
        blockHeight: rect.height,
        emptyHintPresent: block.querySelector('.worktree-empty-hint') !== null,
        sessionRowCount: block.querySelectorAll('[data-tab]').length,
        sessionRowTitles: [...block.querySelectorAll('.session-row-title')].map((el) => el.textContent),
        sessionRowTimePresent: block.querySelector('.session-row-time') !== null,
      }
    })()`,
  })
  return r.result
}

async function main() {
  const repo = makeScratchRepo('b-field-mapping')
  // 브랜치 3종 fixture — 주 체크아웃(main) + linked worktree 2개.
  const wtRoot = path.join(repo.root, '.wt')
  fs.mkdirSync(wtRoot, { recursive: true })
  const slashed = path.join(wtRoot, 'issue-life-89')
  const flat = path.join(wtRoot, 'life-357-layout-redesign')
  execFileSync('git', ['-C', repo.root, 'worktree', 'add', '-b', 'issue/LIFE-89', slashed], { encoding: 'utf8' })
  execFileSync('git', ['-C', repo.root, 'worktree', 'add', '-b', 'LIFE-357-layout-redesign', flat], { encoding: 'utf8' })

  const app = await startApp({ name: '09-b-field-mapping' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, { timeoutMs: 8000, what: 'worktree rows mounted' })

  const state = await app.state()
  const worktrees = state.repos.flatMap((r) => r.worktrees).map((w) => ({ path: w.path, branch: w.branch, isLinked: w.isLinked }))

  // ---------- 1·2줄 매핑 ----------
  const blocks = {}
  for (const worktree of worktrees) blocks[worktree.branch ?? worktree.path] = { worktree, dom: await blockText(app, worktree.path) }

  const leafOf = (branch) => (branch.lastIndexOf('/') === -1 ? branch : branch.slice(branch.lastIndexOf('/') + 1))
  const lineMapping = Object.entries(blocks).map(([branch, { worktree, dom }]) => {
    const leaf = leafOf(branch)
    // H-2 — 중복이어도 2줄을 **항상** 그린다. 1회차의 "leaf 와 같으면 숨긴다"는 철회됐다.
    const expectLine2 = true
    return {
      branch,
      expectedLeaf: leaf,
      expectedLine2: expectLine2 ? branch : null,
      renderedLine1: dom?.line1Text ?? null,
      renderedLine2Present: dom?.line2Present ?? null,
      renderedLine2: dom?.line2Text ?? null,
      blockHeightPx: dom?.blockHeight ?? null,
      line1IsLeaf: dom?.line1Text === leaf,
      line2AlwaysRendered: dom?.line2Present === true && dom?.line2Text === branch,
      // §2.5 "절대경로는 행에 넣지 않는다" — 어느 행 텍스트에도 worktree 절대경로가 없어야 한다.
      noAbsolutePathInRows: !(dom?.line1Text ?? '').includes('/') && !(dom?.line2Text ?? '').includes(worktree.path),
      // 절대경로는 1줄 이름의 title 툴팁에서만 노출된다.
      tooltipIsAbsolutePath: dom?.line1Title === worktree.path,
      // data-worktree-branch 의 **값**은 하네스 위치 지정자 — 바뀌면 안 된다.
      dataAttrValueUnchanged: dom?.line1DataAttr === worktree.path,
      pass: null,
    }
  })
  for (const row of lineMapping) {
    row.pass = row.line1IsLeaf && row.line2AlwaysRendered && row.noAbsolutePathInRows && row.tooltipIsAbsolutePath && row.dataAttrValueUnchanged
  }

  // 블록 높이 비교 — 2줄 있는 블록이 없는 블록보다 실제로 높아야 한다(=높이 축소가 일어났다).
  const withLine2 = lineMapping.find((r) => r.renderedLine2Present === true)
  const withoutLine2 = lineMapping.find((r) => r.renderedLine2Present === false)
  // H-2 로 **높이 축소 규칙이 사라졌다** — 이제 모든 블록이 2줄이라 높이가 균일해야 한다.
  // (1회차는 여기서 45px vs 30px 를 쟀다. 그 통과선은 철회됐다.)
  const heights = lineMapping.map((row) => row.blockHeightPx)
  const heightRule = {
    heightsPx: Object.fromEntries(lineMapping.map((row) => [row.branch, row.blockHeightPx])),
    allTwoLine: lineMapping.every((row) => row.renderedLine2Present === true),
    uniformHeight: heights.every((h) => h !== null && Math.abs(h - heights[0]) < 0.5),
    note: 'H-2 — 중복이어도 2줄을 그리므로 블록 높이가 브랜치 이름과 무관하게 균일하다.',
    pass: null,
  }
  heightRule.pass = heightRule.allTwoLine && heightRule.uniformHeight

  // ---------- git 마크 0 숨김 (이미 충족 — 확인만, 09-gate1-fix.md B) ----------
  const cleanBlock = Object.values(blocks).find(({ dom }) => dom?.markPresent === false)
  const gitMarkHidden = {
    verifyOnly: true,
    source: 'app/src/renderer/src/git-marks.ts `gitMarkLabel` — parts.length === 0 이면 null',
    someBlockHasNoMark: cleanBlock !== undefined,
    blocks: Object.fromEntries(Object.entries(blocks).map(([b, { dom }]) => [b, { markPresent: dom?.markPresent, markText: dom?.markText }])),
    pass: cleanBlock !== undefined,
    note: '전부 0 인 fixture(갓 만든 scratch 레포)에서 마크 영역 자체가 DOM 에 없다. 지시대로 코드는 건드리지 않고 확인만 했다.',
  }

  // ---------- 세션 없는 worktree = 플레이스홀더 없음 ----------
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace !== null, {
    timeoutMs: 10000,
    what: 'main worktree opened',
  })
  const openedNoAgent = await blockText(app, repo.root)
  const noPlaceholder = {
    worktree: repo.root,
    totalTabs: (await tabsOf(app, repo.root)).length,
    agentTabs: agentTabsOf(await tabsOf(app, repo.root)).length,
    sessionRowCount: openedNoAgent?.sessionRowCount ?? null,
    emptyHintPresent: openedNoAgent?.emptyHintPresent ?? null,
    pass: openedNoAgent?.sessionRowCount === 0 && openedNoAgent?.emptyHintPresent === false,
    note: '열려 있고 셸 탭은 있지만 에이전트 세션이 0 인 worktree — 세션 행도 "세션 없음" 플레이스홀더도 없어야 한다(§2.5 명시 금지 + D).',
  }

  // ---------- 세션 제목 · 경과 시간 제거 ----------
  const fixture = await buildMixedFixture(app, repo.root, { agents: 2, shells: 2 })
  const withAgents = await blockText(app, repo.root)
  const tabs = await tabsOf(app, repo.root)
  const expectedTitles = agentTabsOf(tabs).map((tab) => {
    const agent = tab.panes.find((p) => p.agent !== null)?.agent ?? null
    return agent === null ? `세션 ${tab.number}` : `${agent} ${tab.number}`
  })
  const tabBarLabels = (await app.send({ cmd: 'eval', code: "[...document.querySelectorAll('.main-tab-label')].map((el) => el.textContent)" })).result
  const sidebarTitles = withAgents?.sessionRowTitles ?? []
  const sessionTitles = {
    expectedSidebarTitles: expectedTitles,
    renderedSidebarTitles: sidebarTitles,
    sidebarMatches: JSON.stringify(sidebarTitles) === JSON.stringify(expectedTitles),
    // C-3: 세션 제목이 곧 탭 제목 — 같은 함수를 공유하므로 사이드바 제목이 탭바 라벨의 부분집합이어야 한다.
    renderedTabBarLabels: tabBarLabels,
    sidebarTitlesAllPresentInTabBar: sidebarTitles.every((t) => (tabBarLabels ?? []).includes(t)),
    // §2.5 "pane 인덱스나 숫자만 단독 표시 금지"
    noBareNumberTitles: (tabBarLabels ?? []).every((t) => !/^\d+$/.test(String(t).trim())),
    // E — 경과 시간 칸은 제거됐다
    elapsedTimeRemoved: withAgents?.sessionRowTimePresent === false,
    pass: null,
  }
  sessionTitles.pass =
    sessionTitles.sidebarMatches &&
    sessionTitles.sidebarTitlesAllPresentInTabBar &&
    sessionTitles.noBareNumberTitles &&
    sessionTitles.elapsedTimeRemoved

  // ---------- worktree 정렬 — **이름 사전순 고정** ----------
  // 이전 회차는 여기서 "선택됨 → 열림 → 그 외" 등급 정렬을 쟀다. 그 규칙은 **철회됐다**
  // (04-result-gate1-fix.md §10 — 목업에 '활성이 위' 규칙이 없다는 코디네이터 실측).
  // 지금 규칙은 세션 상태에 의존하지 않는 이름 사전순이고, 세션을 열고 닫아도·재기동해도
  // 순서가 안 바뀐다는 본 증명은 `11-worktree-order.mjs` 가 한다. 여기서는 같은 fixture 로
  // 한 컷만 대조한다.
  const renderedOrder = (await app.send({
    cmd: 'eval',
    code: "[...document.querySelectorAll('[data-worktree]')].map((el) => el.getAttribute('data-worktree'))",
  })).result
  const stateNow = await app.state()
  const nameOf = (p) => {
    const w = stateNow.repos.flatMap((r) => r.worktrees).find((x) => x.path === p)
    return w === undefined ? p : (w.branch ?? w.path)
  }
  const renderedNames = renderedOrder.map(nameOf)
  // 기대 순서는 손으로 적지 않고 **렌더러와 같은 비교자**로 만든다 — localeCompare 는
  // 코드포인트 순이 아니라서 손으로 적으면 틀린다.
  const expectedNames = [...renderedNames].sort((a, b) => a.localeCompare(b))
  const stateArrayNames = stateNow.repos.flatMap((r) => r.worktrees).map((w) => w.branch ?? w.path)
  const sortRule = {
    renderedNames,
    expectedNames,
    stateArrayNames,
    matchesNameOrder: JSON.stringify(renderedNames) === JSON.stringify(expectedNames),
    // 렌더 순서가 herdr 배열 순서와 **달라야** 정렬이 실제로 돌고 있다는 증거가 된다
    // (같으면 "받은 순서 그대로"와 구분이 안 된다). fixture 생성 순서를 일부러 어긋나게 잡았다.
    differsFromStateArray: JSON.stringify(renderedNames) !== JSON.stringify(stateArrayNames),
    pass: null,
    note: '이름(branch ?? path) 사전순 고정. 세션 수·열림·선택은 정렬 키에 넣지 않는다 — 철회된 등급 정렬의 대체 규칙.',
  }
  sortRule.pass = sortRule.matchesNameOrder && sortRule.differsFromStateArray

  // ---------- 상태바 `{n} agents` — 지시서 밖 판단 1건의 렌더 증거 ----------
  const statusBarText = (await app.send({
    cmd: 'eval',
    code: "[...document.querySelectorAll('[data-statusbar] span')].map((el) => el.textContent)",
  })).result
  const selectedTabs = await tabsOf(app, repo.root)
  const statusBarAgents = {
    outOfScopeJudgement: true,
    renderedSpans: statusBarText,
    renderedAgentsSpan: (statusBarText ?? []).find((t) => String(t).endsWith(' agents')) ?? null,
    expectedAgentSessionCount: agentTabsOf(selectedTabs).length,
    totalTabCount: selectedTabs.length,
    // 옛 동작이면 전체 탭 수가 찍힌다 — 두 수가 다른 fixture 라야 이 검사가 의미를 갖는다.
    countsDiffer: agentTabsOf(selectedTabs).length !== selectedTabs.length,
    pass: null,
    note: '09-gate1-fix.md 에 없던 판단(04-result-gate1-fix.md §6-③). 코드·빌드만으로 주장하지 않고 렌더된 상태바 텍스트를 읽어 에이전트 세션 수와 대조한다.',
  }
  statusBarAgents.pass =
    statusBarAgents.renderedAgentsSpan === `${statusBarAgents.expectedAgentSessionCount} agents` && statusBarAgents.countsDiffer

  // ---------- App.tsx:193 확인만 — 탭바가 전체 탭을 받는가 ----------
  const tabBarReceivesAllTabs = {
    verifyOnly: true,
    source: 'app/src/renderer/src/App.tsx `tabs={activeWorkspace.tabs}`',
    totalTabs: fixture.tabCount,
    renderedTabBarTabs: (await app.query('[data-main-tab]')).found.length,
    pass: (await app.query('[data-main-tab]')).found.length === fixture.tabCount,
    note: '지시대로 코드는 건드리지 않고 확인만 했다.',
  }

  const shots = [await app.shot('b-field-mapping-final')]
  const rawChain = app.rawChain()
  await app.stop()

  const result = {
    criterion: 'B — design-handoff §2.5 필드 매핑 · 빈 값 규칙 (09-gate1-fix.md B)',
    worktrees,
    lineMapping,
    heightRule,
    gitMarkHidden,
    noPlaceholder,
    sessionTitles,
    sortRule,
    statusBarAgents,
    tabBarReceivesAllTabs,
    allPass:
      lineMapping.every((r) => r.pass) &&
      heightRule.pass &&
      gitMarkHidden.pass &&
      noPlaceholder.pass &&
      sessionTitles.pass &&
      sortRule.pass &&
      statusBarAgents.pass &&
      tabBarReceivesAllTabs.pass,
    shots,
    rawChain,
  }
  console.log(JSON.stringify(result, null, 2))
  writeRaw('b-field-mapping.json', result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
