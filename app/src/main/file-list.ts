// worktree 전체 파일 목록 (LIFE-593 F5 · E4·E7ⓓ·E8) — **읽기 전용**. 렌더러가 준 루트를 F1 `confine` 으로 「지금 열린 worktree 루트」 와 문자열로 대조한 뒤에만 git 을 부른다.
//
// · 목록 출처 = `git ls-files`(`specs/LIFE-593-quick-open/raw/claude/list-source.md` — corral 레포 6.4만·20만 fixture 둘 다 0.4 s 안, 번들 바이너리 없음).
//   끔(기본) = `--cached --others --exclude-standard` − `--deleted`. 켬 = 위 + `--others --ignored --exclude-standard`(`.git`·`node_modules` 아래는 pathspec 으로 순회부터 자르고, 결과에서도 한 번 더 뺀다).
//   git 은 심볼릭 링크를 따라 들어가지 않는다 — 링크(파일·폴더)는 그 자신 한 줄이고, 고른 링크를 여는 것은 `file-read.ts` 가둠이 다시 판정한다(E8ⓓ).
// · 자식 프로세스는 셸 없이 인자 배열로(`execFile`), 실행 파일은 **PATH 의 절대 경로 항목만** 훑어 고른 git 절대 경로다 — PATH 의 상대 항목(`.` 등)과 worktree 안에
//   심은 `git` 은 후보가 아니다(E8ⓒ). cwd 는 넘기지 않고 `-C <realpath(루트)>` 로만 가리킨다. `core.fsmonitor=false` 로 레포 설정이 부르는 감시 명령을 끈다 —
//   `explorer-hub.ts` 의 `git status`(레포 설정 그대로)보다 좁다. 렌더러 입력은 실행 인자에 들어가지 않는다(루트는 confine 을 지난 realpath, 나머지는 고정 인자).
// · 타임아웃 10 s·출력 상한 128 MB·목록 상한 `FILE_LIST_MAX`. 요청마다 AbortController 를 들고 취소 IPC(대화상자 닫기·worktree 전환)·앱 종료 때 자식을 끝낸다(E7ⓓ).
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { confine } from './explorer-fs.js'
import { FILE_LIST_MAX, FILE_LIST_REQUEST_ID, mergeFileLists, type FileListResult } from '../shared/file-list.js'

const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER = 128 * 1024 * 1024
/** git 이 레포 설정으로 외부 명령을 부르지 않게(fsmonitor 훅) · 경로를 따옴표로 감싸지 않게(-z 라 원래 안 감싸지만 명시). */
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false']
export const LS_LISTED = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
export const LS_DELETED = ['ls-files', '-z', '--deleted']
export const LS_IGNORED = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '.', ':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/.git/**']

/**
 * git 절대 경로 — PATH 의 **절대 경로 항목**만 앞에서부터 보고 실행 가능한 일반 파일 `git` 을 고른다. 없으면 `/usr/bin/git`(macOS 기본 shim).
 * `execFile('git')` 은 PATH 의 상대 항목을 앱 cwd 기준으로 풀 수 있다 — 그 길을 닫는다. 앱이 이미 쓰는 해석(`execFile('git')` = PATH 첫 git)과 같은 git 을 고르되 더 좁다.
 */
export function resolveGit(input: { pathEnv: string | undefined; isExecutable?: (file: string) => boolean }): string {
  const isExecutable =
    input.isExecutable ??
    ((file: string): boolean => {
      try {
        const stat = fs.statSync(file)
        if (!stat.isFile()) return false
        fs.accessSync(file, fs.constants.X_OK)
        return true
      } catch {
        return false
      }
    })
  for (const dir of (input.pathEnv ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue
    const candidate = path.join(dir, 'git')
    if (isExecutable(candidate)) return candidate
  }
  return '/usr/bin/git'
}

type RunOutcome = { ok: true; stdout: string } | { ok: false; code: 'cancelled' | 'timeout' | 'git_failed'; error: string }

function runGit(input: { git: string; cwd: string; args: readonly string[]; signal: AbortSignal }): Promise<RunOutcome> {
  return new Promise((resolve) => {
    execFile(
      input.git,
      [...GIT_SAFE_CONFIG, '-C', input.cwd, ...input.args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, signal: input.signal, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout) => {
        if (error === null) {
          resolve({ ok: true, stdout })
          return
        }
        if (input.signal.aborted) resolve({ ok: false, code: 'cancelled', error: '취소됨' })
        else if ('killed' in error && error.killed === true) resolve({ ok: false, code: 'timeout', error: `git 시간 초과 ${GIT_TIMEOUT_MS} ms` })
        else resolve({ ok: false, code: 'git_failed', error: String(error).slice(0, 300) })
      },
    )
  })
}

export type FileListDeps = { roots: () => readonly string[]; git: () => string; log: (event: string, data?: Record<string, unknown>) => void; now?: () => number }

/** 진행 중인 목록 작업 — 요청 id → 취소기. 같은 id 로 다시 오면 앞 것을 끝낸다. */
export class FileLister {
  private readonly running = new Map<string, AbortController>()

  constructor(private readonly deps: FileListDeps) {}

  /** 진행 중 작업 수(계측 — E7ⓓ 「자식 0」 은 ps 로도 본다). */
  get active(): number {
    return this.running.size
  }

  cancel(requestId: unknown): boolean {
    if (typeof requestId !== 'string') return false
    const controller = this.running.get(requestId)
    if (controller === undefined) return false
    controller.abort()
    this.running.delete(requestId)
    return true
  }

  cancelAll(): void {
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
  }

  async list(input: unknown): Promise<FileListResult> {
    const field = (name: string): unknown => (typeof input === 'object' && input !== null && name in input ? Reflect.get(input, name) : undefined)
    const root = field('root')
    const includeIgnored = field('includeIgnored')
    const requestId = field('requestId')
    if (typeof includeIgnored !== 'boolean' || typeof requestId !== 'string' || !FILE_LIST_REQUEST_ID.test(requestId)) return { ok: false, code: 'invalid_argument', error: '요청 형 위반' }
    const confined = await confine({ roots: this.deps.roots(), root, rel: '' })
    if (!confined.ok) return { ok: false, code: confined.code, error: confined.error }
    this.cancel(requestId)
    const controller = new AbortController()
    this.running.set(requestId, controller)
    const now = this.deps.now ?? (() => performance.now())
    const startedAt = now()
    try {
      const git = this.deps.git()
      const run = (args: readonly string[]): Promise<RunOutcome> => runGit({ git, cwd: confined.realRoot, args, signal: controller.signal })
      const [listed, deleted, ignored] = await Promise.all([run(LS_LISTED), run(LS_DELETED), includeIgnored ? run(LS_IGNORED) : Promise.resolve(null)])
      const failed = [listed, deleted, ignored].find((outcome): outcome is Extract<RunOutcome, { ok: false }> => outcome !== null && !outcome.ok)
      if (failed !== undefined) {
        // 하나가 실패하면 나머지 자식도 끝낸다.
        if (!controller.signal.aborted) controller.abort()
        this.deps.log('file.list', { ok: false, includeIgnored, code: failed.code, ms: Math.round((now() - startedAt) * 10) / 10 })
        return { ok: false, code: failed.code, error: failed.error }
      }
      if (!listed.ok || !deleted.ok || (ignored !== null && !ignored.ok)) return { ok: false, code: 'git_failed', error: 'git 실패' }
      const merged = mergeFileLists({ listed: listed.stdout, deleted: deleted.stdout, ignored: ignored === null ? null : ignored.stdout, max: FILE_LIST_MAX })
      const ms = Math.round((now() - startedAt) * 10) / 10
      this.deps.log('file.list', { ok: true, includeIgnored, count: merged.files.length, truncated: merged.truncated, ms })
      return { ok: true, root: typeof root === 'string' ? root : '', includeIgnored, files: merged.files, truncated: merged.truncated, ms }
    } finally {
      if (this.running.get(requestId) === controller) this.running.delete(requestId)
    }
  }
}
