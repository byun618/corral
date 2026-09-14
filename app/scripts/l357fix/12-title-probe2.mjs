// H-4(개정) 1단계 재실측 — `PaneRow.title` 이 정말 쓸 수 없는 소스인가.
//
// 1회차(`raw/gate1-fix/c-title-probe.json`)는 두 겹으로 결함이 있었다. 이 스크립트는 그 두 개를
// 정확히 겨냥한다:
//
//   1회차 결함 ① 에이전트를 띄우고 **일을 안 시켰다** → 제목이 `'claude'` 에 머물렀다.
//     → B 단계에서 실제 프롬프트를 넣고 작업 전/중/후 제목을 **연속 샘플링**한다.
//   1회차 결함 ② OSC 주입이 **claude TUI 입력창으로 들어갔다**(`01-title-probe.mjs:103` 이
//     `tabs[0]` 을 셸로 가정했는데 그게 에이전트 탭이었다).
//     → 타이핑 전에 **어느 pane 의 터미널이 실제로 붙어 있는지 확인**하고(`assertFocusedPane`),
//       타이핑 후 `term-read` 로 그 화면에 글자가 찍혔는지까지 확인한다. 표적 확인 없는
//       타이핑은 증거가 아니다.
//
// 파서는 여기서 만들지 않는다 — 이 스크립트는 **관측만** 한다. 접두사 처리는 관측된 형식을
// 보고 나서 정한다(10-gate1-fix2.md H-4 "관측 안 된 형식을 미리 처리하지 마라").
import { createTab, makeScratchRepo, sleep, startApp, tabsOf, until, writeRaw } from './lib.mjs'

const OSC_PROBE = 'PROBE-TITLE'

async function panesOf(app, worktreePath) {
  const tabs = await tabsOf(app, worktreePath)
  return tabs.flatMap((tab) =>
    tab.panes.map((pane) => ({
      tabId: tab.tabId,
      number: tab.number,
      paneId: pane.paneId,
      agent: pane.agent,
      title: pane.title,
      cwd: pane.cwd,
      isAgentTab: tab.panes.some((p) => p.agent !== null),
    })),
  )
}

async function titleOf(app, worktreePath, paneId) {
  const panes = await panesOf(app, worktreePath)
  return panes.find((p) => p.paneId === paneId)?.title ?? null
}

/**
 * **표적 확인** — 1회차가 빠뜨린 단계. 화면에 붙어 있는 `.term-host` 가 우리가 노린 pane 인지
 * 보고 나서야 타이핑한다. 아니면 어디에 쳤는지 모르는 채로 "제목이 안 바뀐다"는 결론이 나온다.
 */
async function assertFocusedPane(app, paneId) {
  const hosts = (
    await app.send({
      cmd: 'eval',
      code: "[...document.querySelectorAll('.term-host')].map((el) => el.getAttribute('data-term-pane'))",
    })
  ).result
  const clicked = await app.send({ cmd: 'term-click', fx: 0.5, fy: 0.85 })
  await sleep(250)
  return { mountedTermHosts: hosts, targetPaneId: paneId, targetIsOnlyMountedHost: hosts.length === 1 && hosts[0] === paneId, termClick: clicked }
}

/** 터미널 화면을 **읽을 수 있는 텍스트**로 — `term-read` 는 rows 배열을 준다(JSON 을 그대로
 *  자르면 중간이 잘려 아무 검사도 못 한다. 1차 실행에서 실제로 그랬다). */
async function screenText(app) {
  const r = await app.send({ cmd: 'term-read' }).catch(() => null)
  const lines = r?.term?.lines ?? r?.term?.rows ?? null
  if (!Array.isArray(lines)) return null
  return lines
    .map((line) => String(line).trimEnd())
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * Claude Code 는 처음 보는 폴더에서 **신뢰 확인 화면**을 띄우고, 기본 선택이 `❯ No, exit` 다.
 * 여기서 그냥 Enter 를 치면 claude 가 **종료된다** — 1차 실행에서 실제로 그렇게 죽었고,
 * 1회차 프로브가 제목을 `'claude'` 로 본 것도 claude 가 내내 이 화면에 서 있었기 때문이다.
 * 아래로 한 칸 내려 `Yes, I trust this folder` 를 고른다.
 */
async function passTrustPrompt(app) {
  const seen = await until(async () => ((await screenText(app)) ?? '').includes('trust this folder'), {
    timeoutMs: 60000,
    everyMs: 1000,
    what: 'claude trust prompt visible',
  })
  if (!seen.ok) return { trustPromptSeen: false, screenBefore: await screenText(app), accepted: null }
  const screenBefore = await screenText(app)
  await app.key('Down')
  await sleep(300)
  await app.key('Return')
  const gone = await until(async () => !((await screenText(app)) ?? '').includes('trust this folder'), {
    timeoutMs: 30000,
    everyMs: 500,
    what: 'trust prompt dismissed',
  })
  return { trustPromptSeen: true, screenBefore, accepted: gone.ok, screenAfter: await screenText(app) }
}

/** 제목이 바뀌는 것을 **연속 샘플링**한다 — 한 번 찍고 마는 1회차 방식으로는 과도 상태를 놓친다. */
async function sampleTitles(app, worktreePath, paneId, { forMs, everyMs = 500, label }) {
  const startedAt = Date.now()
  const timeline = []
  let last = Symbol('none')
  while (Date.now() - startedAt < forMs) {
    const title = await titleOf(app, worktreePath, paneId)
    if (title !== last) {
      timeline.push({ atMs: Date.now() - startedAt, title })
      last = title
    }
    await sleep(everyMs)
  }
  return { label, forMs, distinctTitles: timeline.length, timeline }
}

async function main() {
  const repo = makeScratchRepo('title-probe2')
  const app = await startApp({ name: '12-title-probe2' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, { timeoutMs: 10000, what: 'worktree row mounted' })
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace != null, {
    timeoutMs: 20000,
    what: 'workspace opened',
  })

  const out = { what: 'H-4(개정) 1단계 — PaneRow.title 재실측 (OSC 전파 + 에이전트 작업 중 제목)', repo: repo.root }

  // ================= A. 셸 pane 에 OSC 제목을 쏜다 =================
  // 탭바는 세션 2개 이상에서만 존재한다(C5) — 셸 탭을 2개 만들어 탭바 진입점을 확보한다.
  for (let i = 0; i < 2; i++) {
    const before = (await tabsOf(app, repo.root)).length
    await createTab(app, repo.root, 'shell')
    await until(async () => (await tabsOf(app, repo.root)).length > before, { timeoutMs: 15000, everyMs: 200, what: `shell tab ${i + 1}` })
  }
  const shellPanes = (await panesOf(app, repo.root)).filter((p) => !p.isAgentTab)
  const shellTarget = shellPanes.slice(-1)[0]

  await app.click(`[data-main-tab="${shellTarget.tabId}"]`)
  await sleep(600)
  const shellFocus = await assertFocusedPane(app, shellTarget.paneId)
  // 셸이 프롬프트를 그릴 때까지 기다린다 — 준비 전에 치면 키가 버려진다(3차 실행이 그랬다).
  // zsh 가 자기 OSC 제목을 먼저 쓰므로 제목이 pane id 에서 바뀌는 것이 준비 신호다.
  const shellReady = await until(async () => (await titleOf(app, repo.root, shellTarget.paneId)) !== shellTarget.title, {
    timeoutMs: 20000,
    everyMs: 200,
    what: 'shell prompt drawn (title left pane-id)',
  })
  const shellTitleBefore = await titleOf(app, repo.root, shellTarget.paneId)
  const shellTermBefore = await screenText(app)

  // `; sleep 5` 가 핵심이다 — printf 만 보내면 zsh 가 **바로 다음 프롬프트에서 자기 제목으로
  // 되덮어** 관측 창이 밀리초 단위로 닫힌다. sleep 동안 프롬프트가 안 그려져 제목이 남는다.
  await app.send({ cmd: 'type', text: `printf '\\033]0;${OSC_PROBE}\\007'; sleep 5\n` })
  // **연속 샘플링**으로 잡는다 — zsh 는 다음 프롬프트를 그릴 때 자기 OSC 제목
  // (`user@host:경로`)으로 **되덮는다**. 타이핑 뒤에 한 번만 읽으면 그 되덮은 값만 보고
  // "안 바뀌었다"는 반대 결론이 난다(2차 실행에서 실제로 그랬다).
  const shellSampling = await sampleTitles(app, repo.root, shellTarget.paneId, { forMs: 12000, everyMs: 120, label: 'after-osc-printf' })
  const shellTitleAfter = await titleOf(app, repo.root, shellTarget.paneId)
  const shellTermAfter = await screenText(app)
  const sawProbeTitle = shellSampling.timeline.some((t) => t.title === OSC_PROBE)

  out.stepA_oscPropagation = {
    goal: '셸 pane 에 printf OSC 를 보내 PaneRow.title 이 바뀌는지 — herdr 제목 전파의 결정적 증거',
    targetPane: { tabId: shellTarget.tabId, paneId: shellTarget.paneId, agent: shellTarget.agent },
    // 표적 확인 — 1회차는 이걸 안 해서 claude TUI 에 타이핑했다.
    focus: shellFocus,
    shellPromptReady: shellReady.ok,
    titleBefore: shellTitleBefore,
    sampling: shellSampling,
    sawProbeTitle,
    titleAtEnd: shellTitleAfter,
    // 끝 값이 셸 프롬프트로 돌아오는 것은 **정상**이다 — zsh 가 프롬프트마다 제목을 다시 쓴다.
    overwrittenByShellPrompt: sawProbeTitle && shellTitleAfter !== OSC_PROBE,
    termTailBefore: shellTermBefore,
    termTailAfter: shellTermAfter,
    keystrokesLandedInTargetTerm: (shellTermAfter ?? '').includes('printf'),
    pass: null,
  }
  // 제목이 우리가 보낸 리터럴(`PROBE-TITLE`)로 **한 번이라도** 바뀐 것이 결정적 증거다 —
  // 그 문자열은 이 printf 말고는 나올 데가 없다.
  out.stepA_oscPropagation.pass = sawProbeTitle && out.stepA_oscPropagation.keystrokesLandedInTargetTerm
  console.log('[A] osc propagation', {
    titleBefore: shellTitleBefore,
    sawProbeTitle,
    titleAtEnd: shellTitleAfter,
    pass: out.stepA_oscPropagation.pass,
  })
  writeRaw('title-probe2.json', out)

  // ================= B. 에이전트에게 실제 일을 시킨다 =================
  // 표적을 `pane.agent !== null` 로 잡지 않는다 — herdr 의 에이전트 감지는 늦게 붙고 실제로
  // 한 번 놓쳤다. **새로 생긴 탭**으로 잡고, `pane.agent` 가 붙었는지는 따로 기록만 한다.
  const idsBefore = new Set((await tabsOf(app, repo.root)).map((t) => t.tabId))
  await createTab(app, repo.root, 'claude')
  const newTabSeen = await until(async () => (await tabsOf(app, repo.root)).some((t) => !idsBefore.has(t.tabId)), {
    timeoutMs: 30000,
    everyMs: 300,
    what: 'agent tab created',
  })
  const agentTab = (await tabsOf(app, repo.root)).find((t) => !idsBefore.has(t.tabId)) ?? null
  const agentPane = agentTab?.panes[0] ?? null

  if (agentPane === null) {
    out.stepB_agentTitle = { goal: 'claude 에게 실제 작업을 시키고 제목을 본다', newTabSeen: newTabSeen.ok, reason: '에이전트 탭이 안 생겼다 — B 단계 측정 불가', pass: false }
  } else {
    await app.click(`[data-main-tab="${agentTab.tabId}"]`)
    await sleep(800)
    const agentFocus = await assertFocusedPane(app, agentPane.paneId)
    // ① 신뢰 확인 화면을 통과한다 — 이걸 안 하면 Enter 가 `No, exit` 를 골라 claude 가 죽는다.
    const trust = await passTrustPrompt(app)
    // ② 입력창이 실제로 준비될 때까지 — 준비 전에 치면 프롬프트가 먹힌다.
    const tuiReady = await until(async () => /shortcuts|Welcome|\bTips\b/.test((await screenText(app)) ?? ''), {
      timeoutMs: 60000,
      everyMs: 1000,
      what: 'claude prompt box ready',
    })
    await sleep(3000)
    const agentAttached = (await panesOf(app, repo.root)).find((p) => p.paneId === agentPane.paneId)?.agent ?? null
    const titleBeforeWork = await titleOf(app, repo.root, agentPane.paneId)
    const termBeforeWork = await screenText(app)

    // 간단한 작업 1개 — 스크래치 레포의 README 를 읽게 한다(도구를 실제로 쓰게 해야 제목이 움직인다).
    await app.send({ cmd: 'type', text: 'README.md 를 읽고 그 내용을 요약한 SUMMARY.md 를 만들어줘' })
    await sleep(700)
    await app.key('Return')

    const during = await sampleTitles(app, repo.root, agentPane.paneId, { forMs: 100000, everyMs: 150, label: 'during-and-after-work' })
    const titleAfter = await titleOf(app, repo.root, agentPane.paneId)
    const termAfterWork = await screenText(app)

    out.stepB_agentTitle = {
      goal: 'claude 에게 실제 작업을 시키고 작업 전/중/후 PaneRow.title 을 연속 샘플링한다',
      targetPane: { tabId: agentTab.tabId, paneId: agentPane.paneId, agentFlag: agentAttached },
      focus: agentFocus,
      trustPrompt: trust,
      tuiReady: tuiReady.ok,
      titleBeforeWork,
      titleAfterWork: titleAfter,
      sampling: during,
      titleChangedDuringWork: during.distinctTitles > 1,
      distinctTitlesObserved: [...new Set(during.timeline.map((t) => t.title))],
      termTailBeforeWork: termBeforeWork,
      termTailAfterWork: termAfterWork,
      // 화면 텍스트로 "프롬프트가 닿았나"를 보는 건 못 미덥다 — claude TUI 가 다시 그리면서
      // 스크롤아웃된다(3차 실행에서 실제로 false 가 났다). **제목이 작업 라벨로 바뀌었는가**가
      // 더 강한 증거다: 유휴 기본값·셸 제목·pane ID 중 어느 것도 아닌 값이 나왔다는 뜻이다.
      workLabelObserved: during.timeline.some(
        (t) =>
          typeof t.title === 'string' &&
          t.title.trim().length > 0 &&
          !/^w[A-Za-z0-9]+:p\d+$/.test(t.title.trim()) &&
          !/^\S+@\S+:\//.test(t.title.trim()) &&
          !['claude', 'claude code'].includes(t.title.trim().toLowerCase()),
      ),
      screenTextMentionsTask: (termAfterWork ?? '').includes('README') || (termAfterWork ?? '').includes('SUMMARY'),
      // claude 가 살아서 끝냈는가 — 죽었으면 셸 프롬프트로 돌아온다(1차 실행이 그랬다).
      agentSurvived: !/trust this folder/.test(termAfterWork ?? '') && !(titleAfter ?? '').startsWith('byun@'),
      pass: null,
    }
    out.stepB_agentTitle.pass = out.stepB_agentTitle.titleChangedDuringWork && out.stepB_agentTitle.workLabelObserved && out.stepB_agentTitle.agentSurvived
    console.log('[B] agent title', {
      titleBeforeWork,
      distinct: out.stepB_agentTitle.distinctTitlesObserved,
      survived: out.stepB_agentTitle.agentSurvived,
      pass: out.stepB_agentTitle.pass,
    })
  }

  const shot = await app.shot('title-probe2-final')
  out.shots = [shot]
  out.rawChain = app.rawChain()
  out.clickLog = app.clickLog()
  writeRaw('title-probe2.json', out)
  await app.stop()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
