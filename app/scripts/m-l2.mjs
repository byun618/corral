// L2 — 탭이 한 줄이고, pane 은 **스플릿이 있을 때만** 그 아래로 펼쳐지는가.
//
// 왜 바뀌었나: Orca 실측(`00-orca-terminal-list.json`)에서 Orca 의 `tabId`·`leafId` 가 herdr 의
// tab·pane 과 1:1 이었다. 지금 사용자 Orca 는 탭마다 leaf 가 하나라 그 층이 접혀 보이는데,
// 1회차 corral 은 pane 을 무조건 잎으로 깔아 **탭 1개짜리 workspace 가 두 줄로** 나왔다.
//
// 재는 방법: 화면에 **실제로 그려진 줄 수**를 렌더러가 세어 보낸 것(`renderer.probe name=tree`)으로
// 판정한다. 상태만 보고 "pane 줄이 없다"고 적으면 관측이 아니라 렌더 규칙에 대한 주장이다.
//
// 격리: 스플릿·탭 생성은 life344-probe 에서만 한다.

import { SESSION, request, sleep, socketPath, startApp, tidySession, writeRaw } from './lib.mjs'

socketPath() // 격리 가드
await tidySession()

const app = await startApp({ name: 'l2' })
await sleep(800)

// --- ① 스플릿 없는 상태 -------------------------------------------------
// 탭을 하나 더 만들어 "탭이 여럿이어도 pane 줄은 없다"까지 보이게 한다.
await request('tab.create', { workspace_id: 'w1', label: '두번째' })
await settle(app)
const flatProbe = await lastTreeProbe(app)
const flatState = await app.state()
await app.shot('l2-1-no-split')

// --- ② 실제로 스플릿을 만든다 -------------------------------------------
const snapshot = (await request('session.snapshot')).result.snapshot
const target = snapshot.panes.find((pane) => pane.workspace_id === 'w1')
const split = await request('pane.split', { target_pane_id: target.pane_id, direction: 'right' })
await settle(app)
const splitProbe = await lastTreeProbe(app)
const splitState = await app.state()
await app.shot('l2-2-split-expanded')

// --- ③ 스플릿된 탭의 pane 을 골라 본다 (선택 대상은 여전히 pane) --------
const splitTab = splitState.state.workspaces
  .flatMap((row) => row.tabs)
  .find((tab) => tab.panes.length >= 2)
const pick = splitTab.panes[1]
await app.selectPane(pick.paneId)
await sleep(400)
const afterSelect = await app.state()
await app.shot('l2-3-split-pane-selected')

const tabsOf = (state) => state.state.workspaces.flatMap((row) => row.tabs)
const result = {
  measuredAt: new Date().toISOString(),
  session: SESSION,
  question: '탭이 한 줄인가. pane 은 스플릿이 있을 때만 펼쳐지는가. 선택 대상은 여전히 pane 인가.',
  orcaMapping: {
    note: 'Orca 실측(00-orca-terminal-list.json) 대조 — worktreeId=workspace · tabId=tab · leafId=pane',
  },
  noSplit: {
    tabs: tabsOf(flatState).map((tab) => ({
      tabId: tab.tabId,
      label: tab.label,
      panes: tab.panes.length,
      snapshotPaneCount: tab.snapshotPaneCount,
    })),
    renderedRows: flatProbe,
    everyTabSinglePane: tabsOf(flatState).every((tab) => tab.panes.length === 1),
    paneRowsRendered: Number(flatProbe?.paneRows ?? -1),
  },
  afterSplit: {
    splitRequest: { targetPaneId: target.pane_id, direction: 'right', newPaneId: split.result?.pane?.pane_id ?? null },
    tabs: tabsOf(splitState).map((tab) => ({
      tabId: tab.tabId,
      label: tab.label,
      panes: tab.panes.map((pane) => pane.paneId),
      snapshotPaneCount: tab.snapshotPaneCount,
    })),
    renderedRows: splitProbe,
    paneRowsRendered: Number(splitProbe?.paneRows ?? -1),
    splitTabs: Number(splitProbe?.splitTabs ?? -1),
  },
  selection: {
    picked: pick.paneId,
    selectedPaneId: afterSelect.state.selectedPaneId,
    matches: afterSelect.state.selectedPaneId === pick.paneId,
  },
  shots: ['shots/l2-1-no-split.png', 'shots/l2-2-split-expanded.png', 'shots/l2-3-split-pane-selected.png'],
  snapshotAtSplit: snapshot,
}

result.pass =
  result.noSplit.everyTabSinglePane &&
  result.noSplit.paneRowsRendered === 0 &&
  Number(flatProbe?.tabRows ?? -1) === tabsOf(flatState).length &&
  result.afterSplit.splitTabs === 1 &&
  result.afterSplit.paneRowsRendered === 2 &&
  result.selection.matches
result.conclusion = result.pass
  ? `스플릿이 없을 때 탭 ${flatProbe.tabRows}줄 · pane 0줄. 스플릿을 만들자 그 탭 아래에만 pane 2줄이 ` +
    '생겼다(다른 탭은 그대로). 스플릿된 탭의 pane 을 골라 선택이 그 pane 으로 잡혔다.'
  : '기대와 다르다. 원자료를 그대로 두고 결과 문서에 미달로 적을 것.'

writeRaw('35-l2-tab-tier.json', result)
console.log(
  JSON.stringify(
    {
      noSplit: { tabRows: flatProbe?.tabRows, paneRows: flatProbe?.paneRows },
      afterSplit: { tabRows: splitProbe?.tabRows, paneRows: splitProbe?.paneRows, splitTabs: splitProbe?.splitTabs },
      selectionMatches: result.selection.matches,
      pass: result.pass,
    },
    null,
    2,
  ),
)

await app.stop()
await tidySession()

/** 변화가 화면까지 닿을 때까지 기다린다 — push 가 조용해지고 렌더러가 그 판을 보고할 때까지. */
async function settle(handle) {
  await sleep(1200)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const entries = handle.entries()
    const lastState = entries.filter((entry) => entry.tag === 'state.emit').pop()
    const lastTree = entries.filter((entry) => entry.tag === 'renderer.probe' && entry.name === 'tree').pop()
    if (lastState && lastTree && Number(lastTree.revision) >= lastState.revision) return
    await sleep(150)
  }
}

async function lastTreeProbe(handle) {
  return handle.entries().filter((entry) => entry.tag === 'renderer.probe' && entry.name === 'tree').pop() ?? null
}
