// 소스 제어 diff 의 git 쪽 내용 읽기 (LIFE-683 S7) — HEAD·인덱스(stage 0) 두 쪽만, 읽기 전용.
//
// · 가둠: 루트는 열린 worktree(`confine` — 렌더러가 준 루트를 그대로 믿지 않는다), 경로는 어휘 검사(`isPlainRel` — 지워진 파일도 읽어야 해서
//   디스크 realpath 로는 못 가둔다; git 객체 이름 `<rev>:./<경로>` 는 그 worktree 트리 안만 가리킨다).
// · argv 는 고정 문자열뿐이다 — 경로는 `cat-file --batch-check -z` 의 stdin(NUL 끝)으로만 넘기고, 내용은 그 응답의 oid(hex 검사)로 `cat-file blob` 한다.
//   렌더러는 ref 를 고를 수 없다(`side` 닫힌 세 값 → `HEAD` · 빈 rev = 인덱스 · `base` = main 이 그 루트에서 푼 merge-base oid — LIFE-830).
//   `base` 의 base·merge-base 는 `resolveBase`(main 이 레지스트리 재료로 `scm-base.ts` 를 부른다)가 풀고, 여기서는 hex 검사만 다시 한다.
// · `--no-optional-locks`(LIFE-672) — `.git/index.lock` 을 잡지 않는다. cat-file 은 원래 인덱스를 쓰지 않는다.
// · 상한·바이너리 판정은 `file-read.ts` 와 같은 값(50 MB · 앞 8 KB NUL). 크기를 먼저 보고 넘으면 내용을 읽지 않는다.
import { execFile } from 'node:child_process'
import { confine, MAX_REL_LENGTH } from './explorer-fs.js'
import { decodeText, looksBinary } from './file-read.js'
import { TEXT_LIMIT_BYTES } from '../shared/file-view.js'
import { isPlainRel, type ScmBaseInfo, type ScmReadResult } from '../shared/scm.js'
import type { ScmBaseResolved } from './scm-base.js'

/** 시험이 argv 를 고정한다. */
export const SCM_CHECK_ARGS = ['--no-optional-locks', 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)', '-z']
export const scmBlobArgs = (oid: string): string[] => ['--no-optional-locks', 'cat-file', 'blob', oid]

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

function run(input: { cwd: string; args: string[]; stdin?: string; maxBuffer: number }): Promise<{ ok: true; stdout: Buffer } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', input.cwd, ...input.args], { encoding: 'buffer', timeout: 15_000, maxBuffer: input.maxBuffer }, (error, stdout) => {
      if (error !== null) resolve({ ok: false, error: String(error).slice(0, 300) })
      else resolve({ ok: true, stdout })
    })
    child.stdin?.end(input.stdin ?? '')
  })
}

export async function readScmContent(input: {
  roots: readonly string[]
  root: unknown
  rel: unknown
  side: unknown
  limit?: number
  /** side `base` 의 merge-base 풀이(LIFE-830) — 가둔 루트(논리 경로·실경로)로 부른다. 없으면 `base` 를 거절한다. */
  resolveBase?: (input: { root: string; realRoot: string }) => Promise<ScmBaseResolved>
}): Promise<ScmReadResult> {
  const limit = input.limit ?? TEXT_LIMIT_BYTES
  const side = input.side
  if (side !== 'head' && side !== 'index' && side !== 'base') return { ok: false, code: 'bad_path', error: 'side 는 head·index·base 만' }
  if (side === 'base' && input.resolveBase === undefined) return { ok: false, code: 'bad_path', error: 'base 를 풀 수 없다' }
  // F2-03 — 길이 상한은 탐색기 가둠(`explorer-fs.ts` `MAX_REL_LENGTH`)과 같다(`confine` 은 루트만 보므로 여기서 본다).
  if (typeof input.rel !== 'string' || input.rel.length > MAX_REL_LENGTH || !isPlainRel(input.rel)) return { ok: false, code: 'bad_path', error: '상대 경로 형 위반' }
  const confined = await confine({ roots: input.roots, root: input.root, rel: '' })
  if (!confined.ok || typeof input.root !== 'string') return { ok: false, code: 'not_worktree', error: confined.ok ? '루트 형 위반' : confined.error }
  let rev = side === 'head' ? 'HEAD' : ''
  let base: { base?: ScmBaseInfo } = {}
  if (side === 'base') {
    const resolved = await input.resolveBase?.({ root: input.root, realRoot: confined.realRoot })
    if (resolved === undefined || !resolved.ok) return { ok: false, code: 'git_error', error: resolved === undefined ? 'base 를 풀 수 없다' : resolved.error }
    if (!OID.test(resolved.info.mergeBase)) return { ok: false, code: 'git_error', error: 'merge-base 형 위반' }
    rev = resolved.info.mergeBase
    base = { base: resolved.info }
  }
  const spec = `${rev}:./${input.rel}`
  const checked = await run({ cwd: confined.realRoot, args: SCM_CHECK_ARGS, stdin: `${spec}\0`, maxBuffer: 64 * 1024 })
  if (!checked.ok) return { ok: false, code: 'git_error', error: checked.error }
  const [oid, type, sizeText] = checked.stdout.toString('utf8').split('\n')[0]?.split(' ') ?? []
  // 없는 객체(`<spec> missing`)·blob 아닌 것(하위 모듈 commit) — 내용 없음.
  if (oid === undefined || !OID.test(oid) || type !== 'blob') return { ok: true, kind: 'missing', ...base }
  const size = Number(sizeText)
  if (!Number.isFinite(size)) return { ok: false, code: 'git_error', error: '크기를 읽지 못했다' }
  if (size > limit) return { ok: true, kind: 'too_large', size, limit, ...base }
  const blob = await run({ cwd: confined.realRoot, args: scmBlobArgs(oid), maxBuffer: Math.max(size, 1) + 1 })
  if (!blob.ok) return { ok: false, code: 'git_error', error: blob.error }
  const bytes = new Uint8Array(blob.stdout.buffer, blob.stdout.byteOffset, blob.stdout.byteLength)
  if (looksBinary(bytes)) return { ok: true, kind: 'binary', size, ...base }
  return { ok: true, kind: 'text', text: decodeText(bytes).text, size, ...base }
}
