// P3 — parent workspace 가 **닫힌** 상태에서 worktree.open 이 되나 / workspace_id 없이 되나.
// L6·L8 문 설계의 마지막 갈림: linked 를 열려면 parent 를 먼저 열어야 하는가?

import path from 'node:path'
import { SESSION, herdrCall, makeScratchRepo, sleep, writeRaw } from './lib.mjs'

const out = { session: SESSION, at: new Date().toISOString(), steps: [] }
function record(label, response, note = null) {
  out.steps.push({ label, note, ...response })
  console.log(`[${label}] ${response.error ? `error ${response.error.code}` : 'ok'} (${response.ms}ms)`)
  return response
}

const repo = makeScratchRepo('p3')
out.repo = { root: repo.root }

// 만들고 그룹 통째로 닫아 workspace 0 상태로 (linked worktree 는 git 에 남는다)
const primary = record('workspace.create.primary', await herdrCall('workspace.create', { cwd: repo.root, focus: false }))
const primaryWs = primary.result?.workspace?.workspace_id
const wtPath = path.join(path.dirname(repo.root), path.basename(repo.root) + '-wt1')
record('worktree.create', await herdrCall('worktree.create', { workspace_id: primaryWs, branch: 'l356-p3-wt1', path: wtPath, focus: false }))
record('close_group', await herdrCall('workspace.close', { workspace_id: primaryWs, close_group: true }))
await sleep(400)
record('workspace.list.empty', await herdrCall('workspace.list', {}))
// git 에는 linked worktree 가 남아 있나
record('worktree.list.after-closeall', await herdrCall('worktree.list', { cwd: repo.root }))

// 시도 A: workspace_id 없이 cwd 로 worktree.open (parent 닫힌 상태)
record(
  'A.worktree.open.cwd-only',
  await herdrCall('worktree.open', { cwd: wtPath, path: wtPath, focus: false }),
  'parent 닫힘 · workspace_id 없이 cwd+path',
)

// 시도 B: parent 를 workspace.create 로 먼저 열고 그 id 로 open
const reopenParent = record('B.workspace.create.reopen-parent', await herdrCall('workspace.create', { cwd: repo.root, focus: false }))
const parent2 = reopenParent.result?.workspace?.workspace_id
record(
  'B.worktree.open.with-parent',
  await herdrCall('worktree.open', { workspace_id: parent2, path: wtPath, focus: false }),
  'parent 다시 연 뒤 그 id 로 linked open',
)
record('worktree.list.final', await herdrCall('worktree.list', { cwd: repo.root }))

record('cleanup.close_group', await herdrCall('workspace.close', { workspace_id: parent2, close_group: true }))
writeRaw('p3-open-parent-closed.json', out)
console.log('\n요약:')
for (const s of out.steps) if (/^[AB]\./.test(s.label)) console.log(` ${s.label}: ${s.error ? s.error.code : 'ok'}`)
