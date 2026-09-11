// M2 — N6(죽은 행 부활 0). **앱을 띄우지 않고 store 에 직접 순서를 먹인다.**
//
// 왜 앱이 없나: 재는 것이 "늦게 온 이벤트를 store 가 어떻게 다루나" 라서다. 앱을 띄우면 그
// 순서가 날 때까지 흔들어야 하고, 안 나면 "실패가 없었다" 가 "눌러 본 적이 없다" 와 구분되지
// 않는다 (LIFE-346 이 실제로 물린 자리). 주입은 재현 가능하고 언제든 같은 값이 나온다.
//
// 재생하는 순서는 LIFE-346 이 실측한 세 갈래 그대로다:
//   ① `tab.close` 경로 — tab_closed 뒤에 늦은 pane_updated·tab_created
//   ② 사용자 `exit` 경로 — pane_exited(탭까지 지움) 뒤에 늦은 pane_created
//   ③ workspace 층 — 마지막 탭의 마지막 pane 이 exit 로 죽은 뒤 늦은 tab_created·pane_created
// 그리고 이 store 에 새로 생긴 문 하나를 더 본다:
//   ④ **재동기** — 묘비를 지우지 않는가. 닫힌 행이 든 낡은 스냅샷으로 재동기하면 부활하는가
//
// **수정 1회차에 늘어난 갈래** (리뷰가 실행으로 반증한 자리 — 여기가 재발 방지선이다):
//   ⑤ H1ⓐ 형제 pane 이 남는 탭에서 pane 하나만 닫고 늦은 pane_updated — 1회차엔 부활했다
//   ⑥ H1ⓓ 재동기가 지운 pane 에 늦은 pane_updated — 1회차엔 같은 문으로 돌아왔다
//   ⑦ M2  agent_status 없는 pane_updated 가 상태 칩을 지우는가 — 1회차엔 blocked→unknown
//   ⑧ M1  모양이 아닌 응답으로 재동기 — 1회차엔 목록 전멸 + 영구 묘비
//   ⑨ L7  닫힌 workspace 앞으로 온 고아 + 만료 purge
//   ⑩ L5  tab_closed 의 workspace 연쇄 (pane_exited 와 대칭인가)
//   ⑪ M5  tab_moved 가 순서를 바꾸는가 — 순서의 진실은 number 가 아니라 배열 자리다

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, writeRaw } from './lib.mjs'

/** store.ts 한 판을 번들해 import 한다 — electron 없이 순수 로직만 돌린다. */
function bundle(sourceDir, label) {
  const outFile = path.join(fs.mkdtempSync(`/tmp/l351-store-${label}-`), 'store.mjs')
  execFileSync(path.join(APP_DIR, 'node_modules/.bin/esbuild'), [
    path.join(sourceDir, 'src/main/adapter/internal/store.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${outFile}`,
  ])
  return outFile
}
const { WorkspaceStore } = await import(bundle(APP_DIR, 'now'))

const workspace = { workspace_id: 'wX', label: 'l351', number: 1, focused: true }
const tab = { tab_id: 'wX:t1', workspace_id: 'wX', label: '1', number: 1 }
const pane = { pane_id: 'wX:p1', workspace_id: 'wX', tab_id: 'wX:t1', title: 'zsh', revision: 1 }

const notes = []
function apply(store, event, data) {
  const result = store.applyEvent({ event, data })
  notes.push({ event, changed: result.changed, note: result.note })
  return result
}
function snap(store) {
  const rows = store.rows()
  return {
    workspaces: rows.map((row) => row.workspaceId),
    tabs: rows.flatMap((row) => row.tabs.map((item) => item.tabId)),
    panes: rows.flatMap((row) => row.tabs.flatMap((item) => item.panes.map((p) => p.paneId))),
  }
}

// ① tab_closed 뒤 늦은 pane_updated · tab_created
const a = new WorkspaceStore()
apply(a, 'workspace_created', { workspace })
apply(a, 'tab_created', { tab })
apply(a, 'pane_created', { pane })
const a열린뒤 = snap(a)
apply(a, 'tab_closed', { tab_id: tab.tab_id })
const a닫은직후 = snap(a)
apply(a, 'pane_updated', { pane: { ...pane, revision: 2 } })
apply(a, 'tab_created', { tab })
const a늦은뒤 = snap(a)

// ② pane_exited(마지막 pane) 뒤 늦은 pane_created — 탭이 둘이라 workspace 는 남는다
const b = new WorkspaceStore()
apply(b, 'workspace_created', { workspace })
apply(b, 'tab_created', { tab })
apply(b, 'pane_created', { pane })
apply(b, 'tab_created', { tab: { ...tab, tab_id: 'wX:t2', number: 2 } })
apply(b, 'pane_created', { pane: { pane_id: 'wX:p2', workspace_id: 'wX', tab_id: 'wX:t2', revision: 1 } })
apply(b, 'pane_exited', { pane_id: pane.pane_id })
const b닫은직후 = snap(b)
apply(b, 'pane_created', { pane: { ...pane, revision: 3 } })
const b늦은뒤 = snap(b)

// ③ 마지막 탭의 마지막 pane 이 exit — workspace 까지 지워지나, 그 뒤 늦은 이벤트는 어디로 가나
const c = new WorkspaceStore()
apply(c, 'workspace_created', { workspace })
apply(c, 'tab_created', { tab })
apply(c, 'pane_created', { pane })
apply(c, 'pane_exited', { pane_id: pane.pane_id })
const c닫은직후 = snap(c)
const c보류함 = c.heldOrphans()
apply(c, 'tab_created', { tab: { ...tab, tab_id: 'wX:t9', number: 9 } })
apply(c, 'pane_created', { pane: { pane_id: 'wX:p9', workspace_id: 'wX', tab_id: 'wX:t9', revision: 1 } })
apply(c, 'workspace_created', { workspace })
const c늦은뒤 = snap(c)

// ④ **재동기가 부활의 문이 되는가.** 닫기 전에 뜬 낡은 스냅샷으로 재동기해 본다.
const d = new WorkspaceStore()
apply(d, 'workspace_created', { workspace })
apply(d, 'tab_created', { tab })
apply(d, 'pane_created', { pane })
const 낡은스냅샷 = { snapshot: { workspaces: [workspace], tabs: [tab], panes: [pane] } }
apply(d, 'tab_closed', { tab_id: tab.tab_id })
const d닫은직후 = snap(d)
// 스냅샷은 닫기 **전에** 뜬 것이다 — 요청 시각도 그때로 준다.
const d재동기 = d.reconcile(낡은스냅샷, Date.now())
const d재동기뒤 = snap(d)

// ④b 반대 방향: **스냅샷보다 나중에 생긴 행을 재동기가 지우면 안 된다.**
const e = new WorkspaceStore()
apply(e, 'workspace_created', { workspace })
apply(e, 'tab_created', { tab })
apply(e, 'pane_created', { pane })
const e스냅샷요청시각 = Date.now()
const 그때스냅샷 = { snapshot: { workspaces: [workspace], tabs: [tab], panes: [pane] } }
await new Promise((resolve) => setTimeout(resolve, 5))
// 스냅샷을 뜬 뒤에 새 탭이 생겼다 (push 가 스냅샷 응답보다 먼저 왔다)
apply(e, 'tab_created', { tab: { ...tab, tab_id: 'wX:t7', number: 7 } })
apply(e, 'pane_created', { pane: { pane_id: 'wX:p7', workspace_id: 'wX', tab_id: 'wX:t7', revision: 1 } })
const e재동기 = e.reconcile(그때스냅샷, e스냅샷요청시각)
const e재동기뒤 = snap(e)

const out = {
  at: new Date().toISOString(),
  질문: '닫힌 대상에 늦게 온 이벤트가 행을 되살리는가 (재동기 경로 포함)',
  '① tab_closed 뒤 늦은 pane_updated·tab_created': {
    열린뒤: a열린뒤,
    닫은직후: a닫은직후,
    늦은이벤트적용후: a늦은뒤,
    pane부활: a늦은뒤.panes.includes(pane.pane_id),
    탭부활: a늦은뒤.tabs.includes(tab.tab_id),
  },
  '② pane_exited 뒤 늦은 pane_created': {
    닫은직후: b닫은직후,
    늦은이벤트적용후: b늦은뒤,
    pane부활: b늦은뒤.panes.includes(pane.pane_id),
    '탭 t2 는 살아 있나': b늦은뒤.tabs.includes('wX:t2'),
  },
  '③ 마지막 탭 pane_exited 뒤 늦은 tab_created·pane_created·workspace_created': {
    닫은직후: c닫은직후,
    '유령 workspace 행': c닫은직후.workspaces.includes('wX'),
    보류함: c보류함,
    늦은이벤트적용후: c늦은뒤,
    workspace부활: c늦은뒤.workspaces.includes('wX'),
    늦은탭이붙었나: c늦은뒤.tabs.includes('wX:t9'),
    늦은pane이붙었나: c늦은뒤.panes.includes('wX:p9'),
    최종보류함: c.heldOrphans(),
  },
  '④ 낡은 스냅샷으로 재동기 — 묘비가 버티는가': {
    닫은직후: d닫은직후,
    재동기결과: d재동기,
    재동기뒤: d재동기뒤,
    탭부활: d재동기뒤.tabs.includes(tab.tab_id),
    pane부활: d재동기뒤.panes.includes(pane.pane_id),
  },
  '④b 스냅샷보다 나중에 생긴 행을 재동기가 지우는가': {
    재동기결과: e재동기,
    재동기뒤: e재동기뒤,
    '새 탭이 살아남았나': e재동기뒤.tabs.includes('wX:t7'),
    '새 pane 이 살아남았나': e재동기뒤.panes.includes('wX:p7'),
  },
  적용note: notes,
}
// ⑤ H1ⓐ — 형제 pane 이 남는 탭에서 pane 하나만 닫는다. **탭은 산다** → 1회차엔 방어가 없었다.
const pane2 = { pane_id: 'wX:p2', workspace_id: 'wX', tab_id: 'wX:t1', title: 'zsh', revision: 1 }
const f = new WorkspaceStore()
apply(f, 'workspace_created', { workspace })
apply(f, 'tab_created', { tab })
apply(f, 'pane_created', { pane })
apply(f, 'pane_created', { pane: pane2 })
const f닫기전 = snap(f)
apply(f, 'pane_closed', { pane_id: pane.pane_id })
const f닫은직후 = snap(f)
apply(f, 'pane_updated', { pane: { ...pane, revision: 2 } })
apply(f, 'pane_created', { pane })
const f늦은뒤 = snap(f)

// ⑥ H1ⓓ — 재동기가 지운 pane 에 늦은 push. 탭은 스냅샷에 살아 있다.
const g = new WorkspaceStore()
apply(g, 'workspace_created', { workspace })
apply(g, 'tab_created', { tab })
apply(g, 'pane_created', { pane })
apply(g, 'pane_created', { pane: pane2 })
await new Promise((resolve) => setTimeout(resolve, 5))
const g재동기 = g.reconcile({ snapshot: { workspaces: [workspace], tabs: [tab], panes: [pane2] } }, Date.now())
const g재동기뒤 = snap(g)
apply(g, 'pane_updated', { pane: { ...pane, revision: 5 } })
const g늦은뒤 = snap(g)

// ⑦ M2 — agent_status 를 안 싣고 온 pane_updated 가 칩을 지우는가.
const h = new WorkspaceStore()
apply(h, 'workspace_created', { workspace })
apply(h, 'tab_created', { tab })
apply(h, 'pane_created', { pane: { ...pane, agent_status: 'idle' } })
apply(h, 'pane_agent_status_changed', { pane_id: pane.pane_id, agent_status: 'blocked', agent: 'claude' })
const paneOf = (store) => store.rows()[0].tabs[0].panes[0]
const h상태전 = { status: paneOf(h).agentStatus, agent: paneOf(h).agent }
apply(h, 'pane_updated', { pane: { pane_id: pane.pane_id, workspace_id: 'wX', tab_id: 'wX:t1', title: 'zsh' } })
const h상태후 = { status: paneOf(h).agentStatus, agent: paneOf(h).agent }
// 키가 **있으면** 그 값이 답이다 — 보호가 "영영 안 바뀜" 이 되면 그것대로 거짓말이다.
apply(h, 'pane_updated', { pane: { ...pane, agent_status: 'working' } })
const h키있을때 = { status: paneOf(h).agentStatus }
// herdr 스키마에는 있지만 corral 칩에는 없는 값(done)이 오면 — 미상으로 옮기고 로그에 남긴다 (M7).
apply(h, 'pane_updated', { pane: { ...pane, agent_status: 'done' } })
const hdone = { status: paneOf(h).agentStatus }

// ⑧ M1 — 모양이 아닌 응답으로 재동기.
const i = new WorkspaceStore()
apply(i, 'workspace_created', { workspace })
apply(i, 'tab_created', { tab })
apply(i, 'pane_created', { pane })
await new Promise((resolve) => setTimeout(resolve, 5))
const i재동기 = i.reconcile({ type: 'session_snapshot' }, Date.now())
const i재동기뒤 = snap(i)
const i복구 = apply(i, 'tab_created', { tab })
const i최종 = snap(i)

// ⑨ L7 — 닫힌 workspace 앞으로 온 고아는 담지 않는다 · 만료된 고아는 조회 시점에 털린다.
const j = new WorkspaceStore()
apply(j, 'workspace_created', { workspace })
apply(j, 'tab_created', { tab })
apply(j, 'pane_created', { pane })
apply(j, 'workspace_closed', { workspace_id: 'wX' })
apply(j, 'tab_created', { tab: { tab_id: 'wX:t5', workspace_id: 'wX', label: '5', number: 5 } })
const j닫힌뒤보류함 = j.heldOrphans()
// 주인이 아직 안 온 workspace 앞으로 온 고아는 정상적으로 담긴다.
const k = new WorkspaceStore()
apply(k, 'tab_created', { tab: { tab_id: 'wY:t1', workspace_id: 'wY', label: '1', number: 1 } })
const k담긴직후 = k.heldOrphans()

// ⑩ L5 — tab_closed 가 마지막 탭이면 workspace 도 닫는가 (pane_exited 와 대칭).
const l = new WorkspaceStore()
apply(l, 'workspace_created', { workspace })
apply(l, 'tab_created', { tab })
apply(l, 'pane_created', { pane })
apply(l, 'tab_closed', { tab_id: tab.tab_id, workspace_id: 'wX' })
const l닫은직후 = snap(l)
apply(l, 'tab_created', { tab })
const l늦은뒤 = snap(l)

// ⑪ M5 — tab_moved. **순서의 진실은 배열 자리다** (00-shapes-fix1.json).
const m = new WorkspaceStore()
apply(m, 'workspace_created', { workspace })
const tabsOf = (store) => store.rows()[0].tabs.map((item) => ({ tabId: item.tabId, number: item.number }))
const three = [1, 2, 3].map((n) => ({ tab_id: `wX:t${n}`, workspace_id: 'wX', label: String(n), number: n }))
for (const item of three) apply(m, 'tab_created', { tab: item })
const m옮기기전 = tabsOf(m)
const moved = [three[2], three[0], three[1]]
apply(m, 'tab_moved', { tab_id: 'wX:t3', workspace_id: 'wX', insert_index: 0, tabs: moved })
const m옮긴뒤 = tabsOf(m)
// 재동기도 순서를 맞추는가 (스냅샷 배열 자리가 진실).
const m재동기 = m.reconcile({ snapshot: { workspaces: [workspace], tabs: [three[1], three[2], three[0]], panes: [] } }, Date.now() + 1000)
const m재동기뒤 = tabsOf(m)

out['⑤ H1ⓐ 형제 pane 이 남는 탭 — pane 하나만 닫고 늦은 push'] = {
  닫기전: f닫기전,
  닫은직후: f닫은직후,
  '탭은 살아 있나': f닫은직후.tabs.includes(tab.tab_id),
  늦은이벤트적용후: f늦은뒤,
  pane부활: f늦은뒤.panes.includes(pane.pane_id),
}
out['⑥ H1ⓓ 재동기가 지운 pane 에 늦은 push'] = {
  재동기결과: g재동기.removed,
  재동기뒤: g재동기뒤,
  늦은이벤트적용후: g늦은뒤,
  pane부활: g늦은뒤.panes.includes(pane.pane_id),
}
out['⑦ M2 agent_status 없는 pane_updated'] = {
  상태전: h상태전,
  '키 없는 봉투 뒤': h상태후,
  상태가지워졌나: h상태후.status !== h상태전.status,
  '키 있으면 갱신되나': h키있을때.status === 'working',
  'done 은 미상으로 (M7)': hdone.status,
}
out['⑧ M1 모양이 아닌 응답으로 재동기'] = {
  재동기결과: { note: i재동기.note, changed: i재동기.changed, removed: i재동기.removed },
  재동기뒤: i재동기뒤,
  목록전멸했나: i재동기뒤.tabs.length === 0 && i재동기뒤.panes.length === 0,
  '그 뒤 push 가 붙나': i복구.changed,
  최종: i최종,
}
out['⑨ L7 고아 보류함'] = {
  '닫힌 workspace 앞으로 온 고아를 담았나': j닫힌뒤보류함.length > 0,
  닫힌뒤보류함: j닫힌뒤보류함,
  '아직 안 온 주인 앞으로 온 고아는 담나': k담긴직후.length === 1,
}
out['⑩ L5 tab_closed 의 workspace 연쇄'] = {
  닫은직후: l닫은직후,
  'workspace 도 닫혔나': !l닫은직후.workspaces.includes('wX'),
  늦은이벤트적용후: l늦은뒤,
  탭부활: l늦은뒤.tabs.includes(tab.tab_id),
}
out['⑪ M5 tab_moved 순서'] = {
  옮기기전: m옮기기전,
  옮긴뒤: m옮긴뒤,
  '순서가 바뀌었나': m옮긴뒤.map((item) => item.tabId).join(',') === 'wX:t3,wX:t1,wX:t2',
  'number 는 그대로인가': m옮긴뒤.map((item) => item.number).join(',') === '3,1,2',
  재동기결과note: m재동기.note,
  재동기뒤: m재동기뒤,
  '재동기가 순서를 맞추나': m재동기뒤.map((item) => item.tabId).join(',') === 'wX:t2,wX:t3,wX:t1',
}

out.판정 = {
  '① pane 부활': out['① tab_closed 뒤 늦은 pane_updated·tab_created'].pane부활,
  '① 탭 부활': out['① tab_closed 뒤 늦은 pane_updated·tab_created'].탭부활,
  '② pane 부활': out['② pane_exited 뒤 늦은 pane_created'].pane부활,
  '③ workspace 부활': out['③ 마지막 탭 pane_exited 뒤 늦은 tab_created·pane_created·workspace_created'].workspace부활,
  '③ 늦은 탭 부활': out['③ 마지막 탭 pane_exited 뒤 늦은 tab_created·pane_created·workspace_created'].늦은탭이붙었나,
  '③ 유령 workspace 행': out['③ 마지막 탭 pane_exited 뒤 늦은 tab_created·pane_created·workspace_created']['유령 workspace 행'],
  '④ 재동기가 되살림': out['④ 낡은 스냅샷으로 재동기 — 묘비가 버티는가'].탭부활,
  '④b 새 행을 지웠나': !out['④b 스냅샷보다 나중에 생긴 행을 재동기가 지우는가']['새 탭이 살아남았나'],
  '⑤ pane 부활 (형제 잔존 탭)': out['⑤ H1ⓐ 형제 pane 이 남는 탭 — pane 하나만 닫고 늦은 push'].pane부활,
  '⑥ pane 부활 (재동기 삭제 뒤)': out['⑥ H1ⓓ 재동기가 지운 pane 에 늦은 push'].pane부활,
  '⑦ 상태 칩이 지워졌나': out['⑦ M2 agent_status 없는 pane_updated'].상태가지워졌나,
  '⑧ 모양 아닌 응답이 목록을 지웠나': out['⑧ M1 모양이 아닌 응답으로 재동기'].목록전멸했나,
  '⑨ 닫힌 workspace 앞 고아를 담았나': out['⑨ L7 고아 보류함']['닫힌 workspace 앞으로 온 고아를 담았나'],
  '⑩ 탭부활 (workspace 연쇄 뒤)': out['⑩ L5 tab_closed 의 workspace 연쇄'].탭부활,
}
/** 부활·손상이 아니라 **되어야 하는 것**. 위 판정이 전부 false 여야 하듯 이건 전부 true 여야 한다. */
out.되어야하는것 = {
  '⑦ 키가 있으면 상태는 갱신된다': out['⑦ M2 agent_status 없는 pane_updated']['키 있으면 갱신되나'],
  '⑦ done 은 미상으로 옮긴다': out['⑦ M2 agent_status 없는 pane_updated']['done 은 미상으로 (M7)'] === 'unknown',
  '⑧ 모양 아닌 응답 뒤에도 push 가 붙는다': out['⑧ M1 모양이 아닌 응답으로 재동기']['그 뒤 push 가 붙나'],
  '⑨ 주인 미도착 고아는 담는다': out['⑨ L7 고아 보류함']['아직 안 온 주인 앞으로 온 고아는 담나'],
  '⑩ 마지막 탭이 닫히면 workspace 도 닫힌다': out['⑩ L5 tab_closed 의 workspace 연쇄']['workspace 도 닫혔나'],
  '⑪ tab_moved 가 순서를 바꾼다': out['⑪ M5 tab_moved 순서']['순서가 바뀌었나'],
  '⑪ number 는 순서를 안 따라간다': out['⑪ M5 tab_moved 순서']['number 는 그대로인가'],
  '⑪ 재동기가 순서를 맞춘다': out['⑪ M5 tab_moved 순서']['재동기가 순서를 맞추나'],
}
out.부활건수 = Object.entries(out.판정).filter(([, value]) => value === true).length
/**
 * **음성 대조** — 새로 늘린 케이스가 실제로 가르는가.
 *
 * 통과만 적으면 "고쳐서 통과" 와 "케이스가 원래 아무것도 안 잡는다" 가 구분되지 않는다.
 * 그래서 같은 재생을 **1회차 store**(태그 `LIFE-351-claude-r1`)에도 먹여 본다.
 * 거기서 부활이 나야 이 케이스가 판별자다.
 */
async function replayOn(StoreClass) {
  const run = (fn) => {
    const store = new StoreClass()
    fn(store, (event, data) => store.applyEvent({ event, data }))
    return store
  }
  const seed = (store, go, panes) => {
    go('workspace_created', { workspace })
    go('tab_created', { tab })
    for (const item of panes) go('pane_created', { pane: item })
  }
  const ids = (store) => {
    const rows = store.rows()
    return {
      tabs: rows.flatMap((row) => row.tabs.map((item) => item.tabId)),
      panes: rows.flatMap((row) => row.tabs.flatMap((item) => item.panes.map((p) => p.paneId))),
    }
  }

  const five = run((store, go) => {
    seed(store, go, [pane, pane2])
    go('pane_closed', { pane_id: pane.pane_id })
    go('pane_updated', { pane: { ...pane, revision: 2 } })
  })
  const six = new StoreClass()
  seed(six, (event, data) => six.applyEvent({ event, data }), [pane, pane2])
  await new Promise((resolve) => setTimeout(resolve, 5))
  six.reconcile({ snapshot: { workspaces: [workspace], tabs: [tab], panes: [pane2] } }, Date.now())
  six.applyEvent({ event: 'pane_updated', data: { pane: { ...pane, revision: 5 } } })
  const seven = run((store, go) => {
    seed(store, go, [{ ...pane, agent_status: 'idle' }])
    go('pane_agent_status_changed', { pane_id: pane.pane_id, agent_status: 'blocked', agent: 'claude' })
    go('pane_updated', { pane: { pane_id: pane.pane_id, workspace_id: 'wX', tab_id: 'wX:t1', title: 'zsh' } })
  })
  const eight = new StoreClass()
  seed(eight, (event, data) => eight.applyEvent({ event, data }), [pane])
  await new Promise((resolve) => setTimeout(resolve, 5))
  eight.reconcile({ type: 'session_snapshot' }, Date.now())
  const ten = run((store, go) => {
    seed(store, go, [pane])
    go('tab_closed', { tab_id: tab.tab_id, workspace_id: 'wX' })
  })
  const eleven = run((store, go) => {
    go('workspace_created', { workspace })
    for (const item of three) go('tab_created', { tab: item })
    go('tab_moved', { tab_id: 'wX:t3', workspace_id: 'wX', insert_index: 0, tabs: [three[2], three[0], three[1]] })
  })

  return {
    '⑤ pane 부활 (형제 잔존 탭)': ids(five).panes.includes(pane.pane_id),
    '⑥ pane 부활 (재동기 삭제 뒤)': ids(six).panes.includes(pane.pane_id),
    '⑦ 상태 칩이 지워졌나': seven.rows()[0].tabs[0].panes[0].agentStatus !== 'blocked',
    '⑧ 모양 아닌 응답이 목록을 지웠나': ids(eight).tabs.length === 0,
    '⑩ workspace 연쇄가 도는가': eight !== null && ten.rows().length === 0,
    '⑪ tab_moved 로 순서가 바뀌나':
      eleven.rows()[0].tabs.map((item) => item.tabId).join(',') === 'wX:t3,wX:t1,wX:t2',
  }
}

const oldDir = fs.mkdtempSync('/tmp/l351-r1-')
execFileSync('git', ['-C', APP_DIR, 'worktree', 'add', '--detach', oldDir, 'LIFE-351-claude-r1'], { stdio: 'ignore' })
let 음성대조 = null
try {
  const old = await import(bundle(path.join(oldDir, 'app'), 'r1'))
  음성대조 = {
    설명: '같은 재생을 1회차 store(LIFE-351-claude-r1)에 먹인 결과. 여기서 참이 나야 케이스가 판별자다.',
    '1회차': await replayOn(old.WorkspaceStore),
    지금: await replayOn(WorkspaceStore),
  }
} finally {
  execFileSync('git', ['-C', APP_DIR, 'worktree', 'remove', '--force', oldDir], { stdio: 'ignore' })
}
out['⑫ 음성 대조 — 1회차 store 로 같은 재생'] = 음성대조
out.케이스가가르나 = 음성대조 === null ? null : {
  '⑤': 음성대조['1회차']['⑤ pane 부활 (형제 잔존 탭)'] === true && 음성대조.지금['⑤ pane 부활 (형제 잔존 탭)'] === false,
  '⑥': 음성대조['1회차']['⑥ pane 부활 (재동기 삭제 뒤)'] === true && 음성대조.지금['⑥ pane 부활 (재동기 삭제 뒤)'] === false,
  '⑦': 음성대조['1회차']['⑦ 상태 칩이 지워졌나'] === true && 음성대조.지금['⑦ 상태 칩이 지워졌나'] === false,
  '⑧': 음성대조['1회차']['⑧ 모양 아닌 응답이 목록을 지웠나'] === true && 음성대조.지금['⑧ 모양 아닌 응답이 목록을 지웠나'] === false,
  '⑩': 음성대조['1회차']['⑩ workspace 연쇄가 도는가'] === false && 음성대조.지금['⑩ workspace 연쇄가 도는가'] === true,
  '⑪': 음성대조['1회차']['⑪ tab_moved 로 순서가 바뀌나'] === false && 음성대조.지금['⑪ tab_moved 로 순서가 바뀌나'] === true,
}

out.어긋난것 = Object.entries(out.되어야하는것).filter(([, value]) => value !== true).map(([key]) => key)
console.log(
  JSON.stringify(
    { 판정: out.판정, 부활건수: out.부활건수, 되어야하는것: out.되어야하는것, 어긋난것: out.어긋난것, 케이스가가르나: out.케이스가가르나 },
    null,
    2,
  ),
)
writeRaw('n6-store-order.json', out)
