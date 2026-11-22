// 소스 제어 로컬 쓰기 (LIFE-829) — **앱의 첫 git 쓰기 모듈**. stage·unstage·discard·커밋·amend.
//
// · 가둠(D13·K11): 루트는 열린 worktree(`roots()` 포함 + `confine` realpath), 경로는 `isPlainRel`·길이(`parseScmWriteInput`), 모르는 동작은 git 없이 거절.
//   argv 는 동작마다 고정 문자열 + `--literal-pathspecs`(F6 — `:` 로 시작하는 이름이 pathspec 매직으로 읽히지 않게). 경로는 argv 가 아니라
//   `--pathspec-from-file=- --pathspec-file-nul` 의 stdin(NUL 끝)으로만 넘긴다 — 렌더러가 git 인자를 고를 수 없고, 목록이 길어도 argv 상한에 안 걸린다.
// · 영구 삭제 0(D2): 이 파일에 `unlink`·`rm`·`git clean` 이 없다. 작업 트리에만 내용이 있는 파일(추적 안 함·추가 예정 `add -N`)의 discard 는
//   `deps.trashItem`(main `shell.trashItem`)뿐, 실패하면 실제 결과를 안내로 끝. 휴지통 대상은 main 이 git 으로 다시 분류한다(B2 — 렌더러 분류를 믿지 않는다).
//   (`git rm --cached` 는 인덱스에서만 뺀다 — 작업 트리 파일은 그대로.)
// · index.lock(D11·F2): git 이 낸 lock 문구일 때만 VS Code 값(`repository.ts:3026-3046` — 50·n² ms, 10회)으로 다시 돈다. **lock 파일을 지우지 않는다.**
//   재시도는 `scm.write.retry` 로 따로 센다(K8ⓓ). 앱 자신의 쓰기는 루트마다 직렬(`scm.write.wait` — K9).
// · 로그인 셸 PATH(D12·F1, r3 D1 로 넓힘): **쓰기 git 자식 전부**(stage·unstage·discard 의 checkout·`rm --cached`·스마트 커밋 add·commit)에 쓴다 —
//   훅(gitleaks·post-checkout)·clean/smudge 필터(git-lfs 류)가 셸 도구를 찾게. 읽기 git(분류·HEAD·변경 조회)은 앱 PATH 그대로. 못 얻으면 앱 PATH 로 돌리고 오류는 원문.
//   첫 쓰기가 기다리지 않게 앱 시작 뒤 미리 조회하고(`prefetchLoginPath`), 진행 중 조회는 함께 기다린다.
// · 대기 중 대상 바뀜(K12): 확인 대화상자가 닫힌 뒤·재시도 대기 뒤마다 요청 루트가 아직 열린 worktree 인지 다시 본다 — 아니면 git 없이 거절.
// · 로그(제약 7): 동작·결과 코드·걸린 시간·재시도 수·루트 해시만 — 경로·메시지·stderr 원문은 남기지 않는다.
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { confine } from './explorer-fs.js'
import { parseScmWriteInput, type ScmWriteAction, type ScmWriteInput, type ScmWriteRefusal, type ScmWriteResult } from '../shared/scm-write.js'

// --- 고정 argv (시험이 고정한다 — K11) --------------------------------------------------------------

const LITERAL = '--literal-pathspecs'
const FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul']
export const SCM_STAGE_ARGS = [LITERAL, 'add', '-A', ...FROM_STDIN]
export const SCM_UNSTAGE_ARGS = [LITERAL, 'reset', '-q', 'HEAD', ...FROM_STDIN]
/** 인덱스에서만 뺀다(`--cached` — 작업 트리 파일은 그대로). 쓰는 곳: HEAD 없는(첫 커밋 전) 레포의 unstage — HEAD 를 풀 수 없어 `reset HEAD` 로는
 * 「추가」 를 되돌릴 기준이 없다(VS Code `git.ts:2410-2421` 과 같은 갈래) · 휴지통으로 옮긴 추가 예정(`add -N`) 파일의 인덱스 항목 빼기(B1). */
export const SCM_UNSTAGE_UNBORN_ARGS = [LITERAL, 'rm', '--cached', '-r', '-q', '-f', ...FROM_STDIN]
export const SCM_DISCARD_ARGS = [LITERAL, 'checkout', '-q', ...FROM_STDIN]
/** 스마트 커밋(D5) — 추적 안 함 포함 전부. */
export const SCM_STAGE_ALL_ARGS = [LITERAL, 'add', '-A', '--', '.']
export const scmCommitArgs = (input: { amend: boolean; keepMessage: boolean }): string[] => [
  LITERAL,
  '-c',
  'user.useConfigOnly=true',
  'commit',
  '--quiet',
  ...(input.amend ? ['--amend'] : []),
  ...(input.keepMessage ? ['--no-edit'] : ['-F', '-']),
]
/** 읽기(lock 안 잡음) — HEAD 있나(exit 0 있음 · 1 없음 · 그 밖은 오류 — B4) · 스테이지된 것 있나 · 변경 있나 · 휴지통 대상 분류. */
export const SCM_HEAD_ARGS = ['--no-optional-locks', 'rev-parse', '--verify', '-q', 'HEAD']
export const SCM_STAGED_ARGS = ['--no-optional-locks', 'diff', '--cached', '--quiet']
/** 비었는지만 본다 — 추적 안 함은 폴더 단위로 접어 출력이 작게(`normal`, C4). */
export const SCM_ANY_CHANGE_ARGS = ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=normal']
/** discard 대상 분류(B2·C2) — `? 경로`(추적 안 함, 무시 제외) · `1 .A`(추가 예정) · `1 ·M/·D/·T`(작업 트리 쪽 추적 변경). `status` 는 `--pathspec-from-file` 을 받지 않는다 — `--` 뒤 경로(리터럴)로,
 * `CLASSIFY_CHUNK` 개씩 나눠 argv 상한을 넘지 않게. 폴더 경로는 그 아래 파일로 나와 정확히 같은 줄이 없으니 거절된다. */
export const SCM_CLASSIFY_ARGS = ['--no-optional-locks', LITERAL, 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames', '--']
const CLASSIFY_CHUNK = 500

/** VS Code `repository.ts:3026-3046` — n 번째 재시도 전 50·n² ms, 10회(합계 19.25 초 — K8ⓑ 통과선 25 초 안). */
export const LOCK_RETRY_DELAYS_MS: readonly number[] = Array.from({ length: 10 }, (_, index) => 50 * (index + 1) ** 2)
/** 한 동작(여러 git 호출 — 스마트 커밋·추가 예정 discard)의 재시도 대기 합계 상한(D3 — K8ⓑ 「그 동작이 … ≤ 25 초」). 넘을 대기는 하지 않고 원문 오류. */
export const LOCK_RETRY_BUDGET_MS = 25_000
/** git 이 낸 lock 문구(F2). git 자신의 실패(exit 128)이면서 이 문구일 때만 다시 돈다 — 훅이 같은 문구를 내고 exit 1 이면 다시 돌지 않는다(B6). */
export const isLockError = (stderr: string): boolean => /Another git process seems to be running|index\.lock': File exists/.test(stderr)
const GIT_FATAL = 128

const GIT_TIMEOUT_MS = 60_000
/** 로그인 셸 조회 실패 뒤 다시 묻기까지(E3 — 음성 캐시). */
export const LOGIN_PATH_RETRY_MS = 60_000
/** 커밋은 훅이 돈다 — 더 길게. */
const COMMIT_TIMEOUT_MS = 180_000
const OUTPUT_LIMIT = 4 * 1024 * 1024
const ERROR_LIMIT = 16 * 1024

// --- 확인 대화상자 (문구는 main — VS Code V5~V9 의 한국어 결) ------------------------------------------

export type ScmConfirm =
  | { kind: 'stageMerge'; files: string[] }
  /** `restore` — 추적 파일이 전부 작업 트리에서 지워진 것(되돌리면 복원 — V5 「restore」 갈래). */
  | { kind: 'discard'; tracked: string[]; untracked: string[]; restore: boolean }
  | { kind: 'smartCommit' }
export type ScmConfirmChoice = 'stage' | 'discardTracked' | 'discardAll' | 'commit' | 'cancel'
export type ScmConfirmSpec = {
  kind: ScmConfirm['kind']
  options: { type: 'warning'; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }
  /** `buttons` 와 같은 자리 — 고른 단추 번호 → 답. */
  choices: ScmConfirmChoice[]
}

const nameOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)
const listOf = (files: readonly string[]): string => (files.length <= 10 ? files : [...files.slice(0, 10), `외 ${files.length - 10}개`]).join('\n')
const IRREVERSIBLE = '이 작업은 되돌릴 수 없습니다.'
const FROM_TRASH = '휴지통에서 복원할 수 있습니다.'

export function scmConfirmSpec(confirm: ScmConfirm): ScmConfirmSpec {
  switch (confirm.kind) {
    case 'stageMerge': {
      const single = confirm.files.length === 1 ? confirm.files[0] : undefined
      return {
        kind: 'stageMerge',
        options: {
          type: 'warning',
          message: single === undefined ? `병합 충돌이 있는 ${confirm.files.length}개 파일을 스테이지할까요?` : `'${nameOf(single)}'을(를) 병합 충돌과 함께 스테이지할까요?`,
          detail: `${single === undefined ? `${listOf(confirm.files)}\n\n` : ''}충돌 표지가 남아 있지 않은지 확인하세요.`,
          buttons: ['스테이지', '취소'],
          defaultId: 0,
          cancelId: 1,
        },
        choices: ['stage', 'cancel'],
      }
    }
    case 'smartCommit':
      return {
        kind: 'smartCommit',
        options: {
          type: 'warning',
          message: '스테이지된 변경이 없습니다. 모든 변경을 스테이지하고 바로 커밋할까요?',
          detail: '추적하지 않는 파일도 함께 커밋됩니다.',
          buttons: ['예', '취소'],
          defaultId: 0,
          cancelId: 1,
        },
        choices: ['commit', 'cancel'],
      }
    case 'discard': {
      const { tracked, untracked } = confirm
      const total = tracked.length + untracked.length
      // V6 — 추적 안 함만.
      if (tracked.length === 0) {
        const single = untracked.length === 1 ? untracked[0] : undefined
        return {
          kind: 'discard',
          options: {
            type: 'warning',
            message: single === undefined ? `추적하지 않는 파일 ${untracked.length}개를 삭제할까요?` : `추적하지 않는 파일 '${nameOf(single)}'을(를) 삭제할까요?`,
            detail: single === undefined ? `${listOf(untracked)}\n\n${FROM_TRASH}` : FROM_TRASH,
            buttons: [single === undefined ? `${untracked.length}개 파일을 휴지통으로 이동` : '휴지통으로 이동', '취소'],
            defaultId: 0,
            cancelId: 1,
          },
          choices: ['discardAll', 'cancel'],
        }
      }
      // V7 — 섞임: [추적 파일만] · [모두] · 취소.
      if (untracked.length > 0)
        return {
          kind: 'discard',
          options: {
            type: 'warning',
            message: `${total}개 파일의 변경 내용을 버릴까요?`,
            detail: `추적 파일 ${tracked.length}개는 인덱스 내용으로 돌아갑니다(${IRREVERSIBLE.slice(0, -1)}).\n추적하지 않는 파일 ${untracked.length}개는 휴지통으로 이동합니다(${FROM_TRASH.slice(0, -1)}).`,
            buttons: [tracked.length === 1 ? '추적 파일 1개 버리기' : `추적 파일 ${tracked.length}개 모두 버리기`, `${total}개 파일 모두 버리기`, '취소'],
            defaultId: 0,
            cancelId: 2,
          },
          choices: ['discardTracked', 'discardAll', 'cancel'],
        }
      // V5 — 추적 파일만(전부 삭제됨이면 「복원」).
      const single = tracked.length === 1 ? tracked[0] : undefined
      const message = confirm.restore
        ? single === undefined
          ? `${tracked.length}개 파일을 복원할까요?`
          : `'${nameOf(single)}'을(를) 복원할까요?`
        : single === undefined
          ? `${tracked.length}개 파일의 변경 내용을 모두 버릴까요?`
          : `'${nameOf(single)}'의 변경 내용을 버릴까요?`
      return {
        kind: 'discard',
        options: {
          type: 'warning',
          message,
          detail: single === undefined ? `${listOf(tracked)}\n\n${IRREVERSIBLE}` : IRREVERSIBLE,
          buttons: [confirm.restore ? (single === undefined ? `${tracked.length}개 파일 복원` : '파일 복원') : single === undefined ? `${tracked.length}개 파일 모두 버리기` : '파일 변경 버리기', '취소'],
          defaultId: 0,
          cancelId: 1,
        },
        choices: ['discardTracked', 'cancel'],
      }
    }
  }
}

// --- 실행기 ------------------------------------------------------------------------------------------

export type GitRun = { exitCode: number; stdout: string; stderr: string }

export type ScmWriteDeps = {
  /** 지금 열린 worktree 루트들. */
  roots: () => readonly string[]
  /** git 절대 경로(`resolveGit`). */
  git: (roots: readonly string[]) => string
  confirm: (spec: ScmConfirmSpec) => Promise<ScmConfirmChoice>
  /** main `shell.trashItem` — 실패면 reject. */
  trashItem: (abs: string) => Promise<void>
  /** 로그인 셸 PATH — 못 얻으면 null. */
  loginPath: () => Promise<string | null>
  /** 쓰기 뒤 즉시 재조회(D14 — 탐색기 허브 `refreshGit`). */
  refresh: (root: string) => void
  log: (event: string, data?: Record<string, unknown>) => void
  /** 시험 주입 — 기본은 VS Code 값·25 초 예산·진짜 시계(`now` 는 로그인 셸 음성 캐시용). */
  now?: () => number
  retryDelays?: readonly number[]
  retryBudgetMs?: number
  sleep?: (ms: number) => Promise<void>
  env?: NodeJS.ProcessEnv
}

/** 로그용 루트 표지 — 경로 대신 해시(K16 대조용). */
export const rootTag = (root: string): string => crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)

const refused = (code: ScmWriteRefusal, error: string): ScmWriteResult => ({ ok: false, code, error })

function runGit(input: { git: string; cwd: string; args: readonly string[]; stdin: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<GitRun> {
  return new Promise((resolve) => {
    const child = execFile(input.git, ['-C', input.cwd, ...input.args], { encoding: 'utf8', timeout: input.timeoutMs, maxBuffer: OUTPUT_LIMIT, env: input.env }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr })
        return
      }
      const code = typeof error.code === 'number' ? error.code : -1
      const extra = code === -1 ? `\n${error.message}` : ''
      resolve({ exitCode: code, stdout, stderr: `${stderr}${extra}` })
    })
    child.stdin?.on('error', () => {
      // git 이 stdin 을 다 읽기 전에 끝나면 EPIPE — 결과는 위 콜백이 낸다.
    })
    child.stdin?.end(input.stdin)
  })
}

const errorText = (run: GitRun): string => {
  const text = (run.stderr.trim() !== '' ? run.stderr : run.stdout).trim()
  return (text === '' ? `git 이 코드 ${run.exitCode} 로 끝났습니다.` : text).slice(0, ERROR_LIMIT)
}

const nul = (list: readonly string[]): string => list.map((item) => `${item}\0`).join('')

export class ScmWriter {
  private readonly queues = new Map<string, Promise<unknown>>()
  private loginPathCache: string | null = null
  private loginPathPending: Promise<string | null> | null = null
  /** 마지막 조회 실패 시각 — `LOGIN_PATH_RETRY_MS` 동안은 다시 묻지 않고 앱 PATH 로 돈다(E3 — 셸이 늘 멈추면 쓰기마다 5 초씩 기다리지 않게). */
  private loginPathFailedAt: number | null = null

  constructor(private readonly deps: ScmWriteDeps) {}

  /** IPC 입구 — 형 검사 → 확인 → 루트 직렬 실행 → 재조회. 늘 결과로 답한다(throw 없음). */
  async write(raw: unknown): Promise<ScmWriteResult> {
    const startedAt = performance.now()
    const input = parseScmWriteInput(raw)
    if (input === null) {
      this.deps.log('scm.write', { action: null, ok: false, code: 'bad_request', ms: 0, retries: 0 })
      return refused('bad_request', '요청 형 위반')
    }
    const stats: Stats = { retries: 0, waitedMs: 0, waited: false }
    let result: ScmWriteResult
    try {
      result = await this.handle(input, stats)
    } catch (error) {
      result = refused('git_error', String(error).slice(0, ERROR_LIMIT))
    }
    this.deps.log('scm.write', {
      action: input.action,
      root: rootTag(input.root),
      ok: result.ok,
      code: result.ok ? null : result.code,
      ms: Math.round((performance.now() - startedAt) * 10) / 10,
      retries: stats.retries,
      waited: stats.waited,
    })
    return result
  }

  private isOpen(root: string): boolean {
    return this.deps.roots().includes(root)
  }

  private async handle(input: ScmWriteInput, stats: Stats): Promise<ScmWriteResult> {
    if (!this.isOpen(input.root)) return refused('not_worktree', '열린 worktree 루트가 아니다')
    // 확인 대화상자(D4·D3) — 루트 직렬 큐 밖에서 묻는다(대화상자가 다른 쓰기를 막지 않게). 커밋의 스마트 확인은 스테이지 상태를 봐야 해서 큐 안.
    let discardUntracked = false
    if (input.action === 'stageMerge' || input.action === 'discard') {
      const confined = await confine({ roots: this.deps.roots(), root: input.root, rel: '' })
      if (!confined.ok) return refused('not_worktree', confined.error)
      const confirm: ScmConfirm =
        input.action === 'stageMerge'
          ? { kind: 'stageMerge', files: input.paths }
          : { kind: 'discard', tracked: input.tracked, untracked: input.untracked, restore: input.tracked.length > 0 && (await allMissing(confined.realRoot, input.tracked)) }
      const spec = scmConfirmSpec(confirm)
      const choice = await this.deps.confirm(spec)
      this.deps.log('scm.dialog', { kind: spec.kind, choice })
      if (choice === 'cancel' || !spec.choices.includes(choice)) return refused('cancelled', '취소됨')
      discardUntracked = choice === 'discardAll'
    }
    if (input.action === 'commit' && input.message.trim() === '' && !input.amend) return refused('empty_message', '빈 메시지')
    const result = await this.serial(input.root, stats, () => this.execute({ input, discardUntracked, stats }))
    // 무변화 거절은 재조회할 것이 없다 — 다만 `stale` 은 목록이 낡았다는 뜻이라 다시 읽는다(C3).
    if (result.ok || result.code === 'git_error' || result.code === 'trash_failed' || result.code === 'stale') this.deps.refresh(input.root)
    return result
  }

  /** 루트마다 직렬 — 앞 쓰기가 끝나야 다음이 시작한다(K9). 다른 루트는 서로 막지 않는다. */
  private async serial<T>(root: string, stats: { waited: boolean }, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(root)
    if (previous !== undefined) {
      stats.waited = true
      this.deps.log('scm.write.wait', { root: rootTag(root) })
    }
    const next = (previous ?? Promise.resolve()).then(task, task)
    const settled = next.catch(() => undefined)
    this.queues.set(root, settled)
    try {
      return await next
    } finally {
      if (this.queues.get(root) === settled) this.queues.delete(root)
    }
  }

  private async execute(context: { input: ScmWriteInput; discardUntracked: boolean; stats: Stats }): Promise<ScmWriteResult> {
    const { input, stats } = context
    // K12 — 대화상자·앞 쓰기 대기 뒤에도 그 루트가 아직 열려 있어야 쓴다.
    const confined = await confine({ roots: this.deps.roots(), root: input.root, rel: '' })
    if (!confined.ok) return refused('not_worktree', confined.error)
    const cwd = confined.realRoot
    const git = this.deps.git(this.deps.roots())
    const env: NodeJS.ProcessEnv = { ...(this.deps.env ?? process.env), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' }
    const read = (args: readonly string[], stdin = ''): Promise<GitRun> => runGit({ git, cwd, args, stdin, env, timeoutMs: GIT_TIMEOUT_MS })
    // 쓰기 git 만 로그인 셸 PATH(D1) — 첫 쓰기 직전에 한 번 푼다(거절·읽기만으로 끝나는 동작은 묻지 않는다).
    let writeEnv: Promise<NodeJS.ProcessEnv> | null = null
    const write = async (args: readonly string[], stdin: string, options: { timeoutMs?: number } = {}): Promise<ScmWriteResult> => {
      writeEnv ??= this.resolveLoginPath().then((pathEnv) => (pathEnv === null ? env : { ...env, PATH: pathEnv }))
      const childEnv = await writeEnv
      return this.withLockRetry({ root: input.root, action: input.action, stats, run: () => runGit({ git, cwd, args, stdin, env: childEnv, timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS }) })
    }

    switch (input.action) {
      case 'stage':
      case 'stageMerge':
        return write(SCM_STAGE_ARGS, nul(input.paths))
      case 'unstage': {
        // exit 1 만 「HEAD 없음」 — 그 밖의 실패(128·시간 초과 -1)를 HEAD 없음으로 보면 `rm --cached` 가 스테이지된 삭제를 만든다(B4).
        const head = await read(SCM_HEAD_ARGS)
        if (head.exitCode !== 0 && head.exitCode !== 1) return refused('git_error', errorText(head))
        return write(head.exitCode === 0 ? SCM_UNSTAGE_ARGS : SCM_UNSTAGE_UNBORN_ARGS, nul(input.paths))
      }
      case 'discard': {
        const trashing = context.discardUntracked && input.untracked.length > 0
        // 되돌릴 것·휴지통 대상을 git·휴지통 쓰기 전에 전부 분류한다 — 하나라도 어긋나면 아무것도 하지 않는다(B2·C2).
        const classified = await this.classifyDiscard({ read, tracked: input.tracked, trash: trashing ? input.untracked : [] })
        if (!classified.ok) return classified.result
        const intent = classified.intent
        if (input.tracked.length > 0) {
          const restored = await write(SCM_DISCARD_ARGS, nul(input.tracked))
          if (!restored.ok && restored.code === 'git_error') return refused('git_error', await this.restoreReport({ read, tracked: input.tracked, error: restored.error, untracked: trashing ? input.untracked.length : 0 }))
          if (!restored.ok) return restored
        }
        if (!trashing) return { ok: true }
        const trashed = await this.trash(input.root, input.untracked)
        // 추가 예정 파일은 휴지통으로 옮긴 것만 인덱스 항목을 뺀다 — 못 옮긴 파일은 그대로 추가 예정으로 남는다(B1).
        const dropping = trashed.moved.filter((rel) => intent.has(rel))
        const dropped: ScmWriteResult = dropping.length === 0 ? { ok: true } : await write(SCM_UNSTAGE_UNBORN_ARGS, nul(dropping))
        if (trashed.failed.length === 0 && dropped.ok) return { ok: true }
        // 부분 실패(B3) — 실제로 일어난 것을 말한다: 휴지통으로 옮긴 것 · 못 옮겨 남은 것(이유) · 이미 되돌린 추적 파일.
        const report = [
          trashed.moved.length > 0 ? `휴지통으로 옮김 ${trashed.moved.length}개:\n${listOf(trashed.moved)}` : '휴지통으로 옮긴 파일 없음.',
          ...(trashed.failed.length > 0 ? [`옮기지 못해 그대로 남음 ${trashed.failed.length}개:\n${listOf(trashed.failed)}`] : []),
          ...(dropped.ok ? [] : [`휴지통으로 옮긴 추가 예정 파일 ${dropping.length}개의 인덱스 항목을 빼지 못함:\n${dropped.error}`]),
          ...(input.tracked.length > 0 ? [`인덱스 내용으로 되돌린 추적 파일 ${input.tracked.length}개:\n${listOf(input.tracked)}`] : []),
        ].join('\n\n')
        return refused(trashed.failed.length > 0 ? 'trash_failed' : 'git_error', report.slice(0, ERROR_LIMIT))
      }
      case 'commit': {
        if (!input.amend) {
          const staged = await read(SCM_STAGED_ARGS)
          if (staged.exitCode !== 0 && staged.exitCode !== 1) return refused('git_error', errorText(staged))
          if (staged.exitCode === 0) {
            // 스테이지 없음(D5·D6) — 변경도 없으면 안내로 끝, 있으면 확인 뒤 전부 스테이지.
            const any = await read(SCM_ANY_CHANGE_ARGS)
            if (any.exitCode !== 0) return refused('git_error', errorText(any))
            if (any.stdout.length === 0) return refused('nothing_to_commit', '변경 없음')
            const spec = scmConfirmSpec({ kind: 'smartCommit' })
            const choice = await this.deps.confirm(spec)
            this.deps.log('scm.dialog', { kind: spec.kind, choice })
            if (choice !== 'commit') return refused('cancelled', '취소됨')
            if (!this.isOpen(input.root)) return refused('not_worktree', '열린 worktree 루트가 아니다')
            const added = await write(SCM_STAGE_ALL_ARGS, '')
            if (!added.ok) return added
          }
        }
        const keepMessage = input.amend && input.message.trim() === ''
        return write(scmCommitArgs({ amend: input.amend, keepMessage }), keepMessage ? '' : input.message, { timeoutMs: COMMIT_TIMEOUT_MS })
      }
    }
  }

  /** git 한 번 + lock 문구면 유한 재시도(K8). 대기 합계는 동작 단위 예산 안에서만(D3 — `stats.waitedMs` 는 그 동작의 모든 git 호출이 함께 쓴다).
   * 재시도 대기 뒤에도 루트가 열려 있어야 다시 돈다(K12). lock 파일은 건드리지 않는다. */
  private async withLockRetry(input: { root: string; action: ScmWriteAction; stats: Stats; run: () => Promise<GitRun> }): Promise<ScmWriteResult> {
    const delays = this.deps.retryDelays ?? LOCK_RETRY_DELAYS_MS
    const budget = this.deps.retryBudgetMs ?? LOCK_RETRY_BUDGET_MS
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let attempt = 0; ; attempt += 1) {
      const run = await input.run()
      if (run.exitCode === 0) return { ok: true }
      const delay = delays[attempt]
      if (run.exitCode !== GIT_FATAL || !isLockError(run.stderr) || delay === undefined || input.stats.waitedMs + delay > budget) return refused('git_error', errorText(run))
      input.stats.retries += 1
      input.stats.waitedMs += delay
      this.deps.log('scm.write.retry', { action: input.action, root: rootTag(input.root), attempt: attempt + 1, delayMs: delay })
      await sleep(delay)
      if (!this.isOpen(input.root)) return refused('not_worktree', '재시도 대기 중 worktree 가 닫혔다')
    }
  }

  /** discard 대상 분류(B2·C2) — 렌더러 분류를 믿지 않는다. `.git` 성분은 git 없이 `bad_request`, 나머지는 git 이 지금 보는 상태와 **정확히 같은 줄**이 있어야 한다:
   * · 되돌릴 것(`tracked`) = 작업 트리 쪽 추적 변경(`1 ·M`·`·D`·`·T`) — 추적 안 함·추가 예정(`·A`, 이름 바꾸기 예정의 새 경로도 `--no-renames` 로 이렇게 보인다)은
   *   `checkout` 이 인덱스의 빈 내용으로 덮으니 아니다. 이름 바꾸기 예정의 원래 경로는 `·D` 라 허용(복원).
   * · 휴지통(`trash`) = 추적 안 함(`?`, 무시 제외) · 추가 예정(`1 .A`). 추적 파일·무시된 파일·폴더·없는 경로는 아니다.
   * 어긋나면 목록이 낡았다는 뜻 — `stale`(C3). 답의 `intent` = 휴지통 대상 중 추가 예정(휴지통 뒤 인덱스 항목을 뺄 것). */
  private async classifyDiscard(input: {
    read: (args: readonly string[]) => Promise<GitRun>
    tracked: readonly string[]
    trash: readonly string[]
  }): Promise<{ ok: true; intent: Set<string> } | { ok: false; result: ScmWriteResult }> {
    const rels = [...new Set([...input.tracked, ...input.trash])]
    if (rels.length === 0) return { ok: true, intent: new Set() }
    if (rels.some((rel) => rel.split('/').some((part) => part.toLowerCase() === '.git'))) return { ok: false, result: refused('bad_request', 'discard 대상에 .git 경로가 있다') }
    const scanned = await scanDiscard({ read: input.read, rels })
    if (!scanned.ok) return { ok: false, result: refused('git_error', scanned.error) }
    const { untracked, intent, changed } = scanned
    if (!input.tracked.every((rel) => changed.has(rel)) || !input.trash.every((rel) => untracked.has(rel) || intent.has(rel)))
      return { ok: false, result: refused('stale', '보낸 목록과 git 이 지금 보는 상태가 다르다') }
    return { ok: true, intent }
  }

  /** 되돌리기(checkout)가 비0 으로 끝났을 때(D1 — post-checkout 훅·smudge 필터 실패) 끝 상태를 다시 읽어 실제 결과를 말한다. git 은 파일을 되돌리고도
   * 훅 때문에 비0 일 수 있고, 필터 실패면 파일이 지워진 채 남을 수 있다 — 아직 작업 트리 쪽 변경으로 보이면 「되돌리지 못함」. 휴지통 단계는 하지 않는다. */
  private async restoreReport(input: { read: (args: readonly string[]) => Promise<GitRun>; tracked: readonly string[]; error: string; untracked: number }): Promise<string> {
    const scanned = await scanDiscard({ read: input.read, rels: input.tracked })
    const restored = scanned.ok ? input.tracked.filter((rel) => !scanned.changed.has(rel)) : []
    const left = scanned.ok ? input.tracked.filter((rel) => scanned.changed.has(rel)) : []
    return [
      `되돌리는 중 git 이 오류로 끝났습니다:\n${input.error}`,
      ...(scanned.ok
        ? [
            restored.length > 0 ? `인덱스 내용으로 되돌린 추적 파일 ${restored.length}개:\n${listOf(restored)}` : '인덱스 내용으로 되돌린 추적 파일 없음.',
            ...(left.length > 0 ? [`되돌리지 못한 추적 파일 ${left.length}개:\n${listOf(left)}`] : []),
          ]
        : [`끝 상태를 다시 읽지 못했습니다:\n${scanned.error}`]),
      ...(input.untracked > 0 ? [`추적하지 않는 파일 ${input.untracked}개는 휴지통으로 옮기지 않았습니다(그대로 있음).`] : []),
    ]
      .join('\n\n')
      .slice(0, ERROR_LIMIT)
  }

  /** 휴지통으로(D2). 경로의 부모만 realpath 로 가두고 그 이름 자체(링크면 링크)를 보낸다 — 링크가 가리키는 대상을 버리지 않는다. 하나가 실패해도 나머지는 계속한다. */
  private async trash(root: string, rels: readonly string[]): Promise<{ moved: string[]; failed: string[] }> {
    const moved: string[] = []
    const failed: string[] = []
    for (const rel of rels) {
      const slash = rel.lastIndexOf('/')
      const parent = await confine({ roots: this.deps.roots(), root, rel: slash < 0 ? '' : rel.slice(0, slash) })
      if (!parent.ok) {
        failed.push(`${rel}: ${parent.error}`)
        continue
      }
      const target = path.join(parent.abs, rel.slice(slash + 1))
      try {
        await fs.lstat(target)
        await this.deps.trashItem(target)
        moved.push(rel)
      } catch (error) {
        failed.push(`${rel}: ${String(error).slice(0, 300)}`)
      }
    }
    this.deps.log('scm.write.trash', { root: rootTag(root), files: rels.length, failed: failed.length })
    return { moved, failed }
  }

  /** 앱 시작 뒤 백그라운드로 미리 푼다(D1 — 첫 쓰기가 조회를 기다리지 않게). 결과는 아래 캐시·진행 중 공유로 쓰기와 나눈다. */
  prefetchLoginPath(): Promise<string | null> {
    return this.resolveLoginPath()
  }

  /** 로그인 셸 PATH — 성공한 값은 앱이 도는 동안 둔다(VS Code 도 시작 때 한 번 푼다). 실패는 두지 않는다(다음 쓰기에 다시 묻는다).
   * 진행 중 조회는 함께 기다린다(R3-5 — 동시 쓰기·미리 조회가 셸을 둘 띄우지 않게). 실패 뒤 `LOGIN_PATH_RETRY_MS` 동안은 묻지 않고 null(E3). */
  private resolveLoginPath(): Promise<string | null> {
    if (this.loginPathCache !== null) return Promise.resolve(this.loginPathCache)
    if (this.loginPathPending !== null) return this.loginPathPending
    const now = this.deps.now ?? Date.now
    if (this.loginPathFailedAt !== null && now() - this.loginPathFailedAt < LOGIN_PATH_RETRY_MS) return Promise.resolve(null)
    const startedAt = performance.now()
    const pending = this.deps
      .loginPath()
      .catch(() => null)
      .then((value) => {
        this.deps.log('scm.write.login_path', { ok: value !== null, ms: Math.round(performance.now() - startedAt) })
        if (value !== null) this.loginPathCache = value
        this.loginPathFailedAt = value === null ? now() : null
        this.loginPathPending = null
        return value
      })
    this.loginPathPending = pending
    return pending
  }
}

type Stats = { retries: number; waitedMs: number; waited: boolean }

/** discard 분류용 상태 읽기 — `? 경로`(추적 안 함, 무시 제외) · `1 .A`(추가 예정) · `1 ·M/·D/·T`(작업 트리 쪽 추적 변경). `CLASSIFY_CHUNK` 개씩. */
async function scanDiscard(input: {
  read: (args: readonly string[]) => Promise<GitRun>
  rels: readonly string[]
}): Promise<{ ok: true; untracked: Set<string>; intent: Set<string>; changed: Set<string> } | { ok: false; error: string }> {
  const untracked = new Set<string>()
  const intent = new Set<string>()
  const changed = new Set<string>()
  for (let start = 0; start < input.rels.length; start += CLASSIFY_CHUNK) {
    const run = await input.read([...SCM_CLASSIFY_ARGS, ...input.rels.slice(start, start + CLASSIFY_CHUNK)])
    if (run.exitCode !== 0) return { ok: false, error: errorText(run) }
    const records = run.stdout.split('\0')
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] ?? ''
      if (record.startsWith('? ')) untracked.add(record.slice(2))
      else if (record.startsWith('1 ')) {
        const fields = record.split(' ')
        const rel = fields.slice(8).join(' ')
        const worktree = fields[1]?.[1]
        if (fields[1] === '.A') intent.add(rel)
        else if (worktree === 'M' || worktree === 'D' || worktree === 'T') changed.add(rel)
      } else if (record.startsWith('2 ')) index += 1 // `--no-renames` 라 오지 않지만, 오면 원래 경로 칸을 건너뛴다.
    }
  }
  return { ok: true, untracked, intent, changed }
}

async function allMissing(realRoot: string, rels: readonly string[]): Promise<boolean> {
  for (const rel of rels) {
    try {
      await fs.lstat(path.join(realRoot, rel))
      return false
    } catch {
      // 없음.
    }
  }
  return true
}

const PATH_MARK = '__CORRAL_LOGIN_PATH__'
const LOGIN_OUTPUT_LIMIT = 1024 * 1024

/** `$SHELL -ilc` 로 로그인 셸의 PATH 를 얻는다(선례 `mobile/tailscale.ts` `loginShellTailscale` — 5초 상한). 셸 출력 전체는 남기지 않는다.
 * 상한은 직접 타이머로 확정한다(C1) — 대화형 셸은 SIGTERM 을 무시하고 rc 가 멈출 수 있어 자식 종료를 기다리지 않는다. 셸은 별도 프로세스 그룹
 * (`detached`)으로 띄워 상한·출력 초과에 그룹 전체를 SIGKILL 하고, stdin 은 처음부터 닫는다(`ignore` — rc 의 `read` 는 바로 EOF).
 * 값은 표지 두 개가 stdout 에 보이는 즉시 확정하고 그 그룹도 SIGKILL 한다(E2 — rc 가 띄운 자손이 stdout 을 쥐고 남아 있어도 기다리지도 남기지도 않는다).
 * (rc 가 `setsid` 로 그룹을 벗어나 띄운 데몬은 그룹 밖이라 닿지 않는다.) */
export function loginShellPath(input: { shell?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string | null> {
  const shell = input.shell ?? (process.env.SHELL !== undefined && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh')
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    const child = spawn(shell, ['-ilc', `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: input.env ?? process.env })
    const killGroup = (): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // 그룹이 이미 없다.
      }
    }
    const finish = (value: string | null, options: { kill: boolean }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (options.kill) killGroup()
      child.stdout?.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null, { kill: true }), input.timeoutMs ?? 5_000)
    child.on('error', () => finish(null, { kill: false }))
    // stdout 이 닫히면(셸과 자손이 다 놓으면) 받은 것으로 판정 — 'exit' 는 남은 출력보다 먼저 올 수 있다.
    child.on('close', () => finish(parseLoginPath(stdout), { kill: false }))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > LOGIN_OUTPUT_LIMIT) finish(null, { kill: true })
      // 값을 받았으면 셸 그룹은 더 쓸 일이 없다 — rc 가 남긴 자손(`sleep` 등)까지 바로 죽인다(E2).
      else if (parseLoginPath(stdout) !== null) finish(parseLoginPath(stdout), { kill: true })
    })
  })
}

function parseLoginPath(stdout: string): string | null {
  const start = stdout.indexOf(PATH_MARK)
  const end = start < 0 ? -1 : stdout.indexOf(PATH_MARK, start + PATH_MARK.length)
  const value = end < 0 ? '' : stdout.slice(start + PATH_MARK.length, end).trim()
  return value.startsWith('/') ? value : null
}
