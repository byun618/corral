// LIFE-571 — 개발 실행에서 이 worktree 행을 열어 pane 1개(셸)를 만든다. 셸에는 아무것도 치지 않는다(C3ⓐ 셸 pane 회차용).
// 사용: node open-shell.mjs <ctl.sock> <worktree 경로>
import { rpc } from '../gui-diff/lib/corral.mjs'

const [sock, worktree] = process.argv.slice(2)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, label, timeout = 30_000) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${label}`)
    await pause(300)
  }
}
await rpc(sock, { cmd: 'add-repo', root: worktree })
const card = `[data-worktree="${worktree}"] [data-worktree-card-surface]`
await until(async () => ((await rpc(sock, { cmd: 'query', selector: card })).found ?? []).length > 0, '사이드바 행')
const click = await rpc(sock, { cmd: 'click', selector: card })
if (!click.hit) throw new Error(`행 클릭 실패 ${JSON.stringify(click).slice(0, 200)}`)
const term = await until(async () => (await rpc(sock, { cmd: 'term-read' })).term, 'pane')
await pause(2500)
console.log(`shell pane=${term.paneId}`)
