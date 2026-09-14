// 00-smoke — 새 레이아웃이 뜨는지, 레포 추가·worktree 열기·탭 생성·git 배지·탭바 등장까지
// 기본 흐름이 좌표 클릭으로 지나가는지 1차 확인. 판정표 근거 원자료가 아니라 개발 중 스모크다
// (본 판정용 스크립트는 01~09 로 각 C 항목별로 낸다).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

async function main() {
  const repoA = makeScratchRepo('smoke-a')
  // worktree 2개 이상 있어야 사이드바가 여러 블록을 보여준다.
  const wtDir = path.join(repoA.root, '.claude', 'worktrees')
  fs.mkdirSync(wtDir, { recursive: true })
  const featPath = path.join(wtDir, 'feature-x')
  execFileSync('git', ['-C', repoA.root, 'worktree', 'add', '-b', 'feature/x', featPath], { encoding: 'utf8' })
  // dirty 파일 하나 — git 배지 실측용 (C4 는 별도 스크립트에서 fixture 3종으로 더 엄밀히 뜬다).
  fs.writeFileSync(path.join(featPath, 'scratch.txt'), 'dirty\n')

  const app = await startApp({ name: '00-smoke' })
  console.log('ready', app.ready)

  const add = await app.addRepo(repoA.root)
  console.log('add-repo', add)
  await sleep(400)

  await app.shot('00-initial')

  const state1 = await app.state()
  writeRaw('00-state-after-add.json', state1)

  // repo row 클릭 없이 바로 worktree 블록 클릭 대상 좌표 확인 — data-worktree 셀렉터로.
  const worktreePaths = state1.repos.flatMap((r) => r.worktrees.map((w) => w.path))
  console.log('worktrees', worktreePaths)

  for (const wtPath of worktreePaths) {
    const click = await app.click(`[data-worktree="${wtPath}"]`)
    console.log('click worktree', wtPath, click.ok, click.hit)
    await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === wtPath)?.workspace !== null, {
      timeoutMs: 8000,
      what: `worktree open ${wtPath}`,
    })
    await sleep(150)
  }

  await app.shot('01-worktrees-open')
  const state2 = await app.state()
  writeRaw('00-state-after-open.json', state2)

  // main worktree 에 세션 3개 이상 → AgentGroupHeader + MainTabBar 등장 확인.
  const mainWorktree = state2.repos[0].worktrees.find((w) => !w.isLinked)
  for (let i = 0; i < 2; i++) {
    const click = await app.click(`[data-worktree-menu-toggle="${mainWorktree.path}"]`)
    console.log('menu-toggle', click.ok, click.hit)
    await sleep(150)
    const createClick = await app.click(`[data-worktree-create-shell="${mainWorktree.path}"]`)
    console.log('create-shell', createClick.ok, createClick.hit)
    await until(
      async () => {
        const s = await app.state()
        const wt = s.repos.flatMap((r) => r.worktrees).find((w) => w.path === mainWorktree.path)
        return (wt?.workspace?.tabs.length ?? 0) >= i + 2
      },
      { timeoutMs: 8000, what: `tab count ${i + 2}` },
    )
  }

  await app.shot('02-multi-tab')
  const state3 = await app.state()
  writeRaw('00-state-after-tabs.json', state3)

  await app.stop()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
