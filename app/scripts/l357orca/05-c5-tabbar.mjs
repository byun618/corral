// C5 — MainTabBar 는 `sessionCount >= 2` 일 때만 DOM 에 존재한다(0/1/2/N 전부 깨짐 없음).
// 세션 0: worktree 를 아예 안 연 상태(activeWorkspace 자체가 없다 — App.tsx 가 그 상위에서
// MainTabBar 렌더 자체를 안 한다). 세션 1: worktree 를 열면 기본 탭 1개가 자동 생긴다(00-smoke
// 실측 그대로). 세션 2·3: `+` 로 늘려 탭바 등장 + 탭 개수를 [data-main-tab] 개수로 확인한다.
import { makeScratchRepo, startApp, until, writeRaw } from './lib.mjs'

async function tabBarState(app) {
  const bar = await app.query('[data-main-tabbar]')
  const tabs = await app.query('[data-main-tab]')
  return { barPresent: bar.found.length > 0, tabCount: tabs.found.length }
}

async function main() {
  const repo = makeScratchRepo('c5-tabbar')

  const app = await startApp({ name: '05-c5-tabbar' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 8000,
    what: 'worktree row mounted',
  })

  const zero = await tabBarState(app) // worktree 안 열림 — activeWorkspace 없음
  console.log('sessionCount=0 (unopened)', zero)

  await app.click(`[data-worktree="${repo.root}"]`)
  await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace !== null, {
    timeoutMs: 8000,
    what: 'worktree opened',
  })
  const one = await tabBarState(app) // 열자마자 기본 탭 1개
  console.log('sessionCount=1 (default tab)', one)

  await app.click(`[data-worktree-menu-toggle="${repo.root}"]`)
  await app.click(`[data-worktree-create-shell="${repo.root}"]`)
  await until(
    async () => {
      const s = await app.state()
      return (s.repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace?.tabs.length ?? 0) >= 2
    },
    { timeoutMs: 8000, what: 'tab count 2' },
  )
  const two = await tabBarState(app)
  console.log('sessionCount=2', two)

  await app.click(`[data-worktree-menu-toggle="${repo.root}"]`)
  await app.click(`[data-worktree-create-shell="${repo.root}"]`)
  await until(
    async () => {
      const s = await app.state()
      return (s.repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace?.tabs.length ?? 0) >= 3
    },
    { timeoutMs: 8000, what: 'tab count 3' },
  )
  const three = await tabBarState(app)
  console.log('sessionCount=3 (N)', three)

  await app.stop()

  const result = {
    // 탭바가 없으면 [data-main-tab] 자체가 DOM 에 없다 — tabCount 는 0 이어야 정상(세션 수와 무관).
    zero: { ...zero, expectAbsent: true, pass: zero.barPresent === false && zero.tabCount === 0 },
    one: { ...one, expectAbsent: true, pass: one.barPresent === false && one.tabCount === 0 },
    two: { ...two, expectPresent: true, pass: two.barPresent === true && two.tabCount === 2 },
    three: { ...three, expectPresent: true, pass: three.barPresent === true && three.tabCount === 3 },
  }
  result.allPass = result.zero.pass && result.one.pass && result.two.pass && result.three.pass
  console.log(JSON.stringify(result, null, 2))
  writeRaw('c5-tabbar.json', result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
