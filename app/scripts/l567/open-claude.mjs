// LIFE-567 (l566 open-claude.mjs 사본) — 개발 실행에서 이 worktree 행을 열어 pane 1개를 만들고 실제 `claude` 를 띄운다(제출은 하지 않는다).
// `claude` 앞에 공백을 붙인다 — 사용자 zsh(histignorespace)의 실제 히스토리에 남지 않게. 사용: node open-claude.mjs <ctl.sock> <worktree 경로>
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
await until(async () => (await rpc(sock, { cmd: 'term-read' })).ok, 'pane')
await pause(1500)
await rpc(sock, { cmd: 'type', text: ' claude' })
await rpc(sock, { cmd: 'key', keyCode: 'Return' })
const term = await until(async () => {
  const t = (await rpc(sock, { cmd: 'term-read' })).term
  return t?.lines.some((line) => line.startsWith('❯')) ? t : null
}, 'Claude Code 입력줄', 60_000)
console.log(`claude ready pane=${term.paneId} cursor=${term.cursorX},${term.cursorY} hidden=${term.cursorHidden}`)
