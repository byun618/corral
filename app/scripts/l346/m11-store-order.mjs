// M11 — 1차 리뷰 M4(3자 겹침): **닫힌 탭 아래로 늦게 온 pane 이 되살아나는가.**
//
// 세 리뷰가 같은 자리를 가리켰다: `putPane()` 이 탭 존재를 안 본다. 탭이 지워진 뒤 늦은
// `pane_created`/`pane_updated` 가 오면 pane 만 맵에 부활해서 **탭 목록에는 안 보이는데**
// `paneCount` 는 늘고 `knownPaneIds` 에는 산 것으로 잡힌다.
//
// 원자료에 실패가 없었던 이유는 단순하다 — **그 순서를 눌러 본 적이 없다** (codex 낮음3 이
// "즉시 close 또는 지연 pane_created 주입 테스트가 필요하다" 고 적은 것이 이것이다).
// 그래서 여기서는 앱을 띄우지 않고 **store 에 직접** 그 순서를 먹인다. 같은 순서를 1회차
// store(`git show` 로 꺼낸 그 파일)와 고친 store 양쪽에 먹여 나란히 적는다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, REPO_DIR, writeRaw } from './lib.mjs'

const HERDR_DIR = path.join(APP_DIR, 'src/main/herdr')
const R1_REF = 'f59de62' // 1차 판정 대상 커밋 (verdict.md)

/** store.ts 한 판을 번들해 import 한다 — electron 없이 순수 로직만 돌린다. */
async function loadStore(sourcePath, label) {
  const outFile = path.join(fs.mkdtempSync('/tmp/l346-store-'), `${label}.mjs`)
  execFileSync(path.join(APP_DIR, 'node_modules/.bin/esbuild'), [
    sourcePath,
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${outFile}`,
  ])
  const module = await import(outFile)
  return module.WorkspaceStore
}

const workspace = { workspace_id: 'wX', label: 'l346', focused: true }
const tab = { tab_id: 'wX:t1', workspace_id: 'wX', label: '1', number: 1 }
const pane = { pane_id: 'wX:p1', workspace_id: 'wX', tab_id: 'wX:t1', title: 'zsh', revision: 1 }

/**
 * 두 순서를 먹인다.
 *   ① `tab.close` 경로 — tab_closed 뒤에 늦은 `pane_updated`
 *   ② 사용자 `exit` 경로 — pane_exited(탭까지 지움) 뒤에 늦은 `pane_created`
 * 그리고 닫힌 탭의 늦은 `tab_created` 도 같이 본다.
 */
function run(StoreClass) {
  const seen = []
  const apply = (store, event, data) => {
    const result = store.applyEvent({ event, data })
    seen.push({ event, changed: result.changed, note: result.note })
    return result
  }
  const snapshot = (store) => {
    const rows = store.rows()
    return {
      workspaces: rows.map((row) => row.workspaceId),
      tabs: rows.flatMap((row) => row.tabs.map((item) => item.tabId)),
      panes: rows.flatMap((row) => row.panes.map((item) => item.paneId)),
      paneCount: rows.map((row) => `${row.workspaceId}:${row.paneCount}`),
    }
  }

  // ① tab.close 뒤 늦은 pane_updated
  const a = new StoreClass()
  apply(a, 'workspace_created', { workspace })
  apply(a, 'tab_created', { tab })
  apply(a, 'pane_created', { pane })
  const aBefore = snapshot(a)
  apply(a, 'tab_closed', { tab_id: tab.tab_id })
  const aClosed = snapshot(a)
  apply(a, 'pane_updated', { pane: { ...pane, revision: 2 } })
  apply(a, 'tab_created', { tab })
  const aAfter = snapshot(a)

  // ② pane_exited(마지막 pane) 뒤 늦은 pane_created
  const b = new StoreClass()
  apply(b, 'workspace_created', { workspace })
  apply(b, 'tab_created', { tab })
  apply(b, 'pane_created', { pane })
  apply(b, 'tab_created', { tab: { ...tab, tab_id: 'wX:t2', number: 2 } })
  apply(b, 'pane_created', { pane: { pane_id: 'wX:p2', workspace_id: 'wX', tab_id: 'wX:t2', revision: 1 } })
  apply(b, 'pane_exited', { pane_id: pane.pane_id })
  const bClosed = snapshot(b)
  apply(b, 'pane_created', { pane: { ...pane, revision: 3 } })
  const bAfter = snapshot(b)

  return {
    '① tab_closed 뒤 늦은 pane_updated': {
      닫기전: aBefore,
      닫은직후: aClosed,
      늦은이벤트적용후: aAfter,
      pane부활: aAfter.panes.includes(pane.pane_id),
      탭부활: aAfter.tabs.includes(tab.tab_id),
    },
    '② pane_exited 뒤 늦은 pane_created': {
      닫은직후: bClosed,
      늦은이벤트적용후: bAfter,
      pane부활: bAfter.panes.includes(pane.pane_id),
    },
    적용note: seen,
  }
}

// 1회차 store 를 그 커밋에서 꺼내 같은 폴더에 잠깐 둔다 (상대 import 가 풀리게).
const r1Path = path.join(HERDR_DIR, 'store.r1.tmp.ts')
fs.writeFileSync(r1Path, execFileSync('git', ['show', `${R1_REF}:app/src/main/herdr/store.ts`], { cwd: REPO_DIR }))
let out
try {
  const R1 = await loadStore(r1Path, 'r1')
  const NOW = await loadStore(path.join(HERDR_DIR, 'store.ts'), 'fix1')
  out = {
    at: new Date().toISOString(),
    질문: '탭이 지워진 뒤 늦게 온 pane 이벤트가 pane 을 되살리는가',
    '1회차': { ref: R1_REF, ...run(R1) },
    '수정1회차': { ref: 'working tree', ...run(NOW) },
  }
} finally {
  fs.rmSync(r1Path, { force: true })
}
out.판정 = {
  '1회차 ①에서 pane 부활': out['1회차']['① tab_closed 뒤 늦은 pane_updated'].pane부활,
  '1회차 ②에서 pane 부활': out['1회차']['② pane_exited 뒤 늦은 pane_created'].pane부활,
  '수정 ①에서 pane 부활': out['수정1회차']['① tab_closed 뒤 늦은 pane_updated'].pane부활,
  '수정 ②에서 pane 부활': out['수정1회차']['② pane_exited 뒤 늦은 pane_created'].pane부활,
}
console.log(JSON.stringify(out.판정, null, 2))
writeRaw('m4-store-ordering.json', out)
