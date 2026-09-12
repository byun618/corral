// M4 — N4(4단 계층: 루트는 레지스트리, 닫힌 것도 보인다).
//
// 화면 한 장과 **같은 시각**의 `git worktree list`·herdr `worktree.list` 를 떠서 줄줄이 맞춘다.
// 레포 둘을 걸어 둔다: 하나는 이 세션에 workspace 가 열려 있고, 하나는 **하나도 안 열려 있다**.
//
// 오라클이 둘인 이유는 기준 N4ⓒ 가 출처를 갈라 놓았기 때문이다 —
// worktree 구조는 git 이, 열림상태는 herdr 가 진실이다. 화면이 둘 다에 맞아야 통과다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPO_DIR, request, sleep, startApp, tidySession, until, writeRaw } from './lib.mjs'

const OPEN_REPO = path.resolve(REPO_DIR, '../../..')
const CLOSED_REPO = process.env.LIFE351_SECOND_REPO ?? path.join(os.homedir(), 'repos/byun618/home-coffing')
const registryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l351-n4-')), 'repos.json')
fs.writeFileSync(registryFile, JSON.stringify({ version: 1, repos: [OPEN_REPO, CLOSED_REPO] }, null, 2))

/** git 쪽 오라클 — 앱이 쓰는 것과 **다른 프로세스**로 같은 질문을 한다. */
function gitWorktrees(root) {
  const stdout = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  const out = []
  let current = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) out.push(current)
      current = { path: line.slice(9).trim(), branch: null }
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
    } else if (current && line === 'detached') current.branch = '(detached)'
  }
  if (current) out.push(current)
  return out
}

/** herdr 쪽 오라클 — 하네스 자기 커넥션으로 직접 묻는다. */
async function herdrWorktrees(root) {
  const result = await request('worktree.list', { cwd: root })
  return result.worktrees.map((item) => ({ path: item.path, open: item.open_workspace_id ?? null }))
}

// **cwd 를 이 워크트리로 준다** — 그래야 열린 workspace 가 OPEN_REPO 의 한 worktree 에 걸린다.
await tidySession(REPO_DIR)
const app = await startApp({ name: 'n4-hierarchy', registryFile })
await until(async () => (await app.state()).repos.length === 2, { what: '레포 둘', timeoutMs: 15000 })
await sleep(1200)

const at = Date.now()
const state = await app.state()
const oracles = {}
for (const root of [OPEN_REPO, CLOSED_REPO]) {
  oracles[root] = { git: gitWorktrees(root), herdr: await herdrWorktrees(root) }
}
const shot = await app.shot('n4-two-repos')
// 화면이 실제로 그 칩을 들고 있나 — DOM 에서 직접 읽는다 (상태 객체와 별개 확인).
const chipDom = await app.send({
  cmd: 'query',
  selector: '[data-chip-worktree]',
})
const chipValues = await app.send({
  cmd: 'query',
  selector: '[data-chip-worktree][data-chip-value="open"]',
})

const rows = []
for (const repo of state.repos) {
  const oracle = oracles[repo.root]
  for (const worktree of repo.worktrees) {
    const git = oracle.git.find((item) => item.path === worktree.path) ?? null
    const herdr = oracle.herdr.find((item) => item.path === worktree.path) ?? null
    rows.push({
      repo: repo.name,
      path: worktree.path,
      화면_branch: worktree.branch,
      git_branch: git?.branch ?? null,
      화면_open: worktree.openWorkspaceId,
      herdr_open: herdr?.open ?? null,
      'git 과 일치': git !== null && git.branch === worktree.branch,
      'herdr 와 일치': (herdr?.open ?? null) === worktree.openWorkspaceId,
      '탭·pane 이 붙었나': worktree.workspace === null ? null : worktree.workspace.tabs.length,
    })
  }
}

const gitPaths = Object.values(oracles).flatMap((item) => item.git.map((wt) => wt.path)).sort()
const screenPaths = state.repos.flatMap((repo) => repo.worktrees.map((item) => item.path)).sort()
const closedRepo = state.repos.find((repo) => repo.root === CLOSED_REPO)
const openRepo = state.repos.find((repo) => repo.root === OPEN_REPO)
const depth = (() => {
  const worktree = openRepo?.worktrees.find((item) => item.openWorkspaceId !== null) ?? null
  const tab = worktree?.workspace?.tabs[0] ?? null
  return {
    repo: openRepo?.root ?? null,
    worktree: worktree?.path ?? null,
    workspace: worktree?.workspace?.workspaceId ?? null,
    tab: tab?.tabId ?? null,
    pane: tab?.panes[0]?.paneId ?? null,
  }
})()

const out = {
  at: new Date(at).toISOString(),
  질문: '목록이 repo→worktree→tab→pane 4단이고, 루트가 레지스트리이며, 닫힌 것도 보이는가',
  레지스트리: state.registry,
  '화면 vs 오라클': rows,
  오라클원본: oracles,
  '4단 경로 한 줄': depth,
  'DOM 의 worktree 칩': { 전체: chipDom.found, 열림표시: chipValues.found.length },
  shot: shot.file,
}
out.판정 = {
  'ⓐ 하나도 안 열린 레포가 보인다':
    closedRepo !== undefined &&
    closedRepo.worktrees.length > 0 &&
    closedRepo.worktrees.every((item) => item.openWorkspaceId === null),
  'ⓑ 닫힌 worktree 가 열린 것과 구분된다':
    (openRepo?.worktrees.some((item) => item.openWorkspaceId === null) ?? false) &&
    (openRepo?.worktrees.some((item) => item.openWorkspaceId !== null) ?? false) &&
    chipValues.found.length === 1,
  'ⓒ worktree 구조가 git 과 같다': JSON.stringify(gitPaths) === JSON.stringify(screenPaths) && rows.every((row) => row['git 과 일치']),
  'ⓒ 열림상태가 herdr 와 같다': rows.every((row) => row['herdr 와 일치']),
  '4단이 실제로 이어진다': Object.values(depth).every((value) => value !== null),
  // 수정 4회차에서 자가 바뀌었다: 예전엔 "미등록 칸이 비어 있다" 였는데, 이제 그 칸 자체가 없다
  // (게이트 ① 지시). 미등록 workspace 가 있어도 안 그려진다는 쪽은 G1(m15) 이 따로 잰다.
  '루트가 레지스트리다 (화면 상태에 미등록 칸이 아예 없다)': !('unregistered' in state),
}
console.log(JSON.stringify(out.판정, null, 2))
writeRaw('n4-hierarchy.json', out)
await app.stop()
