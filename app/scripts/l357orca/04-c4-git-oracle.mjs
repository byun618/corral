// C4 — git 상태 배지(더티 마크·도트 색)를 화면 자신이 아닌 **독립** 판별자와 대조한다
// (관문⑤: "판별자는 재는 대상 자신의 출력이면 안 된다"). corral 은 내부적으로
// `git status --porcelain=v2 --branch` 를 쓰지만(main/git-status.ts), 여기 오라클은
// 전혀 다른 명령 두 개를 쓴다:
//   · 더티 카운트 — `git status --short` (v2 포셀린이 아니라 짧은 포맷, 별도 파서)
//   · ahead/behind — `git rev-list --left-right --count HEAD...<upstream>` (포셀린 안 씀)
// 3개 픽스처: clean(무변경) · dirty(추적+미추적 변경 혼합) · ahead-behind(로컬·원격 분기).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, until, writeRaw } from './lib.mjs'

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
}

function initRepo(root) {
  fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'l357orca@test')
  git(root, 'config', 'user.name', 'l357orca')
}

function commitFile(root, file, content, message) {
  fs.writeFileSync(path.join(root, file), content)
  git(root, 'add', file)
  git(root, 'commit', '-m', message)
}

// --- 픽스처 1: clean -----------------------------------------------------------
function makeCleanFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l357orca-c4-clean-'))
  initRepo(root)
  commitFile(root, 'README.md', 'clean\n', 'init')
  return fs.realpathSync(root)
}

// --- 픽스처 2: dirty (staged + unstaged + untracked 혼합) -----------------------
// 수정 1회차(07-fix-orca1.md M-5) 버그 수정: 1차 구현은 a.txt 를 staged 로 만든 뒤
// `commitFile(root,'b.txt',…)` 가 **pathspec 없는 `git commit`** 을 실행해 인덱스 전체
// (staged 였던 a.txt 포함)를 커밋해버렸다 — 최종 상태가 staged 0 이라 parseGitStatus 의
// X 자리(staged) 계수가 한 번도 검증되지 않았다. 고침: **staged 를 마지막에 만들고 그 뒤로는
// commit 을 아예 안 한다** — 커밋이 인덱스를 비울 기회 자체를 없앤다.
function makeDirtyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l357orca-c4-dirty-'))
  initRepo(root)
  commitFile(root, 'a.txt', 'a\n', 'init')
  commitFile(root, 'b.txt', 'b\n', 'add b')
  // unstaged: 커밋된 파일을 add 없이 수정
  fs.writeFileSync(path.join(root, 'b.txt'), 'b changed\n')
  // untracked: 새 파일, add 안 함
  fs.writeFileSync(path.join(root, 'c.txt'), 'c new\n')
  // staged: 새 파일을 add 만 하고 끝 — 이 뒤로 commit 호출이 없어 인덱스가 안 비워진다
  fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n')
  git(root, 'add', 'staged.txt')
  return fs.realpathSync(root)
}

// --- 픽스처 3: ahead + behind (로컬 커밋 vs 원격 신규 커밋, fetch 로 반영) ----------
function makeAheadBehindFixture(aheadCount, behindCount) {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'l357orca-c4-bare-'))
  execFileSync('git', ['init', '-b', 'main', '--bare', bare], { encoding: 'utf8' })

  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'l357orca-c4-seed-'))
  execFileSync('git', ['clone', bare, seed], { encoding: 'utf8' })
  git(seed, 'config', 'user.email', 'l357orca@test')
  git(seed, 'config', 'user.name', 'l357orca')
  commitFile(seed, 'README.md', 'seed\n', 'init')
  git(seed, 'push', 'origin', 'main')

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'l357orca-c4-work-'))
  execFileSync('git', ['clone', bare, work], { encoding: 'utf8' })
  git(work, 'config', 'user.email', 'l357orca@test')
  git(work, 'config', 'user.name', 'l357orca')
  for (let i = 0; i < aheadCount; i++) commitFile(work, `local-${i}.txt`, `${i}\n`, `local commit ${i}`)

  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'l357orca-c4-other-'))
  execFileSync('git', ['clone', bare, other], { encoding: 'utf8' })
  git(other, 'config', 'user.email', 'l357orca@test')
  git(other, 'config', 'user.name', 'l357orca')
  for (let i = 0; i < behindCount; i++) commitFile(other, `remote-${i}.txt`, `${i}\n`, `remote commit ${i}`)
  git(other, 'push', 'origin', 'main')

  git(work, 'fetch', 'origin') // status --porcelain=v2 는 fetch 를 안 하므로 여기서 명시로 반영
  return fs.realpathSync(work)
}

// --- 독립 오라클 (앱이 쓰는 것과 다른 명령·다른 파서) ----------------------------
// `git status --short` 의 `XY 파일명` 두 칸을 직접 해석한다 — corral 의 parseGitStatus
// (porcelain=v2) 와는 다른 플래그·다른 파싱 코드다(관문⑤). M-5: staged·unstaged·untracked
// 를 **각각** 세서 합계만 맞아도 개별 계수 버그가 가려지는 일을 막는다.
function oracleStatusBreakdown(root) {
  const lines = git(root, 'status', '--short')
    .split('\n')
    .filter((line) => line.length > 0)
  const staged = lines.filter((line) => line[0] !== ' ' && line[0] !== '?').length
  const unstaged = lines.filter((line) => line[1] !== ' ' && line[1] !== '?').length
  const untracked = lines.filter((line) => line.startsWith('??')).length
  return { staged, unstaged, untracked, dirtyCount: lines.length, rawLines: lines }
}

function oracleAheadBehind(root) {
  try {
    const out = git(root, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}')
    const match = /^(\d+)\s+(\d+)$/.exec(out.trim())
    if (match === null || match[1] === undefined || match[2] === undefined) return { ahead: null, behind: null }
    return { ahead: Number(match[1]), behind: Number(match[2]) }
  } catch {
    return { ahead: null, behind: null } // upstream 없음(clean·dirty 픽스처)
  }
}

async function readRendered(app, worktreePath) {
  await until(async () => (await app.query(`[data-worktree="${worktreePath}"]`)).found.length > 0, {
    timeoutMs: 8000,
    what: `worktree row mounted (${worktreePath})`,
  })
  const mark = await app.query(`[data-worktree="${worktreePath}"] .worktree-mark`)
  const dotClass = await app.send({
    cmd: 'eval',
    code: `document.querySelector('[data-worktree="${worktreePath}"] .worktree-dot')?.className ?? null`,
  })
  const state = await app.state()
  const gitStatus = state.repos.flatMap((r) => r.worktrees).find((w) => w.path === worktreePath)?.gitStatus ?? null
  return { markText: mark.found[0] ?? null, dotClassName: dotClass.result, gitStatus }
}

async function main() {
  const cleanRoot = makeCleanFixture()
  const dirtyRoot = makeDirtyFixture()
  const abRoot = makeAheadBehindFixture(2, 3)

  const app = await startApp({ name: '04-c4-git-oracle' })
  await app.addRepo(cleanRoot)
  await app.addRepo(dirtyRoot)
  await app.addRepo(abRoot)

  const clean = await readRendered(app, cleanRoot)
  const dirty = await readRendered(app, dirtyRoot)
  const ab = await readRendered(app, abRoot)
  await app.stop()

  const oracleClean = { ...oracleStatusBreakdown(cleanRoot), ...oracleAheadBehind(cleanRoot) }
  const oracleDirty = { ...oracleStatusBreakdown(dirtyRoot), ...oracleAheadBehind(dirtyRoot) }
  const oracleAb = { ...oracleStatusBreakdown(abRoot), ...oracleAheadBehind(abRoot) }

  const expectMark = (oracle) => {
    const parts = []
    if (oracle.dirtyCount > 0) parts.push(`●${oracle.dirtyCount}`)
    if (oracle.ahead !== null && oracle.ahead > 0) parts.push(`↑${oracle.ahead}`)
    if (oracle.behind !== null && oracle.behind > 0) parts.push(`↓${oracle.behind}`)
    return parts.length === 0 ? null : parts.join(' ')
  }
  const expectTone = (oracle) => {
    if (oracle.dirtyCount > 0) return 'dirty'
    if (oracle.ahead !== null && oracle.ahead > 0) return 'ahead'
    if (oracle.behind !== null && oracle.behind > 0) return 'behind'
    return 'clean'
  }

  const cases = [
    { name: 'clean', root: cleanRoot, oracle: oracleClean, rendered: clean, expectStaged: 0, expectUnstaged: 0, expectUntracked: 0 },
    { name: 'dirty', root: dirtyRoot, oracle: oracleDirty, rendered: dirty, expectStaged: 1, expectUnstaged: 1, expectUntracked: 1 },
    { name: 'ahead-behind', root: abRoot, oracle: oracleAb, rendered: ab, expectStaged: 0, expectUnstaged: 0, expectUntracked: 0 },
  ].map((c) => ({
    ...c,
    expectedMark: expectMark(c.oracle),
    expectedTone: expectTone(c.oracle),
    markMatches: c.rendered.markText === expectMark(c.oracle),
    toneMatches: typeof c.rendered.dotClassName === 'string' && c.rendered.dotClassName.includes(`tone-${expectTone(c.oracle)}`),
    // M-5 — staged·unstaged·untracked 를 각각 독립 오라클 대 corral 파서(gitStatus) 로 대조한다.
    stagedMatches: c.oracle.staged === c.expectStaged && c.rendered.gitStatus?.staged === c.expectStaged,
    unstagedMatches: c.oracle.unstaged === c.expectUnstaged && c.rendered.gitStatus?.unstaged === c.expectUnstaged,
    untrackedMatches: c.oracle.untracked === c.expectUntracked && c.rendered.gitStatus?.untracked === c.expectUntracked,
  }))

  const result = {
    cases,
    allPass: cases.every((c) => c.markMatches && c.toneMatches && c.stagedMatches && c.unstagedMatches && c.untrackedMatches),
  }
  console.log(JSON.stringify(result, null, 2))
  writeRaw('c4-git-oracle.json', result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
