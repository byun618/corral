// LIFE-471 G7 감사 (r2 F-G) — raw 에 사용자 개인 값이 남았는지 **개수만** 출력한다(값은 출력하지 않는다).
//
// 검사 키:
//   · home        — `$HOME` 문자열·`/Users/` 접두
//   · userPaths   — 사용자 레지스트리(repos.json, 읽기만)의 레포 루트와 그 worktree 경로(`git worktree list`, 읽기만),
//                   ui-prefs 기준 파일의 절대경로 모양 값. 절대형과 `~/` 형 둘 다 찾는다.
//   · branchNames — 그 레포들의 로컬 브랜치 이름(단어 경계로 찾는다)
//   · prefsValues — ui-prefs 기준 파일의 잎 문자열 중 6자 이상(옵션 열거값 제외)
//   · nativePng   — `native*/` 폴더의 PNG(사용자 실제 화면)
//   · `--keys <json>` 의 `{ paths: [], branches: [] }` 를 더한다(양성 대조용 가짜 값).
// 허용(키에서 뺀다 — 출력 `allowed` 에 개수와 규칙을 적는다): 이 프로젝트 레포(corral) 자신과 그 worktree 경로, `LIFE-<번호>`·`main`·`master`
// 브랜치 — 프로젝트 문서(specs·AGENTS.md)에 원래 나오는 작업 식별자다.
//
// 하나라도 0 이 아니면 종료코드 1.
// 사용: node audit-raw.mjs <raw 폴더> [--base-prefs <ui-prefs.json>] [--registry <repos.json>] [--keys <json>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const raw = path.resolve(argv[0])
const home = os.homedir()
const readJson = (file) => (file === undefined || !fs.existsSync(file) ? null : JSON.parse(fs.readFileSync(file, 'utf8')))
const basePrefs = readJson(option('--base-prefs'))
const registry = readJson(option('--registry') ?? path.join(home, 'Library/Application Support/corral/repos.json'))
const extra = readJson(option('--keys')) ?? { paths: [], branches: [] }

const git = (cwd, args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}
/** 이 스크립트가 든 레포(프로젝트 자신)의 루트 — worktree 여도 공통 루트. */
const projectRoot = path.dirname(path.resolve(path.dirname(new URL(import.meta.url).pathname), git(path.dirname(new URL(import.meta.url).pathname), ['rev-parse', '--git-common-dir']).trim()))
const isProjectPath = (value) => value === projectRoot || value.startsWith(projectRoot + '/')
const ALLOWED_BRANCH = /^(LIFE-\d+(-.*)?|main|master)$/

const repoRoots = (registry?.repos ?? []).map((repo) => repo.root ?? repo.path).filter((value) => typeof value === 'string')
const worktreePaths = repoRoots.flatMap((root) =>
  git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length)),
)
const branches = repoRoots.flatMap((root) => git(root, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean))

/** ui-prefs 잎 문자열 + 식별자 모양이 아닌 객체 키(경로를 키로 쓰는 칸). */
const leaves = (value) =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(leaves)
      : value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, item]) => [...(/^[A-Za-z]+$/.test(key) ? [] : [key]), ...leaves(item)])
        : []
const ENUMS = new Set(['none', 'repo', 'name', 'smart', 'recent', 'manual', 'row', 'column', 'detailed', 'compact', 'full', 'inline-agents'])
const prefsLeaves = basePrefs === null ? [] : [...new Set(leaves(basePrefs))]
const prefsPaths = prefsLeaves.filter((text) => text.startsWith('/') || text.startsWith('~/'))

const pathCandidates = [...new Set([...repoRoots, ...worktreePaths, ...prefsPaths, ...extra.paths])]
const allowedPaths = pathCandidates.filter(isProjectPath)
const userPaths = pathCandidates.filter((value) => !isProjectPath(value)).flatMap((value) => (value.startsWith(home + '/') ? [value, '~' + value.slice(home.length)] : [value]))
const branchCandidates = [...new Set([...branches, ...extra.branches])]
const allowedBranches = branchCandidates.filter((name) => ALLOWED_BRANCH.test(name))
const branchNames = branchCandidates.filter((name) => !ALLOWED_BRANCH.test(name) && name.length >= 4)
const prefsStrings = prefsLeaves.filter((text) => text.length >= 6 && !ENUMS.has(text) && !/^sidebar|^manual|^version$/.test(text) && !isProjectPath(text))

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const branchPatterns = branchNames.map((name) => new RegExp(`(^|[^A-Za-z0-9_./-])${escape(name)}($|[^A-Za-z0-9_./-])`, 'g'))
const occurrences = (text, value) => text.split(value).length - 1
/** 경로는 뒤가 경로 이름 글자로 이어지면(`/r/repo` 와 `/r/repository`) 같은 경로가 아니다. */
const pathPatterns = userPaths.map((value) => new RegExp(`${escape(value)}(?![A-Za-z0-9_.-])`, 'g'))

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))

const counts = { files: 0, textFiles: 0, home: 0, usersPrefix: 0, userPaths: 0, branchNames: 0, prefsValues: 0, nativePng: 0, hitFiles: [] }
for (const file of walk(raw)) {
  counts.files++
  const rel = path.relative(raw, file)
  if (file.endsWith('.png')) {
    if (/^(.*\/)?native[^/]*\//.test(rel)) {
      counts.nativePng++
      counts.hitFiles.push(rel)
    }
    continue
  }
  counts.textFiles++
  const text = fs.readFileSync(file, 'utf8')
  const hit = {
    home: occurrences(text, home),
    usersPrefix: occurrences(text, '/Users/'),
    userPaths: pathPatterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0),
    branchNames: branchPatterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0),
    prefsValues: prefsStrings.reduce((sum, value) => sum + (text.includes(value) ? 1 : 0), 0),
  }
  for (const key of Object.keys(hit)) counts[key] += hit[key]
  if (Object.values(hit).some((n) => n > 0)) counts.hitFiles.push(rel)
}

console.log(
  JSON.stringify(
    {
      ...counts,
      checked: { userPathKeys: userPaths.length, branchNames: branchNames.length, prefsStrings: prefsStrings.length, extraPaths: extra.paths.length, extraBranches: extra.branches.length },
      allowed: { rule: 'project repo (and its worktrees) paths; branches /^(LIFE-\\d+(-.*)?|main|master)$/', paths: allowedPaths.length, branches: allowedBranches.length },
      verdict: counts.hitFiles.length === 0 ? '0건' : '남음',
    },
    null,
    2,
  ),
)
process.exit(counts.hitFiles.length === 0 ? 0 : 1)
