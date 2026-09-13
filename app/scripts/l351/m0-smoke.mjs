// M0 — 스모크. 앱이 뜨고 격리 세션에 붙고 목록이 그려지나.
import { REPO_DIR, look, startApp, tidySession, writeRaw, sleep } from './lib.mjs'

await tidySession()
const app = await startApp({ name: 'm0-smoke' })
await sleep(1200)
await app.addRepo(REPO_DIR)
await sleep(1500)
const state = await app.state()
const first = await look(app)
const shot = await app.shot('smoke')
console.log(JSON.stringify({ ready: app.ready, phase: state.link.phase, 일치: first.일치, 차이: first.차이 }, null, 2))
writeRaw('m0-smoke.json', {
  at: new Date().toISOString(),
  ready: app.ready,
  link: state.link,
  registry: state.registry,
  repos: state.repos.map((repo) => ({
    root: repo.root,
    name: repo.name,
    error: repo.error,
    worktrees: repo.worktrees.map((item) => ({ path: item.path, branch: item.branch, open: item.openWorkspaceId })),
  })),
  대조: first,
  shot: shot.file,
})
await app.stop()
