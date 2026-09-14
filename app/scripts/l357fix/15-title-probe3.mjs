// I-3 — 실행 중인 앱에서 세션 제목을 **다시 수집**한다 (11-gate1-fix3.md I-3).
//
// fix2 에서 `PaneRow.title` 채택은 이미 끝났다(H-4). 여기서 할 일은 두 가지뿐이다:
//   ① 에이전트 세션(작업 중·유휴)과 셸 세션의 제목을 실제로 찍어 남긴다.
//   ② 그중 `session-title.ts` 가 **아직 못 거르는 형식이 실제로 나왔으면** 그것만 추가한다.
//
// ⚠ Orca 의 거절 필터 전체를 이식하지 않는다(`Terminal N`·상태어·정체성 에코·스피너 접두사).
// `session-title.ts` 의 원칙이 *"관측 안 된 형식을 미리 처리하지 마라"* 이고 그게 맞다.
//
// **판정 근거는 DOM 이다.** 필터 로직을 이 스크립트에 복제하면 코드가 코드를 검증하는 꼴이라,
// 원자료 `pane.title` 과 **화면에 실제로 렌더된 라벨**(`.session-row-title` · `.main-tab-label`)을
// 짝지어 기록하고, 렌더된 라벨이 거절했어야 할 형식인지를 본다.
import { buildMixedFixture, createTab, makeScratchRepo, sleep, startApp, tabsOf, until, writeRaw } from './lib.mjs'

const WORK_PROMPT = 'NOTES.md 파일을 만들고 첫 줄에 hello 라고 써줘'

async function screenText(app) {
  const r = await app.send({ cmd: 'term-read' })
  const term = r.term ?? {}
  return (term.lines ?? term.rows ?? []).join('\n')
}

/**
 * **표적 확인** — 화면에 붙어 있는 터미널이 우리가 노린 pane 인지 보고 나서야 타이핑한다.
 * 이 단계를 빼면 어디에 쳤는지 모르는 채로 "제목이 안 바뀐다"는 결론이 나온다.
 * (fix2 1회차가 정확히 그 결함이었고, 이 스크립트 1차 실행도 같은 함정에 빠졌다 —
 *  타이핑이 에이전트 pane 에 가지 않아 claude 가 신뢰 화면에 계속 서 있었다.)
 */
async function assertFocusedPane(app, paneId) {
  const hosts = (await app.send({ cmd: 'eval', code: "[...document.querySelectorAll('.term-host')].map((el) => el.getAttribute('data-term-pane'))" })).result
  return { mountedPanes: hosts, focusedIsTarget: hosts.length === 1 && hosts[0] === paneId }
}

/** 신뢰 확인 화면은 기본 선택이 `No, exit` 이라 그냥 Enter 를 치면 claude 가 죽는다(fix2 에서 겪음). */
async function passTrustPrompt(app) {
  const seen = await until(async () => (await screenText(app)).includes('trust this folder'), {
    timeoutMs: 60000, everyMs: 1000, what: 'claude trust prompt',
  }).catch(() => ({ ok: false }))
  if (!seen.ok) return { trustPromptSeen: false, accepted: null }
  await app.key('Down')
  await sleep(300)
  await app.key('Return')
  const gone = await until(async () => !(await screenText(app)).includes('trust this folder'), {
    timeoutMs: 30000, everyMs: 500, what: 'trust prompt dismissed',
  }).catch(() => ({ ok: false }))
  return { trustPromptSeen: true, accepted: gone.ok }
}

/** 원자료 제목 ↔ 화면 라벨을 tabId 로 짝짓는다. */
async function collect(app, worktreePath, label) {
  const tabs = await tabsOf(app, worktreePath)
  const rendered = (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const rows = {}
        for (const el of document.querySelectorAll('[data-tab]')) rows[el.getAttribute('data-tab')] = el.querySelector('.session-row-title')?.textContent ?? null
        const tabsBar = {}
        for (const el of document.querySelectorAll('[data-main-tab]')) tabsBar[el.getAttribute('data-main-tab')] = el.querySelector('.main-tab-label')?.textContent ?? null
        return { rows, tabsBar }
      })()`,
    })
  ).result
  return {
    label,
    at: Date.now(),
    sessions: tabs.map((tab) => ({
      tabId: tab.tabId,
      number: tab.number,
      agent: tab.panes.find((p) => p.agent !== null)?.agent ?? null,
      agentStatus: tab.agentStatus,
      paneTitles: tab.panes.map((p) => p.title),
      sidebarLabel: rendered.rows[tab.tabId] ?? null,
      tabBarLabel: rendered.tabsBar[tab.tabId] ?? null,
    })),
  }
}

async function main() {
  const repo = makeScratchRepo('title-probe3')
  const app = await startApp({ name: '15-title-probe3' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, { timeoutMs: 8000, what: 'worktree row' })
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace != null, {
    timeoutMs: 20000, what: 'workspace opened',
  })

  // 셸 세션 — 탭바에는 뜨고 사이드바에는 안 뜬다(에이전트 세션만 나열).
  await createTab(app, repo.root, 'shell')
  await until(async () => (await tabsOf(app, repo.root)).length >= 2, { timeoutMs: 10000, what: 'shell tab' })
  const shellSnapshot = await collect(app, repo.root, 'shell-only')

  // 에이전트 세션 — 유휴 상태부터.
  await buildMixedFixture(app, repo.root, { agents: 1, shells: 1 })
  const agentTab = (await tabsOf(app, repo.root)).find((t) => t.panes.some((p) => p.agent !== null))
  const agentPane = agentTab?.panes.find((p) => p.agent !== null) ?? null
  // 에이전트 탭을 **화면에 붙인다** — 사이드바 세션 행 클릭(I-6 으로 고친 경로)을 그대로 쓴다.
  let focusCheck = null
  if (agentTab !== undefined) {
    await app.click(`[data-tab="${agentTab.tabId}"]`)
    await until(async () => (await assertFocusedPane(app, agentPane.paneId)).focusedIsTarget, { timeoutMs: 15000, what: '에이전트 pane 이 화면에 붙음' }).catch(() => ({ ok: false }))
    focusCheck = await assertFocusedPane(app, agentPane.paneId)
  }
  const trust = agentPane === null ? null : await passTrustPrompt(app)
  await sleep(3000)
  const idleSnapshot = await collect(app, repo.root, 'agent-idle')
  idleSnapshot.screen = (await screenText(app)).split('\n').filter((l) => l.trim().length > 0).slice(0, 12)

  // 에이전트에게 **실제로 일을 시킨다** — fix2 에서 배운 것: 일을 안 시키면 유휴 기본값에 머문다.
  let workingSnapshot = null
  let afterSnapshot = null
  if (agentPane !== null && focusCheck?.focusedIsTarget === true) {
    await app.send({ cmd: 'type', text: WORK_PROMPT })
    await sleep(400)
    await app.key('Return')
    // 제목이 유휴 기본값에서 벗어나는 순간을 잡는다.
    const changed = await until(
      async () => {
        const tabs = await tabsOf(app, repo.root)
        const t = tabs.find((x) => x.tabId === agentTab.tabId)
        const title = t?.panes[0]?.title ?? ''
        return title.length > 0 && title.toLowerCase() !== 'claude code' && title.toLowerCase() !== 'claude'
      },
      { timeoutMs: 90000, everyMs: 150, what: '작업 중 제목으로 바뀜' },
    ).catch(() => ({ ok: false }))
    workingSnapshot = await collect(app, repo.root, 'agent-working')
    workingSnapshot.titleChanged = changed.ok
    workingSnapshot.screen = (await screenText(app)).split('\n').filter((l) => l.trim().length > 0).slice(0, 12)
    await sleep(20000)
    afterSnapshot = await collect(app, repo.root, 'agent-after-work')
  }

  const shot = await app.shot('title-probe3')
  await app.stop()

  const snapshots = [shellSnapshot, idleSnapshot, workingSnapshot, afterSnapshot].filter((s) => s !== null)

  // ---------- 거절 목록이 놓친 형식이 렌더됐는가 ----------
  // 현행 거절 목록(session-title.ts): pane ID(`wG:p3`) · 셸 프롬프트(`user@host:/...`) ·
  // 유휴 기본값(에이전트 이름 · `Claude Code`). 렌더된 라벨이 이 형식이면 **필터가 샌 것**이다.
  const PANE_ID = /^w[A-Za-z0-9]+:p\d+$/
  const SHELL_PROMPT = /^\S+@\S+:\//
  const leaks = []
  for (const snap of snapshots) {
    for (const s of snap.sessions) {
      for (const [where, label] of [['sidebar', s.sidebarLabel], ['tabbar', s.tabBarLabel]]) {
        if (label === null) continue
        const t = label.trim()
        const why = PANE_ID.test(t)
          ? 'pane ID 가 그대로 렌더됨'
          : SHELL_PROMPT.test(t)
            ? '셸 프롬프트(절대경로)가 그대로 렌더됨'
            : t.toLowerCase() === 'claude code' || (s.agent !== null && t.toLowerCase() === s.agent.toLowerCase())
              ? '유휴 기본값이 그대로 렌더됨'
              : null
        if (why !== null) leaks.push({ snapshot: snap.label, tabId: s.tabId, where, label: t, why })
      }
    }
  }

  // 관측된 **원자료** 제목 중 현행 필터가 거르는 것과 안 거르는 것을 그대로 나열한다 —
  // 새 형식을 추가할지 판단하는 근거다.
  const observedPaneTitles = [...new Set(snapshots.flatMap((s) => s.sessions.flatMap((x) => x.paneTitles)).filter((t) => t !== null))]

  const out = {
    what: 'I-3 — 실행 중 앱에서 세션 제목 재수집 (원자료 pane.title ↔ 화면 렌더 라벨)',
    workPrompt: WORK_PROMPT,
    trust,
    focusCheck,
    snapshots,
    observedPaneTitles,
    leaks,
    checks: {
      // ⓐ 에이전트가 일하면 작업 설명이 제목에 온다(fix2 H-4 재확인).
      workTitleObserved: workingSnapshot?.titleChanged === true,
      // 타이핑 표적이 맞았는가 — 이게 false 면 위 항목의 false 는 "제목이 안 바뀐다"가 아니라
      // "실험이 성립하지 않았다"는 뜻이다. 둘을 구분해서 남긴다.
      typedIntoAgentPane: focusCheck?.focusedIsTarget === true,
      // ⓑ 사이드바와 탭바가 같은 함수를 쓴다 — 같은 탭이면 라벨이 같아야 한다.
      sidebarMatchesTabBar: snapshots.every((snap) =>
        snap.sessions.every((s) => s.sidebarLabel === null || s.tabBarLabel === null || s.sidebarLabel === s.tabBarLabel),
      ),
      // ⓒ 거절 목록이 샌 곳이 없다.
      noLeaks: leaks.length === 0,
    },
    shots: [shot],
    rawChain: app.rawChain(),
    pass: null,
  }
  out.pass = out.checks.sidebarMatchesTabBar && out.checks.noLeaks
  console.log(JSON.stringify({ ...out, rawChain: undefined }, null, 2))
  writeRaw('title-probe3.json', out)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
