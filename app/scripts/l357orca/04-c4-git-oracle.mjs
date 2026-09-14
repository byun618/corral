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
function makeDirtyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l357orca-c4-dirty-'))
  initRepo(root)
  commitFile(root, 'a.txt', 'a\n', 'init')
  // staged: 기존 파일 수정 + add (커밋 안 함)
  fs.writeFileSync(path.join(root, 'a.txt'), 'a changed\n')
  git(root, 'add', 'a.txt')
  // unstaged: 커밋된 파일을 add 없이 수정
  commitFile(root, 'b.txt', 'b\n', 'add b')
  fs.writeFileSync(path.join(root, 'b.txt'), 'b changed\n')
  // untracked: 새 파일, add 안 함
  fs.writeFileSync(path.join(root, 'c.txt'), 'c new\n')
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

// --- 독립 오라클 (앱이 쓰는 것과 다른 명령) --------------------------------------
function oracleDirtyCount(root) {
  const out = git(root, 'status', '--short')
  return out.split('\n').filter((line) => line.trim().length > 0).length
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
  return { markText: mark.found[0] ?? null, dotClassName: dotClass.result }
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

  const oracleClean = { dirtyCount: oracleDirtyCount(cleanRoot), ...oracleAheadBehind(cleanRoot) }
  const oracleDirty = { dirtyCount: oracleDirtyCount(dirtyRoot), ...oracleAheadBehind(dirtyRoot) }
  const oracleAb = { dirtyCount: oracleDirtyCount(abRoot), ...oracleAheadBehind(abRoot) }

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
    { name: 'clean', root: cleanRoot, oracle: oracleClean, rendered: clean },
    { name: 'dirty', root: dirtyRoot, oracle: oracleDirty, rendered: dirty },
    { name: 'ahead-behind', root: abRoot, oracle: oracleAb, rendered: ab },
  ].map((c) => ({
    ...c,
    expectedMark: expectMark(c.oracle),
    expectedTone: expectTone(c.oracle),
    markMatches: c.rendered.markText === expectMark(c.oracle),
    toneMatches: typeof c.rendered.dotClassName === 'string' && c.rendered.dotClassName.includes(`tone-${expectTone(c.oracle)}`),
  }))

  const result = { cases, allPass: cases.every((c) => c.markMatches && c.toneMatches) }
  console.log(JSON.stringify(result, null, 2))
  writeRaw('c4-git-oracle.json', result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
