// P4 — 전부 닫힌 상태에서 worktree.open { cwd: **레포 루트**, path } 가 되나.
// P3 A 는 cwd 에 linked 경로를 줬다(오류 linked_worktree_source). herdr-studio 는
// openWorktreeFromCwd(repoRoot) 를 쓴다 — 그 조합이 0.9.0 에서 성립하는지, 성립하면
// 부모 workspace 가 딸려 열리는지(issue #4032 의 미보고 자동 생성)를 확정한다.

import path from 'node:path'
import { SESSION, herdrCall, makeScratchRepo, sleep, writeRaw } from './lib.mjs'

const out = { session: SESSION, at: new Date().toISOString(), steps: [] }
function record(label, response, note = null) {
  out.steps.push({ label, note, ...response })
  console.log(`[${label}] ${response.error ? `error ${response.error.code}: ${response.error.message}` : 'ok'} (${response.ms}ms)`)
  return response
}

const repo = makeScratchRepo('p4')
out.repo = { root: repo.root }

const primary = record('setup.workspace.create', await herdrCall('workspace.create', { cwd: repo.root, focus: false }))
const primaryWs = primary.result?.workspace?.workspace_id
const wtPath = path.join(path.dirname(repo.root), path.basename(repo.root) + '-wt1')
record('setup.worktree.create', await herdrCall('worktree.create', { workspace_id: primaryWs, branch: 'l356-p4-wt1', path: wtPath, focus: false }))
record('setup.close_group', await herdrCall('workspace.close', { workspace_id: primaryWs, close_group: true }))
await sleep(400)
const before = record('before.workspace.list', await herdrCall('workspace.list', {}))
out.workspacesBefore = (before.result?.workspaces ?? []).map((w) => [w.workspace_id, w.label])

// 핵심: 전부 닫힘 + cwd=레포 루트
const open = record(
  'A.worktree.open.cwd-repo-root',
  await herdrCall('worktree.open', { cwd: repo.root, path: wtPath, focus: false }),
  '전부 닫힘 · cwd=레포 루트 · path=linked',
)

await sleep(600)
const after = record('after.workspace.list', await herdrCall('workspace.list', {}))
out.workspacesAfter = (after.result?.workspaces ?? []).map((w) => [w.workspace_id, w.label, w.worktree?.is_linked_worktree ?? null])

// branch 로도 되나 (path 대신)
if (open.error) {
  record('B.worktree.open.cwd-branch', await herdrCall('worktree.open', { cwd: repo.root, branch: 'l356-p4-wt1', focus: false }), '전부 닫힘 · cwd=레포 루트 · branch')
  await sleep(600)
  const afterB = record('after-B.workspace.list', await herdrCall('workspace.list', {}))
  out.workspacesAfterB = (afterB.result?.workspaces ?? []).map((w) => [w.workspace_id, w.label, w.worktree?.is_linked_worktree ?? null])
}

// 정리 — p4 스크래치의 workspace 전부 닫기
const list = await herdrCall('workspace.list', {})
for (const w of list.result?.workspaces ?? []) {
  if (String(w.label ?? '').includes('l356-p4')) {
    await herdrCall('workspace.close', { workspace_id: w.workspace_id, close_group: true })
  }
}
await sleep(300)
const final = record('cleanup.workspace.list', await herdrCall('workspace.list', {}))
out.workspacesFinal = (final.result?.workspaces ?? []).map((w) => [w.workspace_id, w.label])

writeRaw('p4-open-cwd-root.json', out)
console.log('\n요약: before', JSON.stringify(out.workspacesBefore), '→ after', JSON.stringify(out.workspacesAfter))
