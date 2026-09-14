// H-3 계층 분리 + H-5 접힘 요약 행 — **육안 대조용 스크린샷**과 여백 실측.
//
// 10-gate1-fix2.md: "계층 분리는 수치로 증명이 안 된다. 레포 2개 이상 · worktree 3개 이상 ·
// 세션 있는 것과 **없는 것**을 섞은 화면을 캡처". 코디네이터가 Orca 스크린샷과 눈으로 맞춘다.
// 수치는 보조 증거로 같이 남긴다 — 여백 **위계**(레포 > worktree > 세션)는 숫자로 확인 가능하다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { buildMixedFixture, makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

function addWorktree(repo, branch, dir) {
  const full = path.join(repo.root, '.wt', dir)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  execFileSync('git', ['-C', repo.root, 'worktree', 'add', '-b', branch, full], { encoding: 'utf8' })
  return fs.realpathSync(full)
}

/** 여백 위계를 숫자로 — 요소 사이 실제 간격을 rect 로 잰다. */
async function measureGaps(app) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const top = (el) => el.getBoundingClientRect().top
        const bottom = (el) => el.getBoundingClientRect().bottom
        const groups = [...document.querySelectorAll('.repo-row-group')]
        const blocks = [...document.querySelectorAll('.worktree-block')]
        const sessionRow = document.querySelector('[data-tab]')
        const worktreeName = document.querySelector('.worktree-name')
        // **레포 그룹 사이의 실제 시각적 간격** — 그룹의 padding-bottom 은 그룹 *안에* 있어서
        // 그룹 rect 끼리 빼면 늘 0 이 나온다(첫 측정이 그랬다). 앞 그룹의 마지막 내용물
        // (마지막 worktree 블록, 없으면 repo 행) 아래부터 다음 그룹의 repo 행 위까지를 잰다.
        const repoGaps = []
        for (let i = 1; i < groups.length; i++) {
          const prevBlocks = [...groups[i - 1].querySelectorAll('.worktree-block')]
          const prevLast = prevBlocks[prevBlocks.length - 1] ?? groups[i - 1].querySelector('.repo-row')
          const nextRow = groups[i].querySelector('.repo-row')
          if (prevLast === null || nextRow === null) continue
          repoGaps.push(Math.round((top(nextRow) - bottom(prevLast)) * 10) / 10)
        }
        // worktree 블록 사이 — 같은 레포 안에서 연속한 블록.
        const worktreeGaps = []
        for (const group of groups) {
          const gb = [...group.querySelectorAll('.worktree-block')]
          for (let i = 1; i < gb.length; i++) worktreeGaps.push(Math.round((top(gb[i]) - bottom(gb[i - 1])) * 10) / 10)
        }
        // 세션 행 사이 — 가장 작아야 하는 층.
        const rows = [...document.querySelectorAll('[data-tab]')]
        const sessionGaps = []
        for (let i = 1; i < rows.length; i++) sessionGaps.push(Math.round((top(rows[i]) - bottom(rows[i - 1])) * 10) / 10)
        return {
          repoGroupGapsPx: repoGaps,
          worktreeBlockGapsPx: worktreeGaps,
          sessionRowGapsPx: sessionGaps,
          // 세션 행이 worktree 이름보다 **안쪽**에서 시작하는가 (소속이 보이게).
          worktreeNameLeftPx: worktreeName === null ? null : Math.round(worktreeName.getBoundingClientRect().left),
          sessionTitleLeftPx: sessionRow === null ? null : Math.round(sessionRow.querySelector('.session-row-title')?.getBoundingClientRect().left ?? 0),
          repoCount: groups.length,
          worktreeBlockCount: blocks.length,
          sessionRowCount: document.querySelectorAll('[data-tab]').length,
        }
      })()`,
    })
  ).result
}

async function main() {
  // 레포 2개 — 하나는 세션이 있고, 하나는 **한 번도 안 연** 레포다(사용자 지시 4).
  const repoA = makeScratchRepo('hier-a')
  const repoB = makeScratchRepo('hier-b')
  const aaa = addWorktree(repoA, 'aaa-first', 'aaa')
  addWorktree(repoA, 'issue/LIFE-89', 'issue-life-89')
  addWorktree(repoB, 'ticket/012-blend-instance-only', 'ticket-012')

  const app = await startApp({ name: '13-hierarchy-shot' })
  await app.addRepo(repoA.root)
  await app.addRepo(repoB.root)
  await until(async () => (await app.query('[data-worktree]')).found.length === 5, { timeoutMs: 12000, what: '5 worktree blocks mounted' })

  // 세션은 repoA 의 aaa-first 한 곳에만 — 나머지는 **세션 0개** 상태 그대로 둔다.
  await app.click(`[data-worktree="${aaa}"]`)
  await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === aaa)?.workspace != null, {
    timeoutMs: 20000,
    what: 'aaa-first opened',
  })
  const fixture = await buildMixedFixture(app, aaa, { agents: 3, shells: 1 })
  await until(async () => (await app.query(`[data-agent-group="${aaa}"]`)).found.length > 0, { timeoutMs: 10000, what: 'agent group header (3 agents)' })
  await sleep(1200)

  const expanded = await measureGaps(app)

  // 선택 카드가 **세션 행까지 통째로** 감싸는가 — 코디네이터 회귀 방지 항목.
  // H-3 여백을 넣다가 SessionRow 를 블록 밖으로 빼면 여기서 깨진다.
  const selectedCard = (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const card = document.querySelector('.worktree-block.is-selected')
        if (card === null) return null
        const r = card.getBoundingClientRect()
        const header = card.querySelector('[data-agent-group]')
        const rows = [...card.querySelectorAll('[data-tab]')]
        const line2 = card.querySelector('.worktree-block-line2')
        const last = rows[rows.length - 1] ?? null
        const cs = getComputedStyle(card)
        return {
          cardHeightPx: Math.round(r.height * 10) / 10,
          cardBottomPx: Math.round(r.bottom * 10) / 10,
          line2InsideCard: line2 !== null,
          groupHeaderInsideCard: header !== null,
          sessionRowsInsideCard: rows.length,
          lastSessionRowBottomPx: last === null ? null : Math.round(last.getBoundingClientRect().bottom * 10) / 10,
          lastRowWithinCard: last === null ? null : last.getBoundingClientRect().bottom <= r.bottom + 0.5,
          selectedBg: cs.backgroundColor,
          borderColor: cs.borderTopColor,
          marginTop: cs.marginTop,
          paddingBottom: cs.paddingBottom,
        }
      })()`,
    })
  ).result

  const shotExpanded = await app.shot('hierarchy-expanded')

  // ---------- H-5. 접힘 요약 행 ----------
  await app.click(`[data-agent-group="${aaa}"]`)
  const collapsed = await until(async () => (await app.query('[data-tab]')).found.length === 0, { timeoutMs: 6000, what: 'session rows gone (collapsed)' })
  const summaryPresent = await until(async () => (await app.query(`[data-agent-group-summary="${aaa}"]`)).found.length > 0, {
    timeoutMs: 6000,
    what: 'collapsed summary row present',
  })
  const summary = (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const el = document.querySelector('[data-agent-group-summary]')
        if (el === null) return null
        return {
          text: el.textContent,
          hiddenCountAttr: el.querySelector('[data-agent-group-hidden]')?.getAttribute('data-agent-group-hidden') ?? null,
          agentKind: el.querySelector('[data-agent-kind]')?.getAttribute('data-agent-kind') ?? null,
          // C3ⓑ 보호 — 요약 행이 세션 행으로 집계되면 안 된다.
          hasDataTab: el.hasAttribute('data-tab'),
          heightPx: Math.round(el.getBoundingClientRect().height * 10) / 10,
          groupHeaderStillPresent: document.querySelector('[data-agent-group]') !== null,
        }
      })()`,
    })
  ).result
  const shotCollapsed = await app.shot('hierarchy-collapsed')

  const out = {
    what: 'H-3 계층 분리(여백 위계) + H-5 접힘 요약 행 — 스크린샷 + 여백 실측',
    fixture: {
      repos: [repoA.root, repoB.root],
      worktreeCount: 5,
      // 세션이 **없는** worktree 가 섞여 있다 — 사용자 지시 4의 화면 조건.
      worktreesWithSessions: 1,
      tabCount: fixture.tabCount,
      agentTabCount: fixture.agentTabCount,
    },
    expanded,
    hierarchy: {
      repoGapPx: expanded.repoGroupGapsPx[0] ?? null,
      worktreeGapPx: expanded.worktreeBlockGapsPx[0] ?? null,
      sessionIndentDeltaPx:
        expanded.sessionTitleLeftPx === null || expanded.worktreeNameLeftPx === null ? null : expanded.sessionTitleLeftPx - expanded.worktreeNameLeftPx,
      sessionGapPx: expanded.sessionRowGapsPx[0] ?? null,
      // 통과선은 절대값이 아니라 **위계**다: 레포 간격 > worktree 간격 > 세션 간격.
      ladderHolds:
        (expanded.repoGroupGapsPx[0] ?? 0) > (expanded.worktreeBlockGapsPx[0] ?? 0) &&
        (expanded.worktreeBlockGapsPx[0] ?? 0) > (expanded.sessionRowGapsPx[0] ?? 0),
      sessionIndentedInsideWorktreeName:
        expanded.sessionTitleLeftPx !== null && expanded.worktreeNameLeftPx !== null && expanded.sessionTitleLeftPx > expanded.worktreeNameLeftPx,
    },
    // 선택 카드가 'worktree 2줄 + 그룹 헤더 + 세션 행'을 통째로 감싸는지 (회귀 방지).
    selectedCardEnvelope: {
      ...selectedCard,
      wrapsEverything:
        selectedCard !== null &&
        selectedCard.line2InsideCard &&
        selectedCard.groupHeaderInsideCard &&
        selectedCard.sessionRowsInsideCard >= 2 &&
        selectedCard.lastRowWithinCard === true,
    },
    collapsedSummary: {
      sessionRowsGone: collapsed.ok,
      summaryRowPresent: summaryPresent.ok,
      summary,
      // 요약 행이 `data-tab` 을 쓰지 않는 것이 C3ⓑ 통과선을 지키는 핵심이다.
      doesNotUseDataTab: summary?.hasDataTab === false,
      groupHeaderStillPresent: summary?.groupHeaderStillPresent === true,
    },
    shots: [shotExpanded, shotCollapsed],
    rawChain: app.rawChain(),
    clickLog: app.clickLog(),
    pass: null,
  }
  out.pass =
    out.selectedCardEnvelope.wrapsEverything &&
    out.hierarchy.ladderHolds &&
    out.hierarchy.sessionIndentedInsideWorktreeName &&
    out.collapsedSummary.sessionRowsGone &&
    out.collapsedSummary.summaryRowPresent &&
    out.collapsedSummary.doesNotUseDataTab &&
    out.collapsedSummary.groupHeaderStillPresent

  console.log(JSON.stringify({ hierarchy: out.hierarchy, selectedCardEnvelope: out.selectedCardEnvelope, collapsedSummary: { ...out.collapsedSummary, summary }, pass: out.pass }, null, 2))
  writeRaw('h3-h5-hierarchy.json', out)

  // 육안 대조용 스크린샷을 원자료 폴더 최상위로 복사한다 — `_runs/` 는 로그 보관용이라 묻힌다.
  for (const [label, shot] of [
    ['hierarchy-expanded.png', shotExpanded],
    ['hierarchy-collapsed.png', shotCollapsed],
  ]) {
    const from = path.isAbsolute(shot.file) ? shot.file : path.join(path.dirname(app.dir), '..', shot.file)
    const src = fs.existsSync(from) ? from : path.join(app.shotDir, path.basename(shot.file))
    if (fs.existsSync(src)) writeRaw(label, fs.readFileSync(src))
  }
  await app.stop()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
