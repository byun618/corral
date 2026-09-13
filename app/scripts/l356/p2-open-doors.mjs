// P2 — 열기/만들기 문의 정확한 파라미터를 확정한다.
//
// P1 의 배움: worktree.open 은 "repo parent workspace" 에서 시작한다 (linked_worktree_source).
//   → open 은 **parent workspace 가 열려 있고** 그 workspace_id 를 줘야 하는 것으로 보인다.
//
// 여기서 확정할 것:
//   L6 열기: 닫힌 linked worktree 를 다시 여는 정확한 호출 (workspace_id + branch? path?)
//   L7 만들기: worktree.create 의 최소 파라미터 (P1 에서 이미 확인 — 재확인)
//   L8 빈 상태: workspace 0 인 상태에서 primary 를 여는 문 (workspace.create {cwd})
//              + 그 뒤 worktree.open 으로 linked 열기까지

import path from 'node:path'
import { SESSION, herdrCall, makeScratchRepo, sleep, writeRaw } from './lib.mjs'

const out = { session: SESSION, at: new Date().toISOString(), steps: [] }
function record(label, response, note = null) {
  out.steps.push({ label, note, ...response })
  console.log(`[${label}] ${response.error ? `error ${response.error.code}` : 'ok'} (${response.ms}ms)`)
  return response
}

const repo = makeScratchRepo('doors')
out.repo = { root: repo.root }
console.log('scratch repo:', repo.root)

// primary 열기 (빈 상태 복구의 문 — L8)
const primary = record('L8.workspace.create.primary', await herdrCall('workspace.create', { cwd: repo.root, focus: false }))
const primaryWs = primary.result?.workspace?.workspace_id

// linked 만들기 (L7)
const wtPath = path.join(path.dirname(repo.root), path.basename(repo.root) + '-wt1')
const createWt = record(
  'L7.worktree.create',
  await herdrCall('worktree.create', { workspace_id: primaryWs, branch: 'l356-doors-wt1', path: wtPath, focus: false }),
)
const linkedWs = createWt.result?.workspace?.workspace_id
const linkedTab = createWt.result?.tab?.tab_id

// 닫기 (L6 준비 — 닫힌 linked 를 만든다)
record('close.linked', await herdrCall('tab.close', { tab_id: linkedTab }))
await sleep(300)
record('worktree.list.after-close', await herdrCall('worktree.list', { cwd: repo.root }))

// L6 열기 후보들 — parent workspace_id 를 준다
record(
  'L6.open.workspace_id+branch',
  await herdrCall('worktree.open', { workspace_id: primaryWs, branch: 'l356-doors-wt1', focus: false }),
  'parent workspace_id + branch',
)
record('worktree.list.after-open-A', await herdrCall('worktree.list', { cwd: repo.root }))

// 다시 닫고 path 로도 시도
const afterA = out.steps[out.steps.length - 2]
if (!afterA.error) {
  const reopenedWs = afterA.result?.workspace?.workspace_id
  const reopenedTab = afterA.result?.tab?.tab_id
  out.reopened = { workspaceId: reopenedWs, tabId: reopenedTab, alreadyOpen: afterA.result?.already_open ?? null }
  if (reopenedTab) {
    record('close.linked.again', await herdrCall('tab.close', { tab_id: reopenedTab }))
    await sleep(300)
    record(
      'L6.open.workspace_id+path',
      await herdrCall('worktree.open', { workspace_id: primaryWs, path: wtPath, focus: false }),
      'parent workspace_id + path',
    )
    record('worktree.list.after-open-B', await herdrCall('worktree.list', { cwd: repo.root }))
  }
}

// 뒷정리
record('cleanup.close_group', await herdrCall('workspace.close', { workspace_id: primaryWs, close_group: true }))

writeRaw('p2-open-doors.json', out)
console.log('\n문 요약:')
for (const s of out.steps) {
  if (s.label.startsWith('L6') || s.label.startsWith('L7') || s.label.startsWith('L8')) {
    console.log(` ${s.label}: ${s.error ? `error ${s.error.code}` : 'ok'}`)
  }
}
