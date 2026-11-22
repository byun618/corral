// 소스 제어 원격 (LIFE-831) — 가져오기·끌어오기·밀어넣기·브랜치 게시. K1 쓰기 모듈(`ScmWriter`) 위에 얹는다.
//
// · 직렬(D8·K8): git 실행은 `ScmWriter.enqueue` — K1 쓰기와 **같은 루트 직렬 큐**. 같은 루트의 원격 동작은 한 번에 하나(진행 중이면 `busy` — git 0, K4ⓑ).
// · argv 고정(제약 3·K9): fetch `fetch` · pull `pull <원격> refs/heads/<upstream 브랜치>` · push `push <원격> refs/heads/<브랜치>:refs/heads/<upstream 브랜치>` ·
//   게시 `push -u <원격> refs/heads/<브랜치>`(브랜치 이름을 전체 ref 로 — 같은 이름 태그와 헷갈리지 않게, 수정 r1 C2).
//   그 밖 플래그 없음 — 사용자 `pull.*`·`fetch.*`·`core.sshCommand`·`credential.helper`·`http.*` 를 git 이 그대로 적용한다(`-c`·env 로 덮지 않는다).
//   원격·브랜치 이름은 큐 차례에 git 에서 다시 읽은 값만(렌더러는 동작 이름만 보낸다). 게시 원격은 main 이 띄운 고르기에서 `git remote` 목록 중 하나.
// · env(제약 4·K6): 원격 git 자식에만 로그인 셸 PATH(`ScmWriter.loginPath` — K1 과 같은 캐시) · `GIT_TERMINAL_PROMPT=0` · `GIT_MERGE_AUTOEDIT=no` · 로케일.
//   **새 세션(`detached` = setsid)으로 띄우고 stdio 를 부모와 끊는다**(stdin `ignore`, stdout·stderr `pipe`) — 제어 터미널이 없으니 ssh 가 `/dev/tty` 로 묻지 못한다.
//   GUI 자격 입력(askpass)은 없다 — 인증이 필요하면 빨리 실패하고 안내(D6).
// · 취소·상한(제약 5·K4): 띄울 때 받은 PID 의 **프로세스 그룹**에 SIGTERM → 유예 뒤 남으면 SIGKILL. lock 파일은 지우지 않는다. 상한 기본 10 분(주입 가능).
// · 끝나면(성공·실패·취소·상한 — git 을 띄운 경우만) 탐색기·소스 제어 목록(`refresh`)과 카드·상태바 git 상태(`statusChanged` — 그 경로만)를 다시 읽게 한다(K7).
// · 로그(제약 6): 동작·결과 코드·걸린 시간·루트 해시·(취소·상한이면 그 사유)만 — URL·원격·브랜치 이름·stderr 원문 없음.
import { spawn } from 'node:child_process'
import { confine } from './explorer-fs.js'
import { errorText, rootTag, runGit, type GitRun, type ScmWriter } from './scm-write.js'
import { classifyRemoteError, isSafeRefName, maskCredentials, parseScmRemoteInput, type ScmRemoteAction, type ScmRemoteInput, type ScmRemoteRefusal, type ScmRemoteResult } from '../shared/scm-remote.js'

// --- 고정 argv (시험이 고정한다) ------------------------------------------------------------------------

export const SCM_FETCH_ARGS: readonly string[] = ['fetch']
// 브랜치는 `refs/heads/` 로 적는다(수정 r1 C2) — 같은 이름 태그가 있으면 `main:main` 은 「src refspec main matches more than one」 으로 막히고,
// pull 의 `main` 은 원격의 같은 이름 태그(`refs/tags/` 가 `refs/heads/` 보다 먼저 맞는다)를 끌어올 수 있다. 모양(원격 · 브랜치:upstream)은 그대로다.
const head = (branch: string): string => `refs/heads/${branch}`
export const scmPullArgs = (input: { remote: string; upstream: string }): string[] => ['pull', input.remote, head(input.upstream)]
export const scmPushArgs = (input: { remote: string; branch: string; upstream: string }): string[] => ['push', input.remote, `${head(input.branch)}:${head(input.upstream)}`]
export const scmPublishArgs = (input: { remote: string; branch: string }): string[] => ['push', '-u', input.remote, head(input.branch)]
/** 읽기(로컬 — 네트워크 없음). 분리된 HEAD 면 exit 1. `--short` 는 쓰지 않는다 — 같은 이름 태그가 있으면 `heads/<b>` 로 줄여 upstream 을 못 찾는다(수정 r1 C2). `refs/heads/` 는 직접 뗀다. */
export const SCM_BRANCH_ARGS: readonly string[] = ['symbolic-ref', '-q', 'HEAD']
export const SCM_REMOTES_ARGS: readonly string[] = ['remote']
export const scmUpstreamArgs = (branch: string): { remote: string[]; merge: string[] } => ({
  remote: ['config', '--get', `branch.${branch}.remote`],
  merge: ['config', '--get', `branch.${branch}.merge`],
})

/** 원격 동작 하나의 상한(D7) — 넘으면 그룹 종료 + 「시간 초과」. */
export const SCM_REMOTE_TIMEOUT_MS = 10 * 60_000
/** SIGTERM 뒤 SIGKILL 까지(K4ⓒ 통과선 2 초 안). */
export const SCM_REMOTE_KILL_GRACE_MS = 1_000
/** 앱 종료 때 진행 중 원격 그룹 정리를 기다리는 상한(수정 r1 C3) — 넘으면 기다리지 않고 종료를 잇는다. */
export const SCM_REMOTE_SHUTDOWN_MS = 2_000
/** 오류 원문 상한 — 앞 `ERROR_HEAD` + 뒤 나머지를 남긴다(긴 훅 출력의 꼬리 — 거절·원인 줄 — 가 잘리지 않게, 수정 r1 C9). */
const ERROR_LIMIT = 16 * 1024
const ERROR_HEAD = 2 * 1024
/** 원격 git 자식 env 에 더하는 키 — 시험이 이 목록을 고정한다(K6ⓒ). PATH 는 로그인 셸 값으로 바뀔 수 있다. */
export const scmRemoteEnv = (input: { base: NodeJS.ProcessEnv; loginPath: string | null }): NodeJS.ProcessEnv => ({
  ...input.base,
  ...(input.loginPath === null ? {} : { PATH: input.loginPath }),
  GIT_TERMINAL_PROMPT: '0',
  GIT_MERGE_AUTOEDIT: 'no',
  LC_ALL: 'en_US.UTF-8',
  LANG: 'en_US.UTF-8',
})

const READ_TIMEOUT_MS = 30_000
const OUTPUT_LIMIT = 1024 * 1024
/** 리더가 끝난 뒤 stdio 가 닫히기를 기다리는 한도 — 그룹 밖으로 나간 자손이 pipe 를 쥐고 있어도 결과를 낸다. */
const CLOSE_WAIT_MS = 1_000

// --- 프로세스 그룹 실행기 --------------------------------------------------------------------------------

export type KillReason = 'cancel' | 'timeout' | 'shutdown'
export type RemoteRun = GitRun & { killed: KillReason | null }

/** 원격 git 하나 — 새 세션·끊은 stdio 로 띄우고, `kill` 은 그 PID 그룹에만 신호를 보낸다(명령줄 패턴으로 찾지 않는다). */
export function runRemoteGit(input: {
  git: string
  cwd: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  graceMs: number
  onSpawn?: (pid: number) => void
  onSignal?: (input: { reason: KillReason; signal: 'SIGTERM' | 'SIGKILL' }) => void
}): { done: Promise<RemoteRun>; kill: (reason: KillReason) => void; terminate: (capMs: number) => Promise<void> } {
  const child = spawn(input.git, ['-C', input.cwd, ...input.args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: input.env })
  const pid = child.pid
  if (pid !== undefined) input.onSpawn?.(pid)
  let stdout = ''
  let stderr = ''
  let killed: KillReason | null = null
  let settled = false
  let exitCode: number | null = null
  let spawnError: string | null = null
  const timers: ReturnType<typeof setTimeout>[] = []
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  const signalGroup = (signal: 'SIGTERM' | 'SIGKILL'): void => {
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
    } catch {
      // 그룹이 이미 없다.
    }
  }
  const groupAlive = (): boolean => {
    if (pid === undefined) return false
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      return false
    }
  }
  const kill = (reason: KillReason): void => {
    // 리더가 이미 끝났으면(결과가 났다) 끊지 않는다 — 성공을 취소로 바꾸지 않게.
    if (settled || killed !== null || exitCode !== null) return
    killed = reason
    input.onSignal?.({ reason, signal: 'SIGTERM' })
    signalGroup('SIGTERM')
    // 결과가 먼저 나도(리더가 끝나 stdio 가 닫혀도) 이 타이머는 지우지 않는다 — SIGTERM 을 무시하고 남은 그룹원(ssh 류)까지 끝낸다.
    // (그룹이 이미 없으면 `finish` 가 지운다 — 수정 r1 C7.)
    graceTimer = setTimeout(() => {
      graceTimer = null
      if (!groupAlive()) return
      input.onSignal?.({ reason, signal: 'SIGKILL' })
      signalGroup('SIGKILL')
    }, input.graceMs)
  }
  /** 앱 종료(수정 r1 C3) — 리더가 끝났어도 그룹원이 남았으면 끝낸다. SIGTERM → 유예(상한의 절반까지) 뒤 SIGKILL, 그룹이 없어지거나 상한이면 돌아온다. */
  const terminate = async (capMs: number): Promise<void> => {
    if (!settled && killed === null && exitCode === null) killed = 'shutdown'
    if (!groupAlive()) return
    input.onSignal?.({ reason: 'shutdown', signal: 'SIGTERM' })
    signalGroup('SIGTERM')
    const startedAt = Date.now()
    let sentKill = false
    while (groupAlive() && Date.now() - startedAt < capMs) {
      if (!sentKill && Date.now() - startedAt >= Math.min(input.graceMs, capMs / 2)) {
        sentKill = true
        input.onSignal?.({ reason: 'shutdown', signal: 'SIGKILL' })
        signalGroup('SIGKILL')
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const done = new Promise<RemoteRun>((resolve) => {
    const finish = (): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      if (graceTimer !== null && !groupAlive()) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
      const code = exitCode ?? -1
      resolve({ exitCode: code, stdout, stderr: spawnError === null ? stderr : `${stderr}\n${spawnError}`, killed })
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    // 상한을 넘으면 뒤쪽을 남긴다 — 원인 줄은 보통 끝에 온다(C9).
    child.stdout?.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-OUTPUT_LIMIT)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-OUTPUT_LIMIT)
    })
    child.on('error', (error) => {
      spawnError = String(error)
      finish()
    })
    child.on('exit', (code) => {
      exitCode = code ?? -1
      timers.push(setTimeout(finish, CLOSE_WAIT_MS))
    })
    child.on('close', finish)
  })
  timers.push(setTimeout(() => kill('timeout'), input.timeoutMs))
  return { done, kill, terminate }
}

/** 원격 git 의 오류 원문 전체 — merge 충돌(`CONFLICT (…)`)·훅 출력은 stdout 에도 온다. 두 줄기를 다 싣는다(stderr 먼저). 자르기 전 이 값으로 분류한다(C9). */
export const remoteErrorText = (run: GitRun): string => {
  const text = [run.stderr.trim(), run.stdout.trim()].filter((part) => part !== '').join('\n')
  return text === '' ? `git 이 코드 ${run.exitCode} 로 끝났습니다.` : text
}

/** 표시 원문 상한 — 넘으면 앞 `ERROR_HEAD` 와 뒤를 남기고 가운데를 줄인다(C9). */
export const clipErrorText = (text: string): string => {
  if (text.length <= ERROR_LIMIT) return text
  const marker = `\n…(가운데 ${text.length - ERROR_LIMIT}자 줄임)…\n`
  return `${text.slice(0, ERROR_HEAD)}${marker}${text.slice(-(ERROR_LIMIT - ERROR_HEAD))}`
}

// --- 원격 동작 -------------------------------------------------------------------------------------------

export type ScmRemoteDeps = {
  writer: Pick<ScmWriter, 'enqueue' | 'loginPath'>
  roots: () => readonly string[]
  git: (roots: readonly string[]) => string
  /** 게시 원격 고르기(원격 2개 이상) — 고른 이름, 닫으면 null. 목록 밖 값은 거절된다. */
  pickRemote: (input: { remotes: readonly string[]; branch: string }) => Promise<string | null>
  /** 탐색기·소스 제어 목록 재조회(K1 `refresh` 와 같은 것). */
  refresh: (root: string) => void
  /** 카드·상태바 git 상태 재조회 — 그 경로만(K7). */
  statusChanged: (root: string) => void
  log: (event: string, data?: Record<string, unknown>) => void
  /** 시험 주입. */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  graceMs?: number
  onSpawn?: (input: { root: string; action: ScmRemoteAction; pid: number }) => void
  /** 루트의 진행 상태가 바뀔 때(시작 = 동작, 끝 = null) — 렌더러가 다시 그려져도 진행 표시·취소를 되살리게(수정 r1 C6). */
  onState?: (input: { root: string; action: ScmRemoteAction | null }) => void
}

type Slot = {
  action: ScmRemoteAction
  cancelled: boolean
  kill: ((reason: KillReason) => void) | null
  terminate: ((capMs: number) => Promise<void>) | null
  /** 아직 git 을 띄우기 전(고르기·큐 대기)의 취소 — 결과를 바로 돌려준다(수정 r1 C8ⓑ). */
  abort: () => void
  aborted: Promise<ScmRemoteResult>
}

const refused = (code: ScmRemoteRefusal, error: string): ScmRemoteResult => ({ ok: false, code, error })

type Branch = { branch: string; remotes: string[]; upstream: { remote: string; branch: string } | null }

export class ScmRemote {
  /** 루트별 진행 중 원격 동작 — 누른 때 세우고 끝나면 지운다(제약 8 상태 표). */
  private readonly slots = new Map<string, Slot>()
  /** 앱 종료가 시작됐다 — 새 동작을 받지 않는다(C3). */
  private closed = false

  constructor(private readonly deps: ScmRemoteDeps) {}

  /** IPC 입구 — 늘 결과로 답한다(throw 없음). */
  async run(raw: unknown): Promise<ScmRemoteResult> {
    const startedAt = performance.now()
    const input = parseScmRemoteInput(raw)
    if (input === null) {
      this.deps.log('scm.remote', { action: null, ok: false, code: 'bad_request', ms: 0 })
      return refused('bad_request', '요청 형 위반')
    }
    let result: ScmRemoteResult
    if (this.closed) result = refused('cancelled', '앱 종료 중')
    else if (!this.deps.roots().includes(input.root)) result = refused('not_worktree', '열린 worktree 루트가 아니다')
    else if (this.slots.has(input.root)) result = refused('busy', '원격 동작 진행 중')
    else {
      let abort = (): void => {}
      const aborted = new Promise<ScmRemoteResult>((resolve) => {
        abort = () => resolve(refused('cancelled', '기다리는 중 취소됨'))
      })
      const slot: Slot = { action: input.action, cancelled: false, kill: null, terminate: null, abort, aborted }
      this.slots.set(input.root, slot)
      this.deps.onState?.({ root: input.root, action: input.action })
      try {
        // 띄우기 전 취소는 `aborted` 가 먼저 끝난다 — 남은 `handle` 은 큐 차례에 `slot.cancelled` 를 보고 git 없이 끝난다.
        result = await Promise.race([this.handle(input, slot), aborted])
      } catch (error) {
        result = refused('git_error', clipErrorText(maskCredentials(String(error))))
      } finally {
        this.slots.delete(input.root)
        this.deps.onState?.({ root: input.root, action: null })
      }
    }
    this.deps.log('scm.remote', {
      action: input.action,
      root: rootTag(input.root),
      ok: result.ok,
      code: result.ok ? null : result.code,
      ms: Math.round((performance.now() - startedAt) * 10) / 10,
    })
    return result
  }

  /** 취소 단추 — 그 루트의 원격 동작이 돌고 있으면 그룹 종료, 큐에서 기다리면 git 없이 빠지게 표시한다. 없으면 `false`. */
  cancel(raw: unknown): { ok: boolean } {
    const root = typeof raw === 'object' && raw !== null && 'root' in raw && typeof raw.root === 'string' ? raw.root : null
    const slot = root === null ? undefined : this.slots.get(root)
    if (root === null || slot === undefined) return { ok: false }
    slot.cancelled = true
    this.deps.log('scm.remote.cancel', { action: slot.action, root: rootTag(root), running: slot.kill !== null })
    if (slot.kill === null) slot.abort()
    else slot.kill('cancel')
    return { ok: true }
  }

  /** 지금 원격 동작이 진행 중인 루트인가(시험·계측용). */
  busy(root: string): boolean {
    return this.slots.has(root)
  }

  /** 그 루트의 진행 중 동작(없으면 null) — 렌더러가 다시 그려질 때 진행 표시를 되살린다(C6). */
  state(raw: unknown): { action: ScmRemoteAction | null } {
    const root = typeof raw === 'object' && raw !== null && 'root' in raw && typeof raw.root === 'string' ? raw.root : null
    return { action: root === null ? null : (this.slots.get(root)?.action ?? null) }
  }

  /** 앱 종료(C3) — 새 동작을 막고, 기다리는 동작은 git 없이 빼고, 도는 원격 git 그룹은 끝낸다(SIGTERM → 유예 뒤 SIGKILL). 상한 안에 돌아온다. */
  async shutdown(capMs = SCM_REMOTE_SHUTDOWN_MS): Promise<void> {
    this.closed = true
    const startedAt = performance.now()
    const stopping: Promise<void>[] = []
    for (const slot of this.slots.values()) {
      slot.cancelled = true
      if (slot.terminate === null) slot.abort()
      else stopping.push(slot.terminate(capMs))
    }
    await Promise.race([Promise.all(stopping), new Promise((resolve) => setTimeout(resolve, capMs))])
    this.deps.log('scm.remote.shutdown', { running: stopping.length, ms: Math.round(performance.now() - startedAt) })
  }

  private async handle(input: ScmRemoteInput, slot: Slot): Promise<ScmRemoteResult> {
    // 게시의 원격 고르기는 큐 밖에서 묻는다(대화상자가 다른 쓰기를 막지 않게 — K1 확인 대화상자와 같은 규칙). 실제 argv 는 큐 차례에 다시 읽은 값으로 만든다.
    // 고를 때의 브랜치(`expected`)를 요청에 싣는다 — 큐 차례에 HEAD 브랜치가 달라졌으면 git 없이 거절한다(수정 r2 D4, coding.md 「적용 시점에 목적지가 아직 현재인가」).
    let picked: string | null = null
    let expected: string | null = null
    if (input.action === 'publish') {
      const confined = await confine({ roots: this.deps.roots(), root: input.root, rel: '' })
      if (!confined.ok) return refused('not_worktree', confined.error)
      const state = await this.readBranch(confined.realRoot)
      if (!state.ok) return state.result
      expected = state.value.branch
      if (state.value.remotes.length > 1) {
        picked = await this.deps.pickRemote({ remotes: state.value.remotes, branch: state.value.branch })
        this.deps.log('scm.dialog', { kind: 'pickRemote', choice: picked === null ? 'cancel' : 'remote' })
        if (picked === null) return refused('pick_cancelled', '취소됨')
      }
    }
    return this.deps.writer.enqueue(input.root, () => this.execute({ input, slot, picked, expected }))
  }

  private async execute(context: { input: ScmRemoteInput; slot: Slot; picked: string | null; expected: string | null }): Promise<ScmRemoteResult> {
    const { input, slot } = context
    if (slot.cancelled) return refused('cancelled', '기다리는 중 취소됨')
    // 고르기·앞 쓰기 대기 뒤에도 그 루트가 아직 열린 worktree 여야 한다(제약 8).
    const confined = await confine({ roots: this.deps.roots(), root: input.root, rel: '' })
    if (!confined.ok) return refused('not_worktree', confined.error)
    const cwd = confined.realRoot
    const plan = await this.plan({ cwd, action: input.action, picked: context.picked, expected: context.expected })
    if (!plan.ok) return plan.result
    const loginPath = await this.deps.writer.loginPath()
    if (slot.cancelled) return refused('cancelled', '기다리는 중 취소됨')
    if (!this.deps.roots().includes(input.root)) return refused('not_worktree', '열린 worktree 루트가 아니다')
    const git = this.deps.git(this.deps.roots())
    const running = runRemoteGit({
      git,
      cwd,
      args: plan.args,
      env: scmRemoteEnv({ base: this.deps.env ?? process.env, loginPath }),
      timeoutMs: this.deps.timeoutMs ?? SCM_REMOTE_TIMEOUT_MS,
      graceMs: this.deps.graceMs ?? SCM_REMOTE_KILL_GRACE_MS,
      onSpawn: (pid) => this.deps.onSpawn?.({ root: input.root, action: input.action, pid }),
      onSignal: ({ reason, signal }) => this.deps.log('scm.remote.kill', { action: input.action, root: rootTag(input.root), reason, signal }),
    })
    slot.kill = running.kill
    slot.terminate = running.terminate
    const run = await running.done
    // 끝(성공·실패·취소·상한) — fetch 가 실패해도 ref 를 바꿨을 수 있다. 목록과 카드·상태바를 다시 읽는다(D11).
    this.deps.refresh(input.root)
    this.deps.statusChanged(input.root)
    // 정상 종료가 먼저면 그대로 성공 — 끝난 직후 온 취소가 성공을 「취소」로 바꾸지 않는다(C8ⓐ).
    if (run.exitCode === 0) return { ok: true }
    if (run.killed === 'cancel' || run.killed === 'shutdown') return refused('cancelled', '취소됨')
    if (run.killed === 'timeout') return refused('timeout', maskCredentials(run.stderr.trim()).slice(-4096))
    const full = maskCredentials(remoteErrorText(run))
    return { ok: false, code: 'git_error', error: clipErrorText(full), hint: classifyRemoteError(full) }
  }

  /** 큐 차례의 argv — 브랜치·원격·upstream 을 git 에서 다시 읽는다(K9). git 실행 없이 끝나는 거절(원격 없음·upstream 없음·분리된 HEAD·이름 모양)도 여기. */
  private async plan(input: { cwd: string; action: ScmRemoteAction; picked: string | null; expected: string | null }): Promise<{ ok: true; args: readonly string[] } | { ok: false; result: ScmRemoteResult }> {
    if (input.action === 'fetch') {
      const remotes = await this.readRemotes(input.cwd)
      if (!remotes.ok) return { ok: false, result: remotes.result }
      if (remotes.value.length === 0) return { ok: false, result: refused('no_remote', '원격 없음') }
      return { ok: true, args: SCM_FETCH_ARGS }
    }
    const state = await this.readBranch(input.cwd)
    if (!state.ok) return { ok: false, result: state.result }
    const { branch, remotes, upstream } = state.value
    switch (input.action) {
      case 'publish': {
        if (input.expected !== null && input.expected !== branch)
          return { ok: false, result: refused('branch_changed', `'${input.expected}' 브랜치를 게시하려 했지만 지금 브랜치는 '${branch}' 입니다 — 아무것도 올리지 않았습니다. 다시 눌러 주세요.`) }
        const remote = input.picked ?? (remotes.length === 1 ? remotes[0] : undefined)
        if (remote === undefined) return { ok: false, result: refused('bad_name', '게시할 원격을 고르지 못했습니다 — 원격 목록이 바뀌었습니다. 다시 눌러 주세요.') }
        if (!remotes.includes(remote) || !isSafeRefName(remote)) return { ok: false, result: refused('bad_name', '고른 원격이 더 이상 없습니다 — 다시 눌러 주세요.') }
        return { ok: true, args: scmPublishArgs({ remote, branch }) }
      }
      case 'pull':
      case 'push': {
        if (upstream === null) return { ok: false, result: refused('no_upstream', 'upstream 없음') }
        if (!remotes.includes(upstream.remote)) return { ok: false, result: refused('bad_name', 'upstream 원격이 원격 목록에 없습니다 — 터미널에서 확인하세요.') }
        return { ok: true, args: input.action === 'pull' ? scmPullArgs({ remote: upstream.remote, upstream: upstream.branch }) : scmPushArgs({ remote: upstream.remote, branch, upstream: upstream.branch }) }
      }
    }
  }

  private read(cwd: string, args: readonly string[]): Promise<GitRun> {
    return runGit({ git: this.deps.git(this.deps.roots()), cwd, args, stdin: '', env: { ...(this.deps.env ?? process.env), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' }, timeoutMs: READ_TIMEOUT_MS })
  }

  private async readRemotes(cwd: string): Promise<{ ok: true; value: string[] } | { ok: false; result: ScmRemoteResult }> {
    const run = await this.read(cwd, SCM_REMOTES_ARGS)
    if (run.exitCode !== 0) return { ok: false, result: refused('git_error', maskCredentials(errorText(run))) }
    return { ok: true, value: run.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '') }
  }

  /** 현재 브랜치·원격 목록·upstream(`branch.<b>.remote`·`merge` — merge 는 `refs/heads/` 만). 원격 0 → `no_remote`, 분리된 HEAD → `detached`. */
  private async readBranch(cwd: string): Promise<{ ok: true; value: Branch } | { ok: false; result: ScmRemoteResult }> {
    const remotes = await this.readRemotes(cwd)
    if (!remotes.ok) return remotes
    const head = await this.read(cwd, SCM_BRANCH_ARGS)
    if (head.exitCode === 1) return { ok: false, result: refused('detached', '분리된 HEAD') }
    if (head.exitCode !== 0) return { ok: false, result: refused('git_error', maskCredentials(errorText(head))) }
    const ref = head.stdout.trim()
    if (!ref.startsWith('refs/heads/')) return { ok: false, result: refused('detached', '브랜치가 아닌 HEAD') }
    if (remotes.value.length === 0) return { ok: false, result: refused('no_remote', '원격 없음') }
    const branch = ref.slice('refs/heads/'.length)
    if (!isSafeRefName(branch)) return { ok: false, result: refused('bad_name', '브랜치 이름을 argv 에 넣을 수 없는 모양입니다.') }
    const keys = scmUpstreamArgs(branch)
    const [remote, merge] = await Promise.all([this.read(cwd, keys.remote), this.read(cwd, keys.merge)])
    const remoteName = remote.exitCode === 0 ? remote.stdout.trim() : ''
    const mergeRef = merge.exitCode === 0 ? merge.stdout.trim() : ''
    const upstreamBranch = mergeRef.startsWith('refs/heads/') ? mergeRef.slice('refs/heads/'.length) : ''
    const upstream = remoteName !== '' && upstreamBranch !== '' && isSafeRefName(remoteName) && isSafeRefName(upstreamBranch) ? { remote: remoteName, branch: upstreamBranch } : null
    return { ok: true, value: { branch, remotes: remotes.value.filter(isSafeRefName), upstream } }
  }
}
