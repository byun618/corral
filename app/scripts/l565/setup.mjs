// 레포 등록 → 이 구현 worktree 행에 pane 1개. 사용: node setup.mjs <레포 본체> <worktree>
import { control, state, until, termRead, pause } from './lib.mjs'
const [repoRoot, wt] = process.argv.slice(2)
const live = await until(async () => { const s = await state(); return s.link?.phase === 'live' ? s : null }, 'live', 60_000)
console.log('live', JSON.stringify({ selectedSession: live.selectedSession, backend: live.backend?.kind }))
console.log('add-repo', JSON.stringify(await control({ cmd: 'add-repo', root: repoRoot })).slice(0, 200))
const s0 = await until(async () => { const s = await state(); return (s.repos ?? []).length > 0 ? s : null }, 'repos')
const rows = s0.repos.flatMap((r) => r.worktrees ?? [])
console.log('rows', rows.length, 'target present', rows.some((r) => r.path === wt))
console.log('click', JSON.stringify(await control({ cmd: 'click', selector: `[data-worktree="${wt}"] [data-worktree-card-surface]` })))
await until(async () => { const t = await termRead(); return t && t.lines ? t : null }, 'term', 30_000)
await pause(2000)
const t = await termRead()
console.log('term', t.cols, 'x', t.rows, JSON.stringify(t.lines.filter((l) => l.trim()).slice(0, 5)))
