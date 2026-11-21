// 소스 제어 base 대비 (LIFE-830) — main 쪽 base 결정·merge-base·변경 목록. 전부 읽기 전용 git.
//
// · base 순서(00-analysis 3.2): ① 부모 worktree(레지스트리 `parentWorktreeId`)의 지금 브랜치, 분리된 HEAD 면 그 커밋 ② `repo.baseRef`
//   ③ `refs/remotes/origin/HEAD` 가 가리키는 ref → origin/main → origin/master → main → master. 위에서 처음 **커밋으로 풀리는** 것을 쓴다.
//   PR base·upstream·reflog·fork-point 는 쓰지 않는다. git config·레지스트리에 쓰지 않는다(찾은 base 를 캐시하지 않는다).
// · 경계(00-analysis 3.3): 렌더러는 ref 를 보내지 않는다 — 이 모듈의 입력은 main 이 레지스트리·트리에서 읽은 값뿐이다.
//   argv = 고정 문자열 + hex oid(`OID` 검사) + ref 이름(`--end-of-options` 뒤, `^{commit}` 으로 커밋 검증). 전부 `--no-optional-locks`.
// · 비교: merge-base(base, HEAD) ↔ 작업 트리 — `diff --raw -z -M <merge-base oid> --`(커밋분 + 스테이지 + 미스테이지) + status 의 추적 안 함.
//   merge-base 가 여럿(criss-cross)이면 `git merge-base` 가 고르는 하나(같은 입력이면 같은 답)를 쓴다.
import { execFile } from 'node:child_process'
import { parseBaseDiff, withUntracked, type ScmBaseInfo, type ScmBasePush, type ScmBaseSource, type ScmChange } from '../shared/scm.js'

export const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** 시험이 argv 를 고정한다. */
export const scmBaseVerifyArgs = (name: string): string[] => ['--no-optional-locks', 'rev-parse', '--verify', '--quiet', '--end-of-options', `${name}^{commit}`]
export const SCM_BASE_ORIGIN_HEAD_ARGS = ['--no-optional-locks', 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']
export const scmMergeBaseArgs = (oid: string): string[] => ['--no-optional-locks', 'merge-base', oid, 'HEAD']
export const scmBaseDiffArgs = (oid: string): string[] => ['--no-optional-locks', '-c', 'core.quotePath=false', 'diff', '--raw', '-z', '-M', '--no-color', '--no-ext-diff', oid, '--']

/** 기본 브랜치 사슬의 고정 뒷부분(③ — origin/HEAD 다음). */
const DEFAULT_CHAIN: readonly { ref: string; name: string }[] = [
  { ref: 'refs/remotes/origin/main', name: 'origin/main' },
  { ref: 'refs/remotes/origin/master', name: 'origin/master' },
  { ref: 'refs/heads/main', name: 'main' },
  { ref: 'refs/heads/master', name: 'master' },
]

export type GitResult = { ok: true; stdout: string } | { ok: false; code: number | null; error: string }
/** `git -C <그 worktree 실경로> ...args` — 시험은 가짜를 꽂아 argv 를 센다. */
export type GitRun = (args: string[]) => Promise<GitResult>

/** main 이 레지스트리·트리에서 읽은 base 재료. `parent` = 부모 worktree 행(없으면 null), `baseRef` = 그 레포의 `repo.baseRef`. */
export type ScmBaseInputs = { parent: { branch: string | null; head: string | null } | null; baseRef: string | null }

export type ScmBaseResolved = { ok: true; info: ScmBaseInfo } | { ok: false; reason: 'no_base' | 'no_merge_base' | 'git_error'; error: string }

type Candidate = { source: ScmBaseSource; name: string; spec: string }

/** ref 이름 모양 — 빈 값·NUL·줄바꿈은 git 에 넘기지 않는다(옵션 모양은 `--end-of-options` 가 막는다). */
const usableName = (value: string | null): value is string => value !== null && value.trim() !== '' && !/[\0\n\r]/.test(value)

async function verify(run: GitRun, spec: string): Promise<string | null> {
  const result = await run(scmBaseVerifyArgs(spec))
  if (!result.ok) return null
  const oid = result.stdout.trim()
  return OID.test(oid) ? oid : null
}

/** ③ 의 첫 칸 — `origin/HEAD` 가 가리키는 ref(없으면 빈 목록). 가리키는 곳이 `refs/remotes/origin/` 아래가 아니면 쓰지 않는다. */
async function originHead(run: GitRun): Promise<Candidate[]> {
  const result = await run(SCM_BASE_ORIGIN_HEAD_ARGS)
  if (!result.ok) return []
  const ref = result.stdout.trim()
  if (!ref.startsWith('refs/remotes/origin/') || !usableName(ref)) return []
  return [{ source: 'default', name: ref.slice('refs/remotes/'.length), spec: ref }]
}

/** base 결정 + merge-base. 첫 출처부터 커밋으로 풀리는지 보고, 풀리지 않으면 다음 출처로 간다(B2ⓔ). */
export async function resolveScmBase(input: { run: GitRun } & ScmBaseInputs): Promise<ScmBaseResolved> {
  const { run } = input
  const head: Candidate[] = []
  const parent = input.parent
  if (parent !== null) {
    if (usableName(parent.branch)) head.push({ source: 'parent', name: parent.branch, spec: `refs/heads/${parent.branch}` })
    else if (parent.head !== null && OID.test(parent.head)) head.push({ source: 'parent', name: parent.head.slice(0, 7), spec: parent.head })
  }
  if (usableName(input.baseRef)) head.push({ source: 'repo', name: input.baseRef, spec: input.baseRef })
  let found: { candidate: Candidate; oid: string } | null = null
  for (const candidate of head) {
    const oid = await verify(run, candidate.spec)
    if (oid !== null) {
      found = { candidate, oid }
      break
    }
  }
  if (found === null) {
    // ③ 은 앞 출처가 다 안 풀렸을 때만 묻는다 — 쓰지 않을 symbolic-ref 를 부르지 않는다.
    const chain = [...(await originHead(run)), ...DEFAULT_CHAIN.map((item): Candidate => ({ source: 'default', name: item.name, spec: item.ref }))]
    for (const candidate of chain) {
      const oid = await verify(run, candidate.spec)
      if (oid !== null) {
        found = { candidate, oid }
        break
      }
    }
  }
  if (found === null) return { ok: false, reason: 'no_base', error: 'base 브랜치를 찾지 못했다' }
  const merged = await run(scmMergeBaseArgs(found.oid))
  // `git merge-base` — 공통 조상이 없으면 출력 없이 exit 1.
  if (!merged.ok) return merged.code === 1 ? { ok: false, reason: 'no_merge_base', error: `${found.candidate.name} 와(과) 공통 조상이 없다` } : { ok: false, reason: 'git_error', error: merged.error }
  const mergeBase = merged.stdout.trim().split('\n')[0] ?? ''
  if (!OID.test(mergeBase)) return { ok: false, reason: 'git_error', error: 'merge-base 를 읽지 못했다' }
  return { ok: true, info: { name: found.candidate.name, source: found.candidate.source, mergeBase } }
}

/** base 대비 목록 — `status` 는 같은 회차 `git status` 의 분류(추적 안 함을 여기서 얻는다). `limit` 상한 + 1 개까지만 싣는다. */
export async function computeScmBase(input: { run: GitRun; status: readonly ScmChange[]; limit: number } & ScmBaseInputs): Promise<ScmBasePush> {
  const resolved = await resolveScmBase(input)
  if (!resolved.ok) return resolved
  const diff = await input.run(scmBaseDiffArgs(resolved.info.mergeBase))
  if (!diff.ok) return { ok: false, reason: 'git_error', error: diff.error }
  const changes = withUntracked({ diff: parseBaseDiff(diff.stdout), status: input.status })
  return { ok: true, info: resolved.info, changes: changes.slice(0, input.limit + 1), total: changes.length }
}

/** 실제 git — `git -C <cwd>`. 출력은 utf8(경로는 `core.quotePath=false` 로 그대로). */
export function gitRunner(cwd: string): GitRun {
  return (args) =>
    new Promise((resolve) => {
      execFile('git', ['-C', cwd, ...args], { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        if (error === null) resolve({ ok: true, stdout })
        else resolve({ ok: false, code: typeof error.code === 'number' ? error.code : null, error: String(error).slice(0, 300) })
      })
    })
}
