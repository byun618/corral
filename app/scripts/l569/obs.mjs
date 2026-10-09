// LIFE-569 관측(G4·G5) — 개발 앱 제어 소켓(/tmp/l569n/ctl.sock)에서 store 상태와 렌더러 사이드바 DOM 을 함께 뜬다.
// 사용: node obs.mjs <라벨> <출력 json 경로> [paneId…]
// F4(r1) — DOM 의 「0행」 은 사이드바가 그려져 있을 때만 센다. 판정 기준 = **같은 관측**에서 에이전트 행
//   ([data-agent-row], live 든 retained 든) ≥1 — C1 `15-obs-c1b-pre-close.json` 처럼 렌더 전 빈 목록이 0행으로 읽히는 것을 막는다.
//   그래서 0행을 재는 회차는 같은 순간 보이는 양성 대조 행(다른 live 에이전트 pane 등)을 하나 남겨 둔다.
//   그려지지 않은 관측의 domRetained·watched.domRetained 는 null(모름)이다 — 0 이 아니다.
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
  return { agentRows: document.querySelectorAll('[data-agent-row]').length, retained: rows('retained'), live: rows('live'), closedTabText: [...document.querySelectorAll('.session-row-second')].filter((el) => el.textContent.includes('닫힌 탭')).length }
})()` })
const result = {
  label, at: new Date().toISOString(), watch,
  store: { retainedAgents: state.retainedAgents ?? null, retainedCount: (state.retainedAgents ?? []).length, livePanes: panes },
  dom: dom.ok ? dom.result : { error: dom },
}
const rendered = dom.ok && dom.result.agentRows > 0
result.summary = {
  storeRetained: result.store.retainedCount,
  domRendered: rendered,
  domRetained: rendered ? dom.result.retained.length : null,
  domClosedTabText: rendered ? dom.result.closedTabText : null,
  watched: watch.map((paneId) => ({ paneId, live: panes.find((p) => p.paneId === paneId) ?? null,
    storeRetained: (state.retainedAgents ?? []).some((r) => r.paneId === paneId),
    domRetained: rendered ? dom.result.retained.some((r) => r.key === `retained:${paneId}`) : null,
    domLive: rendered ? dom.result.live.some((r) => r.key === paneId) : null })),
}
fs.writeFileSync(out, JSON.stringify(result, null, 1) + '\n')
console.log(JSON.stringify(result.summary))
