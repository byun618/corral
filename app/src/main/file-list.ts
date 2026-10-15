// worktree 전체 파일 목록 (LIFE-593 F5 · E4·E7ⓓ·E8) — **읽기 전용**. 렌더러가 준 루트를 F1 `confine` 으로 「지금 열린 worktree 루트」 와 문자열로 대조한 뒤에만 git 을 부른다.
//
// · 목록 출처 = `git ls-files`(`specs/LIFE-593-quick-open/raw/claude/list-source.md` — corral 레포 6.4만·20만 fixture 둘 다 0.4 s 안, 번들 바이너리 없음).
//   끔(기본) = `--cached --others --exclude-standard` − `--deleted`. 켬 = 위 + `--others --ignored --exclude-standard`(`.git`·`node_modules` 아래는 pathspec 으로 순회부터 자르고, 결과에서도 한 번 더 뺀다).
//   git 은 심볼릭 링크를 따라 들어가지 않는다 — 링크(파일·폴더)는 그 자신 한 줄이고, 고른 링크를 여는 것은 `file-read.ts` 가둠이 다시 판정한다(E8ⓓ).
// · 자식 프로세스는 셸 없이 인자 배열로(`spawn`), 실행 파일은 **PATH 의 절대 경로 항목만** 훑어 고른 git 절대 경로다 — PATH 의 상대 항목(`.` 등)과 **열린 worktree
//   루트 아래**(PATH 폴더나 후보 파일의 실경로가 그 안) git 은 후보가 아니다(E8ⓒ · 수정 r1 R1-C-04 — 목록을 부를 때마다 그때 열린 루트로 다시 고른다). cwd 는 넘기지 않고 `-C <realpath(루트)>` 로만 가리킨다. `core.fsmonitor=false` 로 레포 설정이 부르는 감시 명령을 끈다 —
//   `explorer-hub.ts` 의 `git status`(레포 설정 그대로)보다 좁다. 렌더러 입력은 실행 인자에 들어가지 않는다(루트는 confine 을 지난 realpath, 나머지는 고정 인자).
// · 타임아웃 10 s·출력 상한 128 MB·목록 상한 `FILE_LIST_MAX`. 요청마다 AbortController 를 들고 취소 IPC(대화상자 닫기·worktree 전환)·앱 종료 때 자식을 끝낸다(E7ⓓ).
//   수정 r1(R1-C-03·R1-G-01) — 취소기는 첫 await **전에** 건다(같은 틱 취소가 유실되지 않게). git 은 자기 프로세스 그룹으로 띄우고(`detached`) 취소·시간 초과·상한 초과 때
//   그룹 전체에 SIGTERM → 잠시 뒤 SIGKILL 을 보낸다 — git 이 띄운 손주까지 끝난다. 자식이 실제로 끝나(`close`) 기록에서 빠져야 `liveChildren` 이 준다.
//   하나가 실패하면 나머지를 바로 끝내고 첫 실제 실패 코드를 낸다. 취소된 요청은 git 이 끝나 있어도 `cancelled` 로 답한다(R1-G-02 — 늦은 성공이 새 목록을 덮지 않게).
// · 경로 모양(수정 r1 R1-C-02) — git 은 경로를 NFC 로 주지만(macOS `core.precomposeunicode`) 디스크 이름은 NFD 일 수 있다. 비 ASCII 경로는 부모 폴더를 읽어
//   NFC 가 같은 **디스크 이름**으로 바꿔 준다 — 탐색기(readdir)로 연 것과 같은 경로라 같은 탭·같은 최근 기록·같은 reveal 이 된다.
// · 고를 수 없는 추적 항목(수정 r1 R1-C-05 · 수정 r2 R2-C-02) — gitlink 는 빼고, 추적 중인 링크가 폴더를 가리키면 뺀다. skip-worktree(`S`)는 디스크에 파일(또는 파일 링크)로
//   있을 때만 넣는다 — sparse 로 디스크에 없는 것뿐 아니라 「로컬 변경 무시」 로 표시한 디스크에 있는 파일에도 붙는 태그다(`parseStagedListing`).
// · 앱 종료(수정 r2 R2-C-01) — quit-gate 를 지난 `before-quit` 에서 `killAll()` 이 진행 중 git 그룹에 **동기로** SIGKILL 을 보낸다(종료 중에는 500 ms 타이머가 돌지 못한다).
//   정지를 정한 뒤 `STOP_CLOSE_MS` 안에 `close` 가 없으면(그룹을 벗어난 자손이 출력을 쥠) 스트림을 닫고 끝낸다(R2-C-05).
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { confine } from './explorer-fs.js'
import { FILE_LIST_MAX, FILE_LIST_REQUEST_ID, mergeFileListsSteps, parseStagedListing, type FileListResult } from '../shared/file-list.js'

const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BYTES = 128 * 1024 * 1024
/** SIGTERM 뒤 이만큼 기다려도 남아 있으면 그룹에 SIGKILL. */
const KILL_GRACE_MS = 500
/** 정지(취소·시간 초과·상한)를 정한 뒤 이만큼 지나도 `close` 가 없으면 출력 스트림을 닫고 그 결과로 끝낸다. */
const STOP_CLOSE_MS = 1_500
/** `toDiskNames` 가 이만큼 일하면 이벤트 루프에 한 번 양보한다(R2-C-06). */
const YIELD_BUDGET_MS = 8
/** 디스크 확인 한 덩이(동시에 열린 stat 수의 상한) — 수정 r3 R3-C-01. */
const DISK_CHECK_CHUNK = 256
/** 등록 전에 온 취소를 기억하는 시간·개수(요청 id 는 매번 새것이라 늦게 온 같은 id 목록 요청만 막는다). */
const TOMBSTONE_MS = 30_000
const TOMBSTONE_MAX = 64
/** git 이 레포 설정으로 외부 명령을 부르지 않게(fsmonitor 훅) · 경로를 따옴표로 감싸지 않게(-z 라 원래 안 감싸지만 명시). */
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false']
/** 추적(+ untracked) — `-s -t` 로 태그·모드를 받아 gitlink·폴더 링크·디스크에 없는 skip-worktree 를 가린다(`parseStagedListing`). */
export const LS_LISTED = ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '-s', '-t']
export const LS_DELETED = ['ls-files', '-z', '--deleted']
export const LS_IGNORED = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '.', ':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/.git/**']

const realOr = (file: string): string => {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}
const inside = (file: string, root: string): boolean => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/**
 * git 절대 경로 — PATH 의 **절대 경로 항목**만 앞에서부터 보고 실행 가능한 일반 파일 `git` 을 고른다. 없으면 `/usr/bin/git`(macOS 기본 shim).
 * `execFile('git')` 은 PATH 의 상대 항목을 앱 cwd 기준으로 풀 수 있다 — 그 길을 닫는다. 앱이 이미 쓰는 해석(`execFile('git')` = PATH 첫 git)과 같은 git 을 고르되 더 좁다.
 * `roots` = 지금 열린 worktree 루트들 — PATH 폴더나 후보 파일의 실경로가 그 아래면 건너뛴다(수정 r1 R1-C-04: 레포가 심은 `tools/bin/git` 이 사용자 PATH 에 있어도).
 * worktree 밖 사용자 PATH 는 그대로 쓴다.
 */
export function resolveGit(input: { pathEnv: string | undefined; roots?: readonly string[]; isExecutable?: (file: string) => boolean }): string {
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
  const roots = (input.roots ?? []).flatMap((root) => [path.resolve(root), realOr(root)])
  const planted = (file: string): boolean => roots.some((root) => inside(path.resolve(file), root) || inside(realOr(file), root))
  for (const dir of (input.pathEnv ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) continue
    const candidate = path.join(dir, 'git')
    if (roots.length > 0 && (planted(dir) || planted(candidate))) continue
    if (isExecutable(candidate)) return candidate
  }
  return '/usr/bin/git'
}

type Failure = { ok: false; code: 'cancelled' | 'timeout' | 'git_failed'; error: string }
type RunOutcome = { ok: true; stdout: string } | Failure

/**
 * git 한 번 — 셸 없이 자기 프로세스 그룹으로 띄운다. 멈추게 할 때(취소·시간 초과·출력 상한)는 그룹 전체에 SIGTERM, `KILL_GRACE_MS` 뒤에도 남았으면 SIGKILL.
 * 끝(`close` — 자식이 끝나고 출력이 닫힘)에서만 답하고 `children` 에서 뺀다. 정상 종료 뒤에도 그룹에 남은 손주가 있으면 끝낸다.
 */
function runGit(input: { git: string; cwd: string; args: readonly string[]; signal: AbortSignal; timeoutMs: number; maxBytes: number; children: Set<ChildProcess> }): Promise<RunOutcome> {
  return new Promise((resolve) => {
    if (input.signal.aborted) {
      resolve({ ok: false, code: 'cancelled', error: '취소됨' })
      return
    }
    let child: ChildProcess
    try {
      child = spawn(input.git, [...GIT_SAFE_CONFIG, '-C', input.cwd, ...input.args], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      })
    } catch (error) {
      resolve({ ok: false, code: 'git_failed', error: String(error).slice(0, 300) })
      return
    }
    input.children.add(child)
    const chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''
    let stopped: 'cancelled' | 'timeout' | 'too_large' | null = null
    let spawnError: string | null = null
    let killTimer: NodeJS.Timeout | null = null
    let closeTimer: NodeJS.Timeout | null = null
    let finished = false
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        // 그룹이 이미 없다.
      }
    }
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      if (closeTimer !== null) clearTimeout(closeTimer)
      input.signal.removeEventListener('abort', onAbort)
      input.children.delete(child)
      if (stopped === 'cancelled' || (stopped === null && input.signal.aborted)) resolve({ ok: false, code: 'cancelled', error: '취소됨' })
      else if (stopped === 'timeout') resolve({ ok: false, code: 'timeout', error: `git 시간 초과 ${input.timeoutMs} ms` })
      else if (stopped === 'too_large') resolve({ ok: false, code: 'git_failed', error: `git 출력 상한 ${input.maxBytes} B 초과` })
      else if (spawnError !== null) resolve({ ok: false, code: 'git_failed', error: spawnError })
      else if (code !== 0) resolve({ ok: false, code: 'git_failed', error: `git 종료 ${code ?? signal} ${stderr.trim()}`.slice(0, 300) })
      else resolve({ ok: true, stdout: Buffer.concat(chunks).toString('utf8') })
    }
    const stop = (why: 'cancelled' | 'timeout' | 'too_large'): void => {
      if (stopped !== null) return
      stopped = why
      killGroup('SIGTERM')
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      // 그룹을 벗어난 자손이 출력을 쥐면 close 가 오지 않는다 — 스트림을 닫고 끝낸다(R2-C-05).
      closeTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(null, null)
      }, STOP_CLOSE_MS)
    }
    const onAbort = (): void => stop('cancelled')
    input.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => stop('timeout'), input.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stopped !== null) return
      bytes += chunk.length
      if (bytes > input.maxBytes) stop('too_large')
      else chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 300) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      spawnError = String(error).slice(0, 300)
    })
    // 자식이 끝났는데 손주가 출력을 쥐고 있으면 close 가 오지 않는다 — 그룹을 끝낸다.
    child.on('exit', () => killGroup('SIGKILL'))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** 진행 중 git 그룹에 지금 바로 SIGKILL(앱 종료 — 타이머를 기다릴 수 없다). */
function killNow(children: ReadonlySet<ChildProcess>): void {
  for (const child of children) {
    if (child.pid === undefined) continue
    for (const target of [-child.pid, child.pid]) {
      try {
        process.kill(target, 'SIGKILL')
      } catch {
        // 이미 없다.
      }
    }
  }
}

const NON_ASCII = /[\u0080-\uffff]/

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** 생성기를 `YIELD_BUDGET_MS` 덩이로 돌리며 사이사이 이벤트 루프에 양보한다(수정 r2 R2-C-06). 취소되면 null. */
async function drainYielding<T>(steps: Generator<void, T, void>, signal: AbortSignal): Promise<T | null> {
  let sliceStart = performance.now()
  for (;;) {
    if (signal.aborted) return null
    const next = steps.next()
    if (next.done === true) return next.value
    if (performance.now() - sliceStart >= YIELD_BUDGET_MS) {
      await nextTurn()
      sliceStart = performance.now()
    }
  }
}

/**
 * 비 ASCII 경로 → 디스크 이름(수정 r1 R1-C-02). 성분마다 부모 폴더를 한 번씩 읽어(폴더별 기억) NFC 가 같은 항목 이름으로 바꾼다. 못 찾으면 git 이 준 이름 그대로.
 * 읽기 전용(readdir). 수정 r2 R2-C-06 — 부모 폴더의 실경로가 루트 아래일 때만 읽는다(중간 성분이 밖을 가리키는 링크로 바뀌었으면 git 이름 그대로).
 * `YIELD_BUDGET_MS` 마다 이벤트 루프에 양보하고(한글 12만 경로에서 main 이 한 덩이로 막히지 않게), 취소되면 멈춘다.
 */
export async function toDiskNames(input: { realRoot: string; files: string[]; signal: AbortSignal }): Promise<void> {
  const dirs = new Map<string, Promise<Map<string, string> | null>>()
  const rootPrefix = input.realRoot.endsWith(path.sep) ? input.realRoot : input.realRoot + path.sep
  const namesOf = (dir: string): Promise<Map<string, string> | null> => {
    const known = dirs.get(dir)
    if (known !== undefined) return known
    const full = path.join(input.realRoot, dir)
    const made = fs.promises
      .realpath(full)
      .then((real) => (real === input.realRoot || real.startsWith(rootPrefix) ? fs.promises.readdir(real) : null))
      .then(
        (names) => {
          if (names === null) return null
          const byNfc = new Map<string, string>()
          for (const name of names) if (NON_ASCII.test(name)) byNfc.set(name.normalize('NFC'), name)
          return byNfc
        },
        () => null,
      )
    dirs.set(dir, made)
    return made
  }
  let sliceStart = performance.now()
  for (let index = 0; index < input.files.length; index += 1) {
    const rel = input.files[index] ?? ''
    if (!NON_ASCII.test(rel)) continue
    if (performance.now() - sliceStart >= YIELD_BUDGET_MS) {
      await nextTurn()
      sliceStart = performance.now()
    }
    if (input.signal.aborted) return
    let disk = ''
    for (const part of rel.split('/')) {
      let name = part
      if (NON_ASCII.test(part)) name = (await namesOf(disk))?.get(part.normalize('NFC')) ?? part
      disk = disk === '' ? name : `${disk}/${name}`
    }
    input.files[index] = disk
  }
}

/**
 * 디스크로 가를 추적 항목(수정 r1 R1-C-05 · 수정 r2 R2-C-02·R2-C-06) — 빼야 할 경로 집합을 돌려준다. 취소되면 남은 것은 보지 않는다.
 * `links`(추적 중인 링크): 따라간 stat 이 폴더면 뺀다. 깨진 링크는 남긴다(열면 안내).
 * `skipped`(skip-worktree): lstat 이 없거나 폴더면 뺀다. 링크면 따라간 대상이 폴더일 때 뺀다 — 디스크에 파일(또는 파일 링크)로 있으면 남긴다.
 */
export async function notOnDiskAsFiles(input: { realRoot: string; links: readonly string[]; skipped: readonly string[]; signal: AbortSignal }): Promise<Set<string>> {
  const drop = new Set<string>()
  const pointsToDir = async (rel: string): Promise<boolean> => {
    try {
      return (await fs.promises.stat(path.join(input.realRoot, rel))).isDirectory()
    } catch {
      return false
    }
  }
  const checkLink = async (rel: string): Promise<void> => {
    if (await pointsToDir(rel)) drop.add(rel)
  }
  const checkSkipped = async (rel: string): Promise<void> => {
    try {
      const stat = await fs.promises.lstat(path.join(input.realRoot, rel))
      if (stat.isFile()) return
      if (!stat.isSymbolicLink() || (await pointsToDir(rel))) drop.add(rel)
    } catch {
      drop.add(rel)
    }
  }
  // 수정 r3 R3-C-01 — sparse 로 디스크에 없는 S 가 수만이면 한꺼번에 건 stat 이 main 루프를 막는다. 덩이로 나눠 열린 요청 수를 묶고, 덩이마다 양보·취소 확인.
  const inChunks = async (chunked: { items: readonly string[]; check: (rel: string) => Promise<void> }): Promise<void> => {
    for (let start = 0; start < chunked.items.length && !input.signal.aborted; start += DISK_CHECK_CHUNK) {
      await Promise.all(chunked.items.slice(start, start + DISK_CHECK_CHUNK).map(chunked.check))
      await nextTurn()
    }
  }
  await inChunks({ items: input.links, check: checkLink })
  await inChunks({ items: input.skipped, check: checkSkipped })
  return drop
}

export type FileListDeps = {
  roots: () => readonly string[]
  /** git 절대 경로 — 그때 열린 루트들을 받아 고른다(`resolveGit` — R1-C-04). */
  git: (roots: readonly string[]) => string
  log: (event: string, data?: Record<string, unknown>) => void
  now?: () => number
  /** 시험용 — 기본 10 s · 128 MB. */
  timeoutMs?: number
  maxBytes?: number
}

/** 진행 중인 목록 작업 — 요청 id → 취소기. 같은 id 로 다시 오면 앞 것을 끝낸다. */
export class FileLister {
  private readonly running = new Map<string, AbortController>()
  /** 진행 중 작업이 없을 때 온 취소(요청 id → 시각) — 그 id 의 목록 요청이 늦게 와도 git 을 띄우지 않는다. */
  private readonly tombstones = new Map<string, number>()
  private readonly children = new Set<ChildProcess>()

  constructor(private readonly deps: FileListDeps) {}

  /** 진행 중 작업 수. */
  get active(): number {
    return this.running.size
  }

  /** 아직 끝나지 않은 git 자식 수(E7ⓓ 「자식 0」 계측 — 자식이 실제로 끝나 `close` 가 와야 준다). */
  get liveChildren(): number {
    return this.children.size
  }

  cancel(requestId: unknown): boolean {
    if (typeof requestId !== 'string') return false
    const controller = this.running.get(requestId)
    if (controller === undefined) {
      if (FILE_LIST_REQUEST_ID.test(requestId)) this.remember(requestId)
      return false
    }
    controller.abort()
    this.running.delete(requestId)
    return true
  }

  cancelAll(): void {
    for (const controller of this.running.values()) controller.abort()
    this.running.clear()
  }

  /** 앱 종료(수정 r2 R2-C-01) — 모두 취소하고, 남은 git 그룹에 지금 바로 SIGKILL(종료 중에는 SIGTERM 뒤 500 ms 타이머를 기다릴 수 없다). */
  killAll(): void {
    this.cancelAll()
    killNow(this.children)
  }

  private remember(requestId: string): void {
    const now = Date.now()
    for (const [id, at] of this.tombstones) if (now - at > TOMBSTONE_MS || this.tombstones.size >= TOMBSTONE_MAX) this.tombstones.delete(id)
    this.tombstones.set(requestId, now)
  }

  async list(input: unknown): Promise<FileListResult> {
    const field = (name: string): unknown => (typeof input === 'object' && input !== null && name in input ? Reflect.get(input, name) : undefined)
    const root = field('root')
    const includeIgnored = field('includeIgnored')
    const requestId = field('requestId')
    if (typeof includeIgnored !== 'boolean' || typeof requestId !== 'string' || !FILE_LIST_REQUEST_ID.test(requestId)) return { ok: false, code: 'invalid_argument', error: '요청 형 위반' }
    const cancelled: FileListResult = { ok: false, code: 'cancelled', error: '취소됨' }
    if (this.tombstones.delete(requestId)) return cancelled
    // 취소기는 첫 await 전에 건다 — 같은 틱에 온 취소가 이것을 찾는다(R1-C-03).
    this.running.get(requestId)?.abort()
    const controller = new AbortController()
    this.running.set(requestId, controller)
    const now = this.deps.now ?? (() => performance.now())
    const startedAt = now()
    const ms = (): number => Math.round((now() - startedAt) * 10) / 10
    try {
      const roots = this.deps.roots()
      const confined = await confine({ roots, root, rel: '' })
      if (controller.signal.aborted) return cancelled
      if (!confined.ok) return { ok: false, code: confined.code, error: confined.error }
      // 자식들이 같이 쓰는 내부 취소기 — 사용자 취소(controller)와 「하나가 실패해 나머지를 끝냄」 을 가른다.
      const stopAll = new AbortController()
      controller.signal.addEventListener('abort', () => stopAll.abort(), { once: true })
      const first: { failure: Failure | null } = { failure: null }
      const git = this.deps.git(roots)
      const run = (args: readonly string[]): Promise<RunOutcome> =>
        runGit({ git, cwd: confined.realRoot, args, signal: stopAll.signal, timeoutMs: this.deps.timeoutMs ?? GIT_TIMEOUT_MS, maxBytes: this.deps.maxBytes ?? GIT_MAX_BYTES, children: this.children }).then((outcome) => {
          if (!outcome.ok && outcome.code !== 'cancelled' && first.failure === null) {
            first.failure = outcome
            stopAll.abort()
          }
          return outcome
        })
      const [listed, deleted, ignored] = await Promise.all([run(LS_LISTED), run(LS_DELETED), includeIgnored ? run(LS_IGNORED) : Promise.resolve(null)])
      if (controller.signal.aborted) return cancelled
      const failure = first.failure
      if (failure !== null) {
        this.deps.log('file.list', { ok: false, includeIgnored, code: failure.code, ms: ms() })
        return { ok: false, code: failure.code, error: failure.error }
      }
      if (!listed.ok || !deleted.ok || (ignored !== null && !ignored.ok)) return { ok: false, code: 'git_failed', error: 'git 실패' }
      const staged = parseStagedListing(listed.stdout)
      const drop = staged.links.length === 0 && staged.skipped.length === 0 ? null : await notOnDiskAsFiles({ realRoot: confined.realRoot, links: staged.links, skipped: staged.skipped, signal: controller.signal })
      if (controller.signal.aborted) return cancelled
      const keptSkipped = staged.skipped.filter((rel) => drop === null || !drop.has(rel))
      const listedAll = keptSkipped.length === 0 ? staged.listed : [staged.listed, ...keptSkipped].filter((part) => part !== '').join('\0')
      const merged = await drainYielding(mergeFileListsSteps({ listed: listedAll, deleted: deleted.stdout, ignored: ignored === null ? null : ignored.stdout, max: FILE_LIST_MAX }), controller.signal)
      if (merged === null || controller.signal.aborted) return cancelled
      const files = drop === null || drop.size === 0 ? merged.files : merged.files.filter((rel) => !drop.has(rel))
      await toDiskNames({ realRoot: confined.realRoot, files, signal: controller.signal })
      if (controller.signal.aborted) return cancelled
      this.deps.log('file.list', { ok: true, includeIgnored, count: files.length, truncated: merged.truncated, ms: ms() })
      return { ok: true, root: typeof root === 'string' ? root : '', includeIgnored, paths: files.join('\0'), count: files.length, truncated: merged.truncated, ms: ms() }
    } finally {
      if (this.running.get(requestId) === controller) this.running.delete(requestId)
    }
  }
}
