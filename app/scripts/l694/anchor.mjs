// 격리 세션 준비 — ① 등록 레포 r 의 main 카드를 제 workspace 로 먼저 연다(herdr 는 레포 안 cwd 의 workspace 를 main checkout 에 묶고
// 먼저 묶인 것이 `open_workspace_id` 로 남는다 — 사용자 환경처럼 main 이 열려 있어야 관문용 workspace 들이 카드 밖이 된다, g02 실패 원인).
// ② 포커스를 쥘 anchor workspace(카드 밖·살아 있는 경로) — 장면 pane 들이 포커스 안 된 상태로 done 이 서게.
import fs from 'node:fs'
import path from 'node:path'
import { checkRoot, rpc, sleep } from './lib.mjs'
const root = process.argv[2]
checkRoot(root)
const repo = path.join(fs.realpathSync(root), 'repos/r')
const main = await rpc(root, 'worktree.open', { cwd: repo, path: repo, trust_repository: true, focus: false })
await sleep(1000)
const anchor = await rpc(root, 'workspace.create', { cwd: fs.realpathSync(root), label: 'anchor', focus: true })
const list = await rpc(root, 'worktree.list', { cwd: repo })
console.log(JSON.stringify({ main: main.workspace.workspace_id, anchor: anchor.workspace.workspace_id, anchorPane: anchor.root_pane.pane_id, open: list.worktrees.map((item) => [item.path, item.open_workspace_id]) }))
