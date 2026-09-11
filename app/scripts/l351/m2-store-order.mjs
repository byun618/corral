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

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, writeRaw } from './lib.mjs'

/** store.ts 한 판을 번들해 import 한다 — electron 없이 순수 로직만 돌린다. */
const outFile = path.join(fs.mkdtempSync('/tmp/l351-store-'), 'store.mjs')
execFileSync(path.join(APP_DIR, 'node_modules/.bin/esbuild'), [
  path.join(APP_DIR, 'src/main/adapter/internal/store.ts'),
  '--bundle',
  '--format=esm',
  '--platform=node',
  `--outfile=${outFile}`,
])
const { WorkspaceStore } = await import(outFile)

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
out.판정 = {
  '① pane 부활': out['① tab_closed 뒤 늦은 pane_updated·tab_created'].pane부활,
  '① 탭 부활': out['① tab_closed 뒤 늦은 pane_updated·tab_created'].탭부활,
  '② pane 부활': out['② pane_exited 뒤 늦은 pane_created'].pane부활,
  '③ workspace 부활': out['③ 마지막 탭 pane_exited 뒤 늦은 tab_created·pane_created·workspace_created'].workspace부활,
  '③ 늦은 탭 부활': out['③ 마지막 탭 pane_exited 뒤 늦은 tab_created·pane_created·workspace_created'].늦은탭이붙었나,
  '③ 유령 workspace 행': out['③ 마지막 탭 pane_exited 뒤 늦은 tab_created·pane_created·workspace_created']['유령 workspace 행'],
  '④ 재동기가 되살림': out['④ 낡은 스냅샷으로 재동기 — 묘비가 버티는가'].탭부활,
  '④b 새 행을 지웠나': !out['④b 스냅샷보다 나중에 생긴 행을 재동기가 지우는가']['새 탭이 살아남았나'],
}
out.부활건수 = Object.entries(out.판정).filter(([, value]) => value === true).length
console.log(JSON.stringify({ 판정: out.판정, 부활건수: out.부활건수 }, null, 2))
writeRaw('n6-store-order.json', out)
