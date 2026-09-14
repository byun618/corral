// C(세션 제목) 실측 — 09-gate1-fix.md C "실측 먼저, 결정은 그 다음".
//
// herdr 가 `PaneRow.title` 에 실제로 무엇을 주는지 확인된 적이 없다. 어댑터
// (main/adapter/internal/store.ts:763-768)는 `title` → `terminal_title_stripped` →
// `terminal_title` → `label` → `id` 순으로 채우는데, 그 중 어느 갈래가 실제로 걸리는지
// 아무도 안 봤다. 에이전트 탭·셸 탭 각각에서 값을 수집한다.
//
// 부수 확인(D·C3·C5 fixture 선행 조건): `createRow(kind:'claude')` 가 이 격리 세션에서
// 실제로 `pane.agent !== null` 을 만드는가. 못 만들면 "에이전트 세션" fixture 를 다른
// 방법(pane 에 직접 타이핑 → herdr 탐지 매니페스트)으로 만들어야 한다.
import { makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

async function main() {
  const repo = makeScratchRepo('title-probe')
  const app = await startApp({ name: '01-title-probe' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 8000,
    what: 'worktree row mounted',
  })
  await app.click(`[data-worktree="${repo.root}"]`)
  const workspaceId = await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace?.workspaceId ?? null,
    { timeoutMs: 10000, what: 'worktree opened' },
  ).then((r) => r.value)

  const snapshots = []
  const snap = async (label) => {
    const state = await app.state()
    const ws = state.repos.flatMap((r) => r.worktrees).find((w) => w.workspace?.workspaceId === workspaceId)?.workspace ?? null
    snapshots.push({
      label,
      at: Date.now(),
      tabs: (ws?.tabs ?? []).map((tab) => ({
        tabId: tab.tabId,
        label: tab.label,
        number: tab.number,
        order: tab.order,
        agentStatus: tab.agentStatus,
        panes: tab.panes.map((pane) => ({
          paneId: pane.paneId,
          title: pane.title,
          titleEqualsPaneId: pane.title === pane.paneId,
          agent: pane.agent,
          agentStatus: pane.agentStatus,
          cwd: pane.cwd,
        })),
      })),
    })
  }

  // ① 최초 (worktree 열면서 herdr 가 만든 기본 탭)
  await snap('00-after-open')

  // ② 셸 탭 1개 추가
  await app.click(`[data-worktree-menu-toggle="${repo.root}"]`)
  await app.click(`[data-worktree-create-shell="${repo.root}"]`)
  await until(
    async () => {
      const s = await app.state()
      return (s.repos.flatMap((r) => r.worktrees).find((w) => w.workspace?.workspaceId === workspaceId)?.workspace?.tabs.length ?? 0) >= 2
    },
    { timeoutMs: 10000, what: 'shell tab created' },
  )
  await sleep(1500)
  await snap('01-after-shell')

  // ③ 에이전트 탭 (claude) 추가 — createRow(kind:'claude') 가 agent 를 실제로 붙이는지 확인
  const createAgent = await app.send({ cmd: 'eval', expr: 'null' }).catch(() => null)
  await app.click(`[data-worktree-menu-toggle="${repo.root}"]`)
  const agentClick = await app.click(`[data-worktree-create-agent="${repo.root}"][data-kind="claude"]`)
  await until(
    async () => {
      const s = await app.state()
      return (s.repos.flatMap((r) => r.worktrees).find((w) => w.workspace?.workspaceId === workspaceId)?.workspace?.tabs.length ?? 0) >= 3
    },
    { timeoutMs: 15000, what: 'agent tab created' },
  )
  await sleep(2000)
  await snap('02-after-agent-immediate')

  // ④ 에이전트 기동이 실제로 붙기까지 시간이 걸릴 수 있다 — 최대 25초 기다리며 재확인
  const agentAttached = await until(
    async () => {
      const s = await app.state()
      const ws = s.repos.flatMap((r) => r.worktrees).find((w) => w.workspace?.workspaceId === workspaceId)?.workspace ?? null
      return (ws?.tabs ?? []).some((tab) => tab.panes.some((pane) => pane.agent !== null))
    },
    { timeoutMs: 25000, everyMs: 500, what: 'any pane.agent !== null' },
  )
  await snap('03-after-agent-wait')

  // ⑤ 터미널 제목이 바뀌는지 — 셸 탭에 제목을 바꾸는 이스케이프를 직접 쏴 본다.
  //    herdr 가 terminal_title 을 실어 준다면 어댑터 2·3번째 갈래가 살아 있다는 증거다.
  const state = await app.state()
  const ws = state.repos.flatMap((r) => r.worktrees).find((w) => w.workspace?.workspaceId === workspaceId)?.workspace ?? null
  const shellTab = (ws?.tabs ?? [])[0] ?? null
  const shellPane = shellTab?.panes[0] ?? null
  let titleEcho = null
  if (shellPane !== null) {
    await app.send({ cmd: 'click', selector: `[data-tab="${shellTab.tabId}"]` }).catch(() => null)
    await sleep(400)
    await app.send({ cmd: 'type', text: "printf '\\033]0;PROBE-TITLE\\007'\n" }).catch((e) => (titleEcho = String(e)))
    await sleep(2500)
  }
  await snap('04-after-osc-title')

  await app.shot('title-probe-final')
  const rawChain = app.rawChain()
  await app.stop()

  const result = {
    what: 'PaneRow.title 실측 (09-gate1-fix.md C) + createRow(agent) 가 pane.agent 를 붙이는지',
    adapterFallbackChain: "store.ts:763-768 — title → terminal_title_stripped → terminal_title → label → id",
    agentClick: { ok: agentClick?.ok ?? null, hit: agentClick?.hit ?? null, method: agentClick?.method ?? null },
    agentAttachedWithin25s: agentAttached.ok,
    agentAttachWaitMs: agentAttached.ms,
    oscTitleError: titleEcho,
    snapshots,
    rawChain,
  }
  console.log(JSON.stringify(result, null, 2))
  writeRaw('c-title-probe.json', result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
