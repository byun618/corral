// LIFE-569 관측(G4·G5) — 개발 앱 제어 소켓(/tmp/l569n/ctl.sock)에서 store 상태와 렌더러 사이드바 DOM 을 함께 뜬다.
// 사용: node obs.mjs <라벨> <출력 json 경로> [paneId…]
//   store: state.retainedAgents(= link.store.retainedRows()) · 산 pane 목록(paneId·agent 상태)
//   DOM:   [data-agent-row-source="retained"] 행(키·텍스트) · 산 행 [data-agent-row-source="live"]
import fs from 'node:fs'
import { rpc } from '../gui-diff/lib/corral.mjs'
const [label, out, ...watch] = process.argv.slice(2)
const control = (request) => rpc('/tmp/l569n/ctl.sock', request, 20_000)
const { state } = await control({ cmd: 'state' })
const panes = []
for (const repo of state.repos ?? []) for (const wt of repo.worktrees ?? []) for (const tab of wt.workspace?.tabs ?? []) for (const pane of tab.panes ?? [])
  panes.push({ worktree: wt.path, workspaceId: wt.workspace.workspaceId, tabId: tab.tabId, title: tab.title ?? tab.label ?? null, paneId: pane.paneId, agent: pane.agent ?? null, agentStatus: pane.agentStatus ?? pane.agentState?.status ?? null, agentState: pane.agentState ?? null })
const dom = await control({ cmd: 'eval', code: `(() => {
  const rows = (src) => [...document.querySelectorAll('[data-agent-row-source="' + src + '"]')].map((el) => ({ key: el.getAttribute('data-agent-row'), text: el.textContent.trim().slice(0, 160) }))
  return { retained: rows('retained'), live: rows('live'), closedTabText: [...document.querySelectorAll('.session-row-second')].filter((el) => el.textContent.includes('닫힌 탭')).length }
})()` })
const result = {
  label, at: new Date().toISOString(), watch,
  store: { retainedAgents: state.retainedAgents ?? null, retainedCount: (state.retainedAgents ?? []).length, livePanes: panes },
  dom: dom.ok ? dom.result : { error: dom },
}
result.summary = {
  storeRetained: result.store.retainedCount,
  domRetained: dom.ok ? dom.result.retained.length : null,
  domClosedTabText: dom.ok ? dom.result.closedTabText : null,
  watched: watch.map((paneId) => ({ paneId, live: panes.find((p) => p.paneId === paneId) ?? null,
    storeRetained: (state.retainedAgents ?? []).some((r) => r.paneId === paneId),
    domRetained: dom.ok ? dom.result.retained.some((r) => r.key === `retained:${paneId}`) : null,
    domLive: dom.ok ? dom.result.live.some((r) => r.key?.endsWith(paneId)) : null })),
}
fs.writeFileSync(out, JSON.stringify(result, null, 1) + '\n')
console.log(JSON.stringify(result.summary))
