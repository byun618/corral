// I-6 — 사이드바 세션 행 클릭이 **그 탭의 workspace 를 활성화**하는가.
//
// 사용자 지적: *"세션이 여러개 일 때 세션 리스트 클릭 시 탭이 그걸로 열리게 해줘"*.
// 결함은 `Sidebar.tsx` 의 `onSelectSession` 이 `selectPane` 만 부르고 `activeWorkspaceId` 를
// 안 옮긴 것이었다 — 터미널만 바뀌고 탭바·상태바는 딴 workspace 를 계속 가리켰다.
//
// **판별력**: worktree 를 2개 열고 **비활성 쪽 세션**을 누른다. 활성 worktree 안의 세션을
// 누르는 fixture 로는 고치기 전에도 통과해 버려서 회귀를 못 잡는다.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildMixedFixture, makeScratchRepo, startApp, until, writeRaw } from './lib.mjs'

/** 화면이 지금 어느 workspace 를 가리키는가 — DOM 에서 읽는다(렌더러 로컬 상태라 state 에 없다). */
async function screenPointsAt(app) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const selectedBlock = document.querySelector('.worktree-block.is-selected')
        return {
          selectedWorktreePath: selectedBlock?.getAttribute('data-worktree') ?? null,
          tabbarWorktreeLabel: document.querySelector('[data-main-tabbar-worktree]')?.textContent ?? null,
          tabbarTabIds: [...document.querySelectorAll('[data-main-tab]')].map((el) => el.getAttribute('data-main-tab')),
          activeTabId: document.querySelector('.main-tab.is-active')?.getAttribute('data-main-tab') ?? null,
        }
      })()`,
    })
  ).result
}

async function main() {
  const repo = makeScratchRepo('session-click')
  const wtRoot = path.join(repo.root, '.wt')
  fs.mkdirSync(wtRoot, { recursive: true })
  const second = path.join(wtRoot, 'feature')
  execFileSync('git', ['-C', repo.root, 'worktree', 'add', '-b', 'feature/click', second], { encoding: 'utf8' })
  const secondPath = fs.realpathSync(second)

  const app = await startApp({ name: '14-session-click' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query('[data-worktree]')).found.length === 2, { timeoutMs: 10000, what: 'two worktree rows' })

  // worktree A(주 체크아웃) 를 열고 에이전트 세션을 만든다.
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace != null, {
    timeoutMs: 20000,
    what: 'worktree A opened',
  })
  const fixtureA = await buildMixedFixture(app, repo.root, { agents: 2, shells: 0 })

  // worktree B 를 열고 세션을 만든다 — 여기를 열면 활성이 B 로 옮겨간다.
  await app.click(`[data-worktree="${secondPath}"]`)
  await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === secondPath)?.workspace != null, {
    timeoutMs: 20000,
    what: 'worktree B opened',
  })
  const fixtureB = await buildMixedFixture(app, secondPath, { agents: 2, shells: 0 })

  const before = await screenPointsAt(app)

  // ---------- 비활성 worktree(A) 의 세션 행을 좌표 클릭 ----------
  const state = await app.state()
  const wtA = state.repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
  const targetTab = wtA.workspace.tabs.find((t) => t.panes.some((p) => p.agent !== null)) ?? wtA.workspace.tabs[0]
  const targetWorkspaceId = wtA.workspace.workspaceId
  const clickedSessionClick = await app.click(`[data-tab="${targetTab.tabId}"]`)
  const switched = await until(
    async () => (await app.query(`[data-main-tab="${targetTab.tabId}"]`)).found.length > 0,
    { timeoutMs: 10000, what: '클릭한 세션의 탭이 탭바에 나타남' },
  ).catch(() => ({ ok: false }))

  const after = await screenPointsAt(app)
  const shot = await app.shot('session-click-after')
  await app.stop()

  const out = {
    what: 'I-6 — 비활성 worktree 의 세션 행을 클릭하면 그 workspace 로 전환되는가',
    fixture: {
      worktreeA: { path: repo.root, workspaceId: targetWorkspaceId, agentTabCount: fixtureA.agentTabCount },
      worktreeB: { path: secondPath, agentTabCount: fixtureB.agentTabCount },
      activeBeforeClick: 'B (마지막에 연 쪽)',
    },
    clickedTab: { tabId: targetTab.tabId, workspaceId: targetTab.workspaceId, clickHit: clickedSessionClick.hit },
    before,
    after,
    checks: {
      // ⓐ 클릭 전엔 화면이 B 를 가리키고 있었다 — 이게 성립해야 판별력이 있다.
      startedOnOtherWorkspace: before.selectedWorktreePath === secondPath,
      // ⓑ 클릭 후 선택된 블록이 A 로 옮겨갔다.
      selectionMovedToClicked: after.selectedWorktreePath === repo.root,
      // ⓒ 탭바가 A 의 탭들을 보여준다(= activeWorkspace 가 옮겨갔다는 뜻).
      tabBarShowsClickedWorkspace: switched.ok,
      // ⓓ 그리고 클릭한 그 탭이 활성이다 — "탭이 그걸로 열리게" 의 문자 그대로.
      clickedTabIsActive: after.activeTabId === targetTab.tabId,
      clickHit: clickedSessionClick.hit,
    },
    shots: [shot],
    rawChain: app.rawChain(),
    clickLog: app.clickLog(),
    pass: null,
  }
  out.pass =
    out.checks.startedOnOtherWorkspace &&
    out.checks.selectionMovedToClicked &&
    out.checks.tabBarShowsClickedWorkspace &&
    out.checks.clickedTabIsActive &&
    out.checks.clickHit
  console.log(JSON.stringify({ ...out, rawChain: undefined, clickLog: undefined }, null, 2))
  writeRaw('i6-session-click.json', out)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
