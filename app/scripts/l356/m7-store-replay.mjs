// M7 — L5 재측정: 「늦은 push 재생 1케이스」를 **store 단위**로 실행 (수정 1회차 M2).
//
// 왜 store 단위인가: 제품 제어 채널엔 raw push 주입 손잡이가 없고(push-drop·resync 뿐), herdr 는
// 인과 순서로만 push 하므로 죽은 pane 의 늦은 pane_updated 를 앱 경로로 만들 수 없다. R1(LIFE-351)
// N6 이 store.ts 를 esbuild 로 번들해 직접 이벤트를 먹여 같은 종류를 쟀다 — 그 방법을 재사용한다.
// **측정 표면(store 단위)은 제품 표면이 아니다** (판정 M2). 이 diff 는 store 를 안 건드리므로
// LIFE-346 M4 의 묘비 적대 검증이 동일 코드에 유효하고, 여기선 그 유효성을 재현해 남긴다.
//
// 재생 벡터 (전부 "닫은 뒤 늦게 온 이벤트가 행을 되살리나"):
//   ① tab_closed 뒤 늦은 pane_updated + 늦은 tab_created
//   ⑤ 형제 pane 이 남는 탭에서 pane 하나만 닫고 늦은 pane_updated (H1ⓐ — 1회차엔 부활했던 자리)
//   ④ 닫힌 행이 든 낡은 스냅샷으로 재동기 (묘비를 걷지 않는가 — 회복이 부활의 문이 되면 안 된다)
// 통과선: 어느 벡터에서도 닫힌 pane·tab 이 되살아나지 않는다 (부활 0).

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, RAW_DIR, RAW_SUBDIR, writeRaw } from './lib.mjs'

/** store.ts 한 판을 번들해 import 한다 — electron 없이 순수 로직만 (l351 m2-store-order 방식). */
function bundle() {
  const outFile = path.join(fs.mkdtempSync('/tmp/l356-store-'), 'store.mjs')
  execFileSync(path.join(APP_DIR, 'node_modules/.bin/esbuild'), [
    path.join(APP_DIR, 'src/main/adapter/internal/store.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${outFile}`,
  ])
  return outFile
}
const storeSrc = path.join(APP_DIR, 'src/main/adapter/internal/store.ts')
const { WorkspaceStore } = await import(bundle())

const out = { at: new Date().toISOString(), method: 'store 단위 재생 (esbuild 번들, R1 N6 방식)', storeSha256: crypto.createHash('sha256').update(fs.readFileSync(storeSrc)).digest('hex'), vectors: {} }

const workspace = { workspace_id: 'wX', label: 'l356', number: 1, focused: true }
const tab = { tab_id: 'wX:t1', workspace_id: 'wX', label: '1', number: 1 }
const pane = { pane_id: 'wX:p1', workspace_id: 'wX', tab_id: 'wX:t1', title: 'zsh', revision: 1 }

function apply(store, event, data) {
  return store.applyEvent({ event, data })
}
function snap(store) {
  const rows = store.rows()
  return {
    workspaces: rows.map((r) => r.workspaceId),
    tabs: rows.flatMap((r) => r.tabs.map((t) => t.tabId)),
    panes: rows.flatMap((r) => r.tabs.flatMap((t) => t.panes.map((p) => p.paneId))),
  }
}

// ── ① tab_closed 뒤 늦은 pane_updated + 늦은 tab_created ──────────────────────
{
  const s = new WorkspaceStore()
  apply(s, 'workspace_created', { workspace })
  apply(s, 'tab_created', { tab })
  apply(s, 'pane_created', { pane })
  const opened = snap(s)
  apply(s, 'tab_closed', { tab_id: tab.tab_id })
  const afterClose = snap(s)
  // 늦게 온 것들 — 닫힌 pane 을 갱신하고, 닫힌 탭을 다시 만든다
  const r1 = apply(s, 'pane_updated', { pane: { ...pane, revision: 2 } })
  const r2 = apply(s, 'tab_created', { tab })
  const afterLate = snap(s)
  out.vectors.tabClosedLatePane = {
    opened,
    afterClose,
    afterLate,
    lateNotes: [r1.note, r2.note],
    revived: afterLate.panes.includes(pane.pane_id) || afterLate.tabs.includes(tab.tab_id),
  }
}

// ── ⑤ 형제 pane 남는 탭에서 pane 하나만 닫고 늦은 pane_updated (H1ⓐ) ──────────
{
  const s = new WorkspaceStore()
  const paneA = { ...pane, pane_id: 'wX:pA' }
  const paneB = { ...pane, pane_id: 'wX:pB' }
  apply(s, 'workspace_created', { workspace })
  apply(s, 'tab_created', { tab })
  apply(s, 'pane_created', { pane: paneA })
  apply(s, 'pane_created', { pane: paneB })
  const opened = snap(s)
  apply(s, 'pane_closed', { pane_id: paneA.pane_id }) // 형제(B)는 남는다 → 탭도 산다
  const afterClose = snap(s)
  const r = apply(s, 'pane_updated', { pane: { ...paneA, revision: 5 } }) // 닫힌 A 에 늦은 갱신
  const afterLate = snap(s)
  out.vectors.siblingPaneLateUpdate = {
    opened,
    afterClose,
    afterLate,
    lateNote: r.note,
    siblingSurvived: afterLate.panes.includes(paneB.pane_id),
    revived: afterLate.panes.includes(paneA.pane_id),
  }
}

// ── ④ 닫힌 행이 든 낡은 스냅샷으로 재동기 (묘비 유지 — 부활 아님) ──────────────
{
  const s = new WorkspaceStore()
  apply(s, 'workspace_created', { workspace })
  apply(s, 'tab_created', { tab })
  apply(s, 'pane_created', { pane })
  const requestedAt = Date.now() // 스냅샷을 요청한 시각 (닫기 **전**)
  const staleSnapshot = { workspaces: [workspace], tabs: [tab], panes: [pane] } // 아직 다 살아있는 사진
  await new Promise((r) => setTimeout(r, 5))
  apply(s, 'tab_closed', { tab_id: tab.tab_id }) // 사진을 요청한 뒤에 닫힘 → 묘비는 requestedAt 이후
  const afterClose = snap(s)
  const rec = s.reconcile(staleSnapshot, requestedAt) // 낡은 사진으로 재동기
  const afterReconcile = snap(s)
  out.vectors.staleSnapshotReconcile = {
    afterClose,
    afterReconcile,
    reconcileNote: rec.note,
    keptNewer: rec.keptNewer,
    lifted: rec.lifted,
    revived: afterReconcile.tabs.includes(tab.tab_id) || afterReconcile.panes.includes(pane.pane_id),
  }
}

const revivedAny = Object.values(out.vectors).some((v) => v.revived)
out.summary = {
  vectors: Object.keys(out.vectors).length,
  latePaneUpdateRevived: out.vectors.tabClosedLatePane.revived,
  siblingCaseRevived: out.vectors.siblingPaneLateUpdate.revived,
  siblingSurvived: out.vectors.siblingPaneLateUpdate.siblingSurvived,
  staleReconcileRevived: out.vectors.staleSnapshotReconcile.revived,
  anyRevived: revivedAny,
}
out.verdict = !revivedAny && out.vectors.siblingPaneLateUpdate.siblingSurvived ? 'PASS' : 'FAIL'

void RAW_DIR
void RAW_SUBDIR
writeRaw('m7-store-replay.json', out)
console.log('M7(L5 store 재생):', out.verdict, JSON.stringify(out.summary))
if (out.verdict !== 'PASS') process.exitCode = 1
