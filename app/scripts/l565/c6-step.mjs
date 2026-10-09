// LIFE-565 C6 최종 관문 — 개발 앱 조작 한 걸음. L565_ROOT=/tmp/l565c6 로 부른다.
//   node c6-step.mjs repo <레포>              — live 대기 → 레포 등록 → 행 목록
//   node c6-step.mjs open <레포> <worktree>   — worktree 카드 클릭(닫힌 linked → 부모 workspace.create + worktree.open)
//   node c6-step.mjs tab <workspaceId>        — 렌더러 IPC createRow(shell) = 새 탭(tab.create)
//   node c6-step.mjs split <paneId>           — 렌더러 IPC splitPane(right) = 분할(pane.split)
//   node c6-step.mjs state                    — 레포·worktree·workspace·pane 요약
//   node c6-step.mjs start                    — 백엔드 카드의 「시작」 버튼 클릭(data-backend-start)
import { control, state, until, evalJs, pause } from './lib.mjs'
const [cmd, a, b] = process.argv.slice(2)
const summary = (s) => ({
  link: s.link?.phase, selectedSession: s.selectedSession, backend: s.backend?.kind,
  repos: (s.repos ?? []).map((r) => ({ root: r.root, worktrees: (r.worktrees ?? []).map((w) => ({ path: w.path, ws: w.workspace?.workspaceId ?? null, panes: (w.workspace?.tabs ?? []).flatMap((t) => t.panes.map((p) => `${t.tabId}/${p.paneId}`)) })) })),
})
switch (cmd) {
  case 'repo': {
    const live = await until(async () => { const s = await state(); return s.link?.phase === 'live' ? s : null }, 'live', 60_000)
    console.log('live', JSON.stringify({ selectedSession: live.selectedSession, backend: live.backend }))
    console.log('add-repo', JSON.stringify(await control({ cmd: 'add-repo', root: a })).slice(0, 300))
    const s = await until(async () => { const x = await state(); return (x.repos ?? []).some((r) => (r.worktrees ?? []).length >= 3) ? x : null }, 'repo rows')
    console.log(JSON.stringify(summary(s), null, 1))
    break
  }
  case 'open': {
    console.log('click', JSON.stringify(await control({ cmd: 'click', selector: `[data-worktree="${b}"] [data-worktree-card-surface]` })))
    const s = await until(async () => { const x = await state(); const w = (x.repos ?? []).flatMap((r) => r.worktrees ?? []).find((w) => w.path === b); return w?.workspace ? x : null }, 'opened', 30_000)
    await pause(1500)
    console.log(JSON.stringify(summary(await state()), null, 1))
    void s
    break
  }
  case 'tab': {
    console.log('createRow', JSON.stringify(await evalJs(`window.corral.createRow({ workspaceId: ${JSON.stringify(a)}, kind: 'shell' })`)))
    await pause(2000)
    console.log(JSON.stringify(summary(await state()), null, 1))
    break
  }
  case 'split': {
    console.log('splitPane', JSON.stringify(await evalJs(`window.corral.splitPane({ paneId: ${JSON.stringify(a)}, direction: 'right' })`)))
    await pause(2000)
    console.log(JSON.stringify(summary(await state()), null, 1))
    break
  }
  case 'start': {
    console.log('click', JSON.stringify(await control({ cmd: 'click', selector: '[data-backend-start]' })))
    const s = await until(async () => { const x = await state(); return x.link?.phase === 'live' ? x : null }, 'live', 60_000)
    await pause(3000)
    console.log(JSON.stringify(summary(await state()), null, 1))
    void s
    break
  }
  default:
    console.log(JSON.stringify(summary(await state()), null, 1))
}
