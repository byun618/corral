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
//
// **수정 2회차에 늘어난 갈래 — 표준 전제를 바꾼다.**
// 여기까지의 재생은 전부 "corral 이 herdr 를 다 안다" 는 전제 위에 서 있었다. 그 전제가
// 1회차 H1 과 2회차 H-1 을 나란히 가렸다 (판정 §D: **재생의 표준 전제로 "corral 이 일부를
// 모르는 상태" 를 깐다**). 그래서 아래 셋은 먼저 **push 를 한 건 빼고** 재생을 시작한다:
//   ⑬ H-1 tab_closed — corral 이 형제 탭을 모르는 채 **아는 마지막 탭**이 닫힌다
//   ⑭ H-1 pane_exited — corral 이 형제 pane 을 모르는 채 아는 마지막 pane 이 exit 한다
//   ⑮ H-1 반대 방향 — 낡은 사진이 **진짜 묘비**를 걷어 내지는 않는가 (회복이 부활의 문이 되면 안 된다)
//   ⑯ L-1 한 층만 든 응답 — 스냅샷으로 받아들여 나머지 두 층을 전멸시키는가
//   ⑰ L-5 뒤집혀 도착한 tab_created — 화면 순서가 도착순으로 굳는가

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
/** corral 이 **모르는** 형제들 — 유실된 push 로만 알 수 있었을 행이다 (수정 2회차 표준 전제). */
const tab2 = { tab_id: 'wX:t2', workspace_id: 'wX', label: '2', number: 2 }

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
// **요청 시각을 닫기 전에 찍는다** (수정 3회차 F3-M1). 2회차까지는 `reconcile(…, Date.now())`
// 였는데, 그러면 `closedAt` 과 `requestedAt` 이 같은 밀리초라서 통과했다 — 두 줄이 1ms 라도
// 벌어지면 ⓪ 가 묘비를 걷고 이 칸이 "부활 3" 으로 뒤집힌다 (재리뷰가 `sleep(5)` 로 실증).
// 이 칸이 재려는 것은 "**닫기 전에 뜬** 사진으로 재동기해도 묘비가 버티는가" 이므로,
// 사진을 요청한 시각도 그때여야 한다 (⑮ 와 같은 파라미터). 벌어뜨려 놓고 잰다.
const d요청시각 = Date.now()
const 낡은스냅샷 = { snapshot: { workspaces: [workspace], tabs: [tab], panes: [pane] } }
await new Promise((resolve) => setTimeout(resolve, 5))
apply(d, 'tab_closed', { tab_id: tab.tab_id })
const d닫은간격ms = Date.now() - d요청시각 // 0 이면 경주 위 — 이 값이 양수여야 결정적이다
const d닫은직후 = snap(d)
const d재동기 = d.reconcile(낡은스냅샷, d요청시각)
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
    전제: '사진은 닫기 전에 뜬 것이다 — 요청 시각도 그때 (F3-M1)',
    '요청시각과 닫기의 간격ms': d닫은간격ms,
    '결정적인가 (간격 > 0)': d닫은간격ms > 0,
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

// ── 수정 2회차: **corral 이 일부를 모르는 상태**에서 출발하는 재생 ─────────────
// ⑬ 형제 탭을 모른 채 아는 마지막 탭이 닫힌다 → 진실 스냅샷으로 재동기.
const n = new WorkspaceStore()
apply(n, 'workspace_created', { workspace })
apply(n, 'tab_created', { tab })
// ← tab_created(t2) **유실**. herdr 에는 t2 가 있다.
const n닫기전 = snap(n)
const n닫음 = apply(n, 'tab_closed', { tab_id: tab.tab_id, workspace_id: 'wX' })
const n닫은직후 = snap(n)
await new Promise((resolve) => setTimeout(resolve, 5))
const n재동기 = n.reconcile({ snapshot: { workspaces: [workspace], tabs: [tab2], panes: [] } }, Date.now())
const n재동기뒤 = snap(n)

// ⑭ 같은 사각의 pane_exited 판 — 형제 pane(p2)을 모른다.
const o = new WorkspaceStore()
apply(o, 'workspace_created', { workspace })
apply(o, 'tab_created', { tab })
apply(o, 'pane_created', { pane })
// ← pane_created(p2) **유실**. herdr 에는 같은 탭에 p2 가 있다.
const o닫음 = apply(o, 'pane_exited', { pane_id: pane.pane_id })
const o닫은직후 = snap(o)
await new Promise((resolve) => setTimeout(resolve, 5))
const o재동기 = o.reconcile({ snapshot: { workspaces: [workspace], tabs: [tab], panes: [pane2] } }, Date.now())
const o재동기뒤 = snap(o)

// ⑮ 반대 방향 — 낡은 사진이 **진짜** 묘비를 걷지는 않는가.
const q = new WorkspaceStore()
apply(q, 'workspace_created', { workspace })
apply(q, 'tab_created', { tab })
apply(q, 'pane_created', { pane })
const q요청시각 = Date.now()
const q낡은사진 = { snapshot: { workspaces: [workspace], tabs: [tab], panes: [pane] } }
await new Promise((resolve) => setTimeout(resolve, 5))
apply(q, 'workspace_closed', { workspace_id: 'wX' })
const q재동기 = q.reconcile(q낡은사진, q요청시각)
const q재동기뒤 = snap(q)

// ⑯ L-1 — 한 층만 든 응답.
const r = new WorkspaceStore()
apply(r, 'workspace_created', { workspace })
apply(r, 'tab_created', { tab })
apply(r, 'pane_created', { pane })
await new Promise((resolve) => setTimeout(resolve, 5))
const r재동기 = r.reconcile({ tabs: [tab] }, Date.now())
const r재동기뒤 = snap(r)
// 그 뒤 **정상** 스냅샷으로 회복되나 (1회차·fix1 은 영구 묘비라 회복 안 됐다).
const r정상 = r.reconcile({ snapshot: { workspaces: [workspace], tabs: [tab], panes: [pane] } }, Date.now() + 1000)
const r회복뒤 = snap(r)

// ⑰ L-5 — tab_created 가 뒤집혀 도착한다.
const u = new WorkspaceStore()
apply(u, 'workspace_created', { workspace })
apply(u, 'tab_created', { tab: three[1] })
apply(u, 'tab_created', { tab: three[0] })
const u도착순뒤 = u.rows()[0].tabs.map((item) => ({ tabId: item.tabId, number: item.number, order: item.order }))

/**
 * ⑱ **에이전트를 뗀 뒤 이름이 도로 붙는가** (수정 3회차 — 이번 회차 N8 이 잡은 자리).
 *
 * `pane.release_agent` 때 herdr 는 **두 커넥션**으로 말한다 (probe 실측):
 *   agent 구독 `pane.agent_status_changed {agent:"claude", agent_status:"unknown"}`
 *   본 구독    `pane_agent_detected {agent:"claude", released:true}`
 * 뒤 진실은 `agent: null`. 두 줄은 순서가 안 정해지므로 **두 순서 다** 이름이 없어야 한다.
 */
const 뗌 = (순서) => {
  const store = new WorkspaceStore()
  const go = (event, data) => store.applyEvent({ event, data })
  go('workspace_created', { workspace })
  go('tab_created', { tab })
  go('pane_created', { pane })
  go('pane_agent_detected', { pane_id: pane.pane_id, workspace_id: 'wX', agent: 'claude' })
  go('pane_agent_status_changed', { pane_id: pane.pane_id, workspace_id: 'wX', agent: 'claude', agent_status: 'working' })
  const 붙은뒤 = store.rows()[0].tabs[0].panes[0]
  const 상태줄 = () =>
    go('pane_agent_status_changed', { pane_id: pane.pane_id, workspace_id: 'wX', agent: 'claude', agent_status: 'unknown' })
  const 뗌줄 = () =>
    go('pane_agent_detected', { pane_id: pane.pane_id, workspace_id: 'wX', agent: 'claude', released: true, final_status: 'unknown' })
  if (순서 === '상태먼저') { 상태줄(); 뗌줄() } else { 뗌줄(); 상태줄() }
  const 뗀뒤 = store.rows()[0].tabs[0].panes[0]
  return { 순서, 붙은뒤: { agent: 붙은뒤.agent, agentStatus: 붙은뒤.agentStatus }, 뗀뒤: { agent: 뗀뒤.agent, agentStatus: 뗀뒤.agentStatus } }
}
const 뗌상태먼저 = 뗌('상태먼저')
const 뗌뗌먼저 = 뗌('뗌먼저')

out['⑬ H-1 형제 탭을 모른 채 tab_closed → 진실 스냅샷 재동기'] = {
  전제: 'tab_created(wX:t2) 를 못 받았다 (push 유실 1건). herdr 에는 t2 가 살아 있다',
  닫기전: n닫기전,
  닫은note: n닫음.note,
  닫은직후: n닫은직후,
  재동기결과: n재동기,
  재동기뒤: n재동기뒤,
  '산 workspace 가 돌아왔나': n재동기뒤.workspaces.includes('wX'),
  '산 탭이 돌아왔나': n재동기뒤.tabs.includes('wX:t2'),
  '걷어 낸 묘비': n재동기.lifted,
}
out['⑭ H-1 형제 pane 을 모른 채 pane_exited → 진실 스냅샷 재동기'] = {
  전제: 'pane_created(wX:p2) 를 못 받았다. herdr 에는 같은 탭에 p2 가 있다',
  닫은note: o닫음.note,
  닫은직후: o닫은직후,
  재동기결과: o재동기,
  재동기뒤: o재동기뒤,
  '산 workspace 가 돌아왔나': o재동기뒤.workspaces.includes('wX'),
  '산 탭이 돌아왔나': o재동기뒤.tabs.includes(tab.tab_id),
  '산 pane 이 돌아왔나': o재동기뒤.panes.includes(pane2.pane_id),
  '죽은 pane 은 그대로 죽었나': !o재동기뒤.panes.includes(pane.pane_id),
  '걷어 낸 묘비': o재동기.lifted,
}
out['⑮ 낡은 사진이 진짜 묘비를 걷나 (걷으면 안 된다)'] = {
  전제: '사진은 닫기 **전에** 요청됐다. 묘비 시각 > 요청 시각이라 걷지 않아야 한다',
  재동기결과: q재동기,
  재동기뒤: q재동기뒤,
  workspace부활: q재동기뒤.workspaces.includes('wX'),
  '걷어 낸 묘비': q재동기.lifted,
}
out['⑯ L-1 한 층만 든 응답'] = {
  재동기결과: { note: r재동기.note, changed: r재동기.changed, removed: r재동기.removed },
  재동기뒤: r재동기뒤,
  목록전멸했나: r재동기뒤.panes.length === 0 || r재동기뒤.workspaces.length === 0,
  '정상 스냅샷으로 회복되나': r회복뒤.panes.includes(pane.pane_id),
  회복note: r정상.note,
}
out['⑱ 에이전트를 뗀 뒤 상태 줄이 이름을 도로 붙이나'] = {
  전제: 'release_agent 때 herdr 가 보내는 두 줄(상태 구독·본 구독)은 순서가 안 정해진다. 둘 다 agent:"claude" 를 싣는다',
  진실: 'pane.list 의 agent 는 null · agent_status 는 unknown (probe 실측)',
  상태먼저: 뗌상태먼저,
  뗌먼저: 뗌뗌먼저,
  '이름이 남았나 (상태먼저)': 뗌상태먼저.뗀뒤.agent !== null,
  '이름이 남았나 (뗌먼저)': 뗌뗌먼저.뗀뒤.agent !== null,
  '두 순서 다 이름이 지워졌나': 뗌상태먼저.뗀뒤.agent === null && 뗌뗌먼저.뗀뒤.agent === null,
  '붙을 때는 이름이 붙나': 뗌상태먼저.붙은뒤.agent === 'claude' && 뗌뗌먼저.붙은뒤.agent === 'claude',
}
out['⑰ L-5 뒤집혀 도착한 tab_created'] = {
  도착순: ['wX:t2', 'wX:t1'],
  화면순서: u도착순뒤,
  '도착순으로 굳었나': u도착순뒤.map((item) => item.tabId).join(',') !== 'wX:t1,wX:t2',
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
  '⑮ 낡은 사진이 진짜 묘비를 걷었나': out['⑮ 낡은 사진이 진짜 묘비를 걷나 (걷으면 안 된다)'].workspace부활,
  '⑯ 한 층만 든 응답이 목록을 지웠나': out['⑯ L-1 한 층만 든 응답'].목록전멸했나,
  '⑰ 도착순으로 굳었나': out['⑰ L-5 뒤집혀 도착한 tab_created']['도착순으로 굳었나'],
  '⑱ 뗀 뒤에도 이름이 남았나 (상태먼저)': out['⑱ 에이전트를 뗀 뒤 상태 줄이 이름을 도로 붙이나']['이름이 남았나 (상태먼저)'],
  '⑱ 뗀 뒤에도 이름이 남았나 (뗌먼저)': out['⑱ 에이전트를 뗀 뒤 상태 줄이 이름을 도로 붙이나']['이름이 남았나 (뗌먼저)'],
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
  '⑬ 재동기가 산 workspace 를 되살린다': out['⑬ H-1 형제 탭을 모른 채 tab_closed → 진실 스냅샷 재동기']['산 workspace 가 돌아왔나'],
  '⑬ 재동기가 산 탭을 되살린다': out['⑬ H-1 형제 탭을 모른 채 tab_closed → 진실 스냅샷 재동기']['산 탭이 돌아왔나'],
  '⑭ 재동기가 산 pane 을 되살린다': out['⑭ H-1 형제 pane 을 모른 채 pane_exited → 진실 스냅샷 재동기']['산 pane 이 돌아왔나'],
  '⑭ 죽은 pane 은 그대로 둔다': out['⑭ H-1 형제 pane 을 모른 채 pane_exited → 진실 스냅샷 재동기']['죽은 pane 은 그대로 죽었나'],
  '⑯ 한 층만 든 응답 뒤에도 정상 스냅샷으로 회복된다': out['⑯ L-1 한 층만 든 응답']['정상 스냅샷으로 회복되나'],
  '⑱ 붙을 때는 이름이 붙는다': out['⑱ 에이전트를 뗀 뒤 상태 줄이 이름을 도로 붙이나']['붙을 때는 이름이 붙나'],
  '④ 가 경주 위가 아니다 (요청시각 < 닫기)': out['④ 낡은 스냅샷으로 재동기 — 묘비가 버티는가']['결정적인가 (간격 > 0)'],
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

  /**
   * ⑬ **corral 이 형제 탭을 모른다.** `tab_created(t2)` 가 유실된 채 아는 마지막 탭(t1)이 닫힌다.
   * 그 뒤 **진실 스냅샷**으로 재동기한다 — herdr 에는 w1 과 t2 가 멀쩡히 살아 있다.
   * 되어야 하는 것: 재동기 뒤 w1·t2 가 보인다. (1회차·fix1 판은 목록이 비어 있고 note 가 "어긋난 것 없음")
   */
  const thirteen = new StoreClass()
  {
    const go = (event, data) => thirteen.applyEvent({ event, data })
    go('workspace_created', { workspace })
    go('tab_created', { tab })
    // ← 여기서 tab_created(t2) 를 **안 먹인다**. 그게 유실이다.
    go('tab_closed', { tab_id: tab.tab_id, workspace_id: 'wX' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    thirteen.reconcile({ snapshot: { workspaces: [workspace], tabs: [tab2], panes: [] } }, Date.now())
  }

  /** ⑭ 같은 사각의 `pane_exited` 판 — 형제 pane(p2)을 모른 채 아는 마지막 pane 이 exit 한다. */
  const fourteen = new StoreClass()
  {
    const go = (event, data) => fourteen.applyEvent({ event, data })
    go('workspace_created', { workspace })
    go('tab_created', { tab })
    go('pane_created', { pane })
    // ← pane_created(p2) 유실. herdr 에는 같은 탭에 p2 가 있다.
    go('pane_exited', { pane_id: pane.pane_id })
    await new Promise((resolve) => setTimeout(resolve, 5))
    fourteen.reconcile({ snapshot: { workspaces: [workspace], tabs: [tab], panes: [pane2] } }, Date.now())
  }

  /**
   * ⑮ **반대 방향** — 회복이 부활의 문이 되면 안 된다. 진짜로 닫힌 workspace 를,
   * 닫기 **전에** 뜬 낡은 사진으로 재동기해도 되살아나면 안 된다 (묘비 시각 ≥ 요청 시각).
   */
  const fifteen = new StoreClass()
  {
    const go = (event, data) => fifteen.applyEvent({ event, data })
    go('workspace_created', { workspace })
    go('tab_created', { tab })
    go('pane_created', { pane })
    const 낡은요청시각 = Date.now()
    const 낡은사진 = { snapshot: { workspaces: [workspace], tabs: [tab], panes: [pane] } }
    await new Promise((resolve) => setTimeout(resolve, 5))
    go('workspace_closed', { workspace_id: 'wX' })
    fifteen.reconcile(낡은사진, 낡은요청시각)
  }

  /** ⑯ L-1 — 한 층만 든 응답. 스냅샷으로 받으면 나머지 두 층이 전멸하고 영구 묘비가 박힌다. */
  const sixteen = new StoreClass()
  {
    const go = (event, data) => sixteen.applyEvent({ event, data })
    go('workspace_created', { workspace })
    go('tab_created', { tab })
    go('pane_created', { pane })
    await new Promise((resolve) => setTimeout(resolve, 5))
    sixteen.reconcile({ tabs: [tab] }, Date.now())
  }

  /** ⑱ 에이전트를 뗀 뒤 상태 줄이 이름을 도로 붙이는가 (두 순서 다 본다). */
  const 뗌판 = (순서) => {
    const store = new StoreClass()
    const go = (event, data) => store.applyEvent({ event, data })
    go('workspace_created', { workspace })
    go('tab_created', { tab })
    go('pane_created', { pane })
    go('pane_agent_detected', { pane_id: pane.pane_id, workspace_id: 'wX', agent: 'claude' })
    go('pane_agent_status_changed', { pane_id: pane.pane_id, workspace_id: 'wX', agent: 'claude', agent_status: 'working' })
    const 상태줄 = () =>
      go('pane_agent_status_changed', { pane_id: pane.pane_id, workspace_id: 'wX', agent: 'claude', agent_status: 'unknown' })
    const 뗌줄 = () =>
      go('pane_agent_detected', { pane_id: pane.pane_id, workspace_id: 'wX', agent: 'claude', released: true, final_status: 'unknown' })
    if (순서 === '상태먼저') { 상태줄(); 뗌줄() } else { 뗌줄(); 상태줄() }
    return store.rows()[0].tabs[0].panes[0].agent
  }

  /** ⑰ L-5 — `tab_created` 두 건이 **뒤집혀** 도착한다. 화면 순서가 도착순으로 굳는가. */
  const seventeen = run((store, go) => {
    go('workspace_created', { workspace })
    go('tab_created', { tab: three[1] }) // number 2 가 먼저 도착
    go('tab_created', { tab: three[0] }) // number 1 이 나중에
  })

  return {
    '⑬ 형제 탭을 모른 채 tab_closed — 재동기 뒤 산 workspace 가 보이나':
      ids(thirteen).tabs.includes('wX:t2') && thirteen.rows().some((row) => row.workspaceId === 'wX'),
    '⑭ 형제 pane 을 모른 채 pane_exited — 재동기 뒤 산 pane 이 보이나':
      ids(fourteen).panes.includes(pane2.pane_id) && fourteen.rows().some((row) => row.workspaceId === 'wX'),
    '⑮ 낡은 사진이 진짜 묘비를 걷나 (부활하면 true)': fifteen.rows().some((row) => row.workspaceId === 'wX'),
    '⑯ 한 층만 든 응답이 목록을 지웠나': ids(sixteen).panes.length === 0,
    '⑱ 뗀 뒤에도 이름이 남나 (상태먼저)': 뗌판('상태먼저') !== null,
    '⑱ 뗀 뒤에도 이름이 남나 (뗌먼저)': 뗌판('뗌먼저') !== null,
    '⑰ 뒤집힌 tab_created 가 도착순으로 굳나':
      seventeen.rows()[0].tabs.map((item) => item.tabId).join(',') !== 'wX:t1,wX:t2',
    '⑤ pane 부활 (형제 잔존 탭)': ids(five).panes.includes(pane.pane_id),
    '⑥ pane 부활 (재동기 삭제 뒤)': ids(six).panes.includes(pane.pane_id),
    '⑦ 상태 칩이 지워졌나': seven.rows()[0].tabs[0].panes[0].agentStatus !== 'blocked',
    '⑧ 모양 아닌 응답이 목록을 지웠나': ids(eight).tabs.length === 0,
    // 1회차에는 `eight !== null &&` 가 붙어 있었다 — ⑧ 의 저장소라 항상 참인 **죽은 항**이고
    // 붙여 넣기 흔적이었다 (수정 2회차 L-4). 판별식은 이 재생이 만든 것만 본다.
    '⑩ workspace 연쇄가 도는가': ten.rows().length === 0,
    '⑪ tab_moved 로 순서가 바뀌나':
      eleven.rows()[0].tabs.map((item) => item.tabId).join(',') === 'wX:t3,wX:t1,wX:t2',
  }
}

/**
 * 옛 판을 **태그/커밋에서 꺼내** 같은 재생을 먹인다 (플래그로 갈아 끼운 가짜 대조가 아니다).
 * 2회차에는 두 판을 본다 — 1회차 태그와 **수정 1회차 HEAD**(`7564173`). H-1 은 fix1 이 연
 * 자리라 r1 만 보면 "원래도 그랬다" 와 "이번에 열렸다" 가 안 갈린다.
 */
async function replayOnRef(ref, label) {
  const dir = fs.mkdtempSync(`/tmp/l351-${label}-`)
  execFileSync('git', ['-C', APP_DIR, 'worktree', 'add', '--detach', dir, ref], { stdio: 'ignore' })
  try {
    const old = await import(bundle(path.join(dir, 'app'), label))
    return await replayOn(old.WorkspaceStore)
  } finally {
    execFileSync('git', ['-C', APP_DIR, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' })
  }
}

const 음성대조 = {
  설명:
    '같은 재생을 옛 판 store 에 먹인 결과. 여기서 (지금과 다른 값이) 나와야 그 케이스가 판별자다. ' +
    '1회차 = 태그 LIFE-351-claude-r1 · 수정1회차 = 7564173 · 수정2회차 = 9b6cc87.',
  '1회차': await replayOnRef('LIFE-351-claude-r1', 'r1'),
  '수정1회차': await replayOnRef('7564173', 'fix1'),
  // 수정 3회차 — ⑱ 은 **수정 2회차 판**이 기준이다 (그 판까지 상태 줄이 이름을 집었다).
  '수정2회차': await replayOnRef('9b6cc87', 'fix2'),
  지금: await replayOn(WorkspaceStore),
}
out['⑫ 음성 대조 — 1회차 store 로 같은 재생'] = 음성대조
out.케이스가가르나 = {
  '⑤': 음성대조['1회차']['⑤ pane 부활 (형제 잔존 탭)'] === true && 음성대조.지금['⑤ pane 부활 (형제 잔존 탭)'] === false,
  '⑥': 음성대조['1회차']['⑥ pane 부활 (재동기 삭제 뒤)'] === true && 음성대조.지금['⑥ pane 부활 (재동기 삭제 뒤)'] === false,
  '⑦': 음성대조['1회차']['⑦ 상태 칩이 지워졌나'] === true && 음성대조.지금['⑦ 상태 칩이 지워졌나'] === false,
  '⑧': 음성대조['1회차']['⑧ 모양 아닌 응답이 목록을 지웠나'] === true && 음성대조.지금['⑧ 모양 아닌 응답이 목록을 지웠나'] === false,
  '⑩': 음성대조['1회차']['⑩ workspace 연쇄가 도는가'] === false && 음성대조.지금['⑩ workspace 연쇄가 도는가'] === true,
  '⑪': 음성대조['1회차']['⑪ tab_moved 로 순서가 바뀌나'] === false && 음성대조.지금['⑪ tab_moved 로 순서가 바뀌나'] === true,
  // 수정 2회차 — 기준은 **수정 1회차 판**이다 (H-1 은 fix1 이 연 자리).
  '⑬':
    음성대조['수정1회차']['⑬ 형제 탭을 모른 채 tab_closed — 재동기 뒤 산 workspace 가 보이나'] === false &&
    음성대조.지금['⑬ 형제 탭을 모른 채 tab_closed — 재동기 뒤 산 workspace 가 보이나'] === true,
  '⑭':
    음성대조['수정1회차']['⑭ 형제 pane 을 모른 채 pane_exited — 재동기 뒤 산 pane 이 보이나'] === false &&
    음성대조.지금['⑭ 형제 pane 을 모른 채 pane_exited — 재동기 뒤 산 pane 이 보이나'] === true,
  // ⑮ 는 **두 판이 같아야** 맞다 — 걷지 않는 쪽이 옳고, 고치면서 그 성질을 잃지 않았다는 뜻이다.
  '⑮ 두 판 모두 안 걷나':
    음성대조['수정1회차']['⑮ 낡은 사진이 진짜 묘비를 걷나 (부활하면 true)'] === false &&
    음성대조.지금['⑮ 낡은 사진이 진짜 묘비를 걷나 (부활하면 true)'] === false,
  '⑯':
    음성대조['수정1회차']['⑯ 한 층만 든 응답이 목록을 지웠나'] === true &&
    음성대조.지금['⑯ 한 층만 든 응답이 목록을 지웠나'] === false,
  '⑰':
    음성대조['수정1회차']['⑰ 뒤집힌 tab_created 가 도착순으로 굳나'] === true &&
    음성대조.지금['⑰ 뒤집힌 tab_created 가 도착순으로 굳나'] === false,
  // ⑱ 은 **수정 2회차 판**에서 한 순서(상태 줄이 나중)만 이름이 남는다 — 그래서 라이브에서
  // 운에 따라 통과하기도 했다. 지금은 두 순서 다 안 남아야 한다.
  '⑱ (수정2회차는 상태 줄이 이름을 도로 붙였다)':
    음성대조['수정2회차']['⑱ 뗀 뒤에도 이름이 남나 (뗌먼저)'] === true &&
    음성대조.지금['⑱ 뗀 뒤에도 이름이 남나 (뗌먼저)'] === false &&
    음성대조.지금['⑱ 뗀 뒤에도 이름이 남나 (상태먼저)'] === false,
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
