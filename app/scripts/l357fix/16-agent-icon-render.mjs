// I-2 검산 — 브랜드 아이콘이 **세 종류 전부** 실제로 렌더되는가.
//
// 3회차 fixture 는 전부 claude 였다. 그래서 결과 문서 매핑표의 codex·grok 줄은 코드를 읽고
// 쓴 **주장**이지 관측이 아니었다(.agents/rules/validation.md "추측 기반 판정 금지").
// 여기서 네 종류(claude·codex·grok·shell) 탭을 실제로 띄우고 DOM 마크업을 읽어 판정한다.
//
// 판별식은 **마크업의 모양**이다 — `data-agent-kind` 문자열로 판정하면 아이콘이 안 그려져도
// 통과한다(측정 대상의 자기 신고를 근거로 쓰지 않는다).
//   · claude·codex → <svg> 안에 <path>   (브랜드 마크)
//   · grok        → <svg> 안에 <text>G   (글자 배지 — 명시적 편차)
//   · shell       → svg 없음, 텍스트 '$' (아이콘 아님)
//
// 에이전트 바이너리가 없어 pane.agent 가 안 붙는 종류가 있으면 **그 사실을 그대로 적는다**.
// 통과로 셈하지 않는다.
import { createTab, makeScratchRepo, sleep, startApp, tabsOf, until, writeRaw } from './lib.mjs'

const KINDS = ['claude', 'codex', 'grok', 'shell']

const SHAPE_FN = `(sel) => {
  const el = document.querySelector(sel)
  if (el === null) return null
  const svg = el.querySelector('svg')
  const box = el.getBoundingClientRect()
  return {
    html: el.innerHTML.slice(0, 200),
    hasSvg: svg !== null,
    pathCount: el.querySelectorAll('svg path').length,
    rectCount: el.querySelectorAll('svg rect').length,
    textInSvg: svg === null ? null : (svg.querySelector('text') ? svg.querySelector('text').textContent : null),
    // path 개수만으로는 claude 와 codex 가 둘 다 '1개'라 안 갈린다 — 마크 자체를 지문으로 쓴다.
    pathHead: el.querySelector('svg path') ? (el.querySelector('svg path').getAttribute('d') || '').slice(0, 24) : null,
    plainText: svg === null ? el.textContent : null,
    boxW: Math.round(box.width),
    boxH: Math.round(box.height),
    color: getComputedStyle(el).color,
  }
}`

async function shapeOf(app, selector) {
  return (await app.send({ cmd: 'eval', code: `(${SHAPE_FN})(${JSON.stringify(selector)})` })).result
}

function verdictFor(kind, shape) {
  if (shape === null) return { rendered: false, why: '칸 자체가 없다' }
  if (kind === 'grok') return { rendered: shape.hasSvg && shape.textInSvg === 'G', why: '글자 배지 <text>G</text>' }
  if (kind === 'shell') return { rendered: !shape.hasSvg && (shape.plainText ?? '').trim() === '$', why: '셸은 브랜드 아이콘 아님 — 글리프 $' }
  return { rendered: shape.hasSvg && shape.pathCount > 0, why: '브랜드 마크 <svg><path>' }
}

const repo = makeScratchRepo('icon-render')
const app = await startApp({ name: '16-agent-icon-render' })
try {
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 15000,
    what: 'worktree 행',
  })
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace != null,
    { timeoutMs: 20000, what: 'workspace 열림' },
  )

  const spawnLog = []
  const observed = {}
  for (const kind of KINDS) {
    const before = (await tabsOf(app, repo.root)).map((t) => t.tabId)
    await createTab(app, repo.root, kind)
    const grew = await until(async () => (await tabsOf(app, repo.root)).length > before.length, {
      timeoutMs: 25000,
      what: `${kind} 탭`,
    })
      .then(() => true)
      .catch(() => false)
    // pane.agent 는 herdr 가 **기동 후에** 붙인다. 1차 실행은 2.5초만 기다려 네 종류 전부
    // null 로 읽혔다 — 고정 sleep 이 아니라 부착을 기다린다.
    const attached = await until(
      async () => {
        const tabs = await tabsOf(app, repo.root)
        const t = tabs.find((x) => !before.includes(x.tabId))
        return t !== undefined && t.panes.some((p) => p.agent !== null)
      },
      { timeoutMs: 45000, what: `${kind} pane.agent 부착` },
    )
      .then(() => true)
      .catch(() => false)
    await sleep(600)
    const tabs = await tabsOf(app, repo.root)
    const tab = tabs.find((t) => !before.includes(t.tabId)) ?? null
    const paneAgent = tab?.panes.find((p) => p.agent !== null)?.agent ?? null
    spawnLog.push({ requested: kind, tabCreated: grew, agentAttached: attached, tabId: tab?.tabId ?? null, paneAgent })
    if (tab === null) continue
    observed[kind] = {
      tabId: tab.tabId,
      paneAgent,
      sidebar: await shapeOf(app, `[data-tab="${tab.tabId}"] .session-row-agent`),
      tabbar: await shapeOf(app, `[data-main-tab="${tab.tabId}"] .main-tab-agent`),
      sidebarGlyph: await shapeOf(app, `[data-tab="${tab.tabId}"] .session-row-glyph`),
    }
  }

  const table = KINDS.filter((k) => observed[k] !== undefined).map((kind) => {
    const o = observed[kind]
    const side = verdictFor(kind, o.sidebar)
    const bar = verdictFor(kind, o.tabbar)
    return {
      kind,
      paneAgent: o.paneAgent,
      sidebarRendered: side.rendered,
      tabbarRendered: bar.rendered,
      // 사이드바는 **에이전트 탭만** 나열한다(01-criteria.md 부록 '세션 용어 확정').
      // 셸 탭은 세션 행이 아예 없는 게 정상이라 탭바로 판정한다.
      judgedOn: kind === 'shell' ? 'tabbar' : 'sidebar',
      expectation: side.why,
      sidebarShape: o.sidebar,
      tabbarShape: o.tabbar,
    }
  })

  // 판별력 — 네 종류가 **서로 다른** 마크업이어야 한다. 전부 같은 모양이면 종류가 화면에
  // 안 드러난 것이고, 그걸 통과로 읽으면 안 된다.
  const shapeKey = (s) => `${s?.pathCount ?? 'x'}/${s?.pathHead ?? '-'}/${s?.textInSvg ?? '-'}/${(s?.plainText ?? '-').trim()}`
  const fingerprints = table.map((r) => `${r.kind}:${shapeKey(r.tabbarShape)}`)
  // 판별력은 **에이전트 세 종류**가 서로 다른가로 본다(셸은 아이콘 대상이 아니다).
  const distinct = new Set(table.filter((r) => r.kind !== 'shell').map((r) => shapeKey(r.tabbarShape))).size
  const shot = await app.shot('agent-icons')
  const unobserved = KINDS.filter((k) => observed[k] === undefined)
  const agentKinds = table.filter((r) => r.kind !== 'shell')

  await app.stop()
  writeRaw('16-agent-icon-render.json', {
    criterion: 'I-2 검산 — 에이전트 종류 아이콘 실렌더 관측 (claude·codex·grok·shell)',
    note: '판정은 마크업 모양으로 한다. data-agent-kind 문자열은 근거로 쓰지 않는다(자기 신고 배제).',
    spawnLog,
    table,
    fingerprints,
    distinctSidebarShapes: distinct,
    unobserved,
    agentPaneAttached: Object.fromEntries(table.map((r) => [r.kind, r.paneAgent])),
    shellHasNoSessionRow: (table.find((r) => r.kind === 'shell')?.sidebarShape ?? null) === null,
    pass:
      table.length === KINDS.length &&
      agentKinds.every((r) => r.sidebarRendered && r.tabbarRendered) &&
      (table.find((r) => r.kind === 'shell')?.tabbarRendered ?? false) &&
      distinct === agentKinds.length,
    shot,
    clicks: app.clickLog(),
    rawChain: app.rawChain(),
  })
} catch (error) {
  await app.stop().catch(() => {})
  throw error
}
