// herdr 서버 기동 (LIFE-485) — 바이너리 해소(D5) · 재개 대상 계수(D2) · 분리 기동(D4).
//
// 무엇을 띄울지·언제 띄울지는 여기서 정하지 않는다 — 결정은 main 의 `backend-start.ts` 순수 함수다.
// 이 파일은 herdr 를 아는 손만 갖는다: 어떤 파일을 읽어 재개 대상을 세는지, 어떤 argv 로 서버를 띄우는지.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { isRecord } from '../../../shared/json.js'
import type { BackendBinary, RestoreSummary } from '../../../shared/types.js'
import { log } from '../../log.js'

const run = promisify(execFile)

/** 로그인 셸 `command -v` 시한 — Orca `hydrate-shell-path.ts` 와 같은 10초. 넘으면 알려진 위치로 간다. */
export const LOGIN_SHELL_TIMEOUT_MS = 10_000

/**
 * 서버가 `running:true` 로 보일 때까지 기다리는 상한 (K4ⓗ). herdr 0.9.0 은 1초 안에 소켓을 연다(실측) —
 * 넉넉히 15배. 넘으면 「시작 실패」 다. 무한히 「시작 중」 에 머물지 않게 하는 것이 목적이다.
 */
export const SERVER_READY_TIMEOUT_MS = 15_000
export const SERVER_READY_POLL_MS = 250

/** Finder·Dock 기동 앱은 로그인 셸 PATH 를 물려받지 않는다 — 셸 조회가 실패하면 이 순서로 본다. */
export function knownHerdrLocations(home: string): string[] {
  return ['/opt/homebrew/bin/herdr', '/usr/local/bin/herdr', path.join(home, '.local/bin/herdr'), path.join(home, '.cargo/bin/herdr')]
}

export type HerdrResolution = { kind: 'found'; binary: BackendBinary } | { kind: 'missing'; searched: string[] }

/**
 * 바이너리 해소 (D5). **순수에 가깝게** — 셸 조회·실행 가능 판정을 주입받아 단위 테스트가 실제 셸 없이 돈다.
 * 순서: 로그인 셸 `command -v herdr` → 알려진 위치 중 실행 가능한 첫 것 → 없음.
 */
export async function resolveHerdr(input: {
  loginShellLookup: () => Promise<string | null>
  candidates: readonly string[]
  isExecutable: (file: string) => boolean
}): Promise<HerdrResolution> {
  const searched: string[] = []
  const fromShell = await input.loginShellLookup().catch(() => null)
  searched.push('로그인 셸 command -v herdr')
  if (fromShell !== null && path.isAbsolute(fromShell) && input.isExecutable(fromShell)) {
    return { kind: 'found', binary: { path: fromShell, source: 'login-shell', version: null } }
  }
  for (const candidate of input.candidates) {
    searched.push(candidate)
    if (input.isExecutable(candidate)) return { kind: 'found', binary: { path: candidate, source: 'known-location', version: null } }
  }
  return { kind: 'missing', searched }
}

export function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

const SHELL_MARK = '__CORRAL_HERDR__'

/** `$SHELL -ilc` 로 `command -v herdr` — 프롬프트·배너 잡음을 피하려고 구분자로 감싼다. */
export async function loginShellLookup(): Promise<string | null> {
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  const { stdout } = await run(shell, ['-ilc', `printf '${SHELL_MARK}%s${SHELL_MARK}' "$(command -v herdr)"`], {
    timeout: LOGIN_SHELL_TIMEOUT_MS,
    env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
  })
  return parseShellLookup(stdout)
}

export function parseShellLookup(stdout: string): string | null {
  const start = stdout.indexOf(SHELL_MARK)
  if (start < 0) return null
  const end = stdout.indexOf(SHELL_MARK, start + SHELL_MARK.length)
  if (end < 0) return null
  const value = stdout.slice(start + SHELL_MARK.length, end).trim()
  return value.length > 0 ? value : null
}

function locate(): Promise<HerdrResolution> {
  // `CORRAL_HERDR_BIN` — 측정이 가짜 바이너리(즉시 종료 등)를 물릴 때만 쓴다. 실행 불가면 없음으로 간다.
  const override = process.env.CORRAL_HERDR_BIN
  if (override !== undefined && override.length > 0) {
    const result: HerdrResolution = isExecutableFile(override)
      ? { kind: 'found', binary: { path: override, source: 'env', version: null } }
      : { kind: 'missing', searched: [`CORRAL_HERDR_BIN=${override}`] }
    return Promise.resolve(result)
  }
  return resolveHerdr({ loginShellLookup, candidates: knownHerdrLocations(os.homedir()), isExecutable: isExecutableFile })
}

/** 실제 해소 — 로그인 셸 + 알려진 위치 + 버전. 결과(경로·버전·출처)를 로그에 한 줄 남긴다 (K1ⓒ). */
export async function resolveHerdrBinary(): Promise<HerdrResolution> {
  const resolution = await locate()
  if (resolution.kind === 'missing') {
    log('herdr.resolve', { found: false, searched: resolution.searched })
    return resolution
  }
  let version: string | null = null
  try {
    const { stdout } = await run(resolution.binary.path, ['--version'], { timeout: 5000 })
    version = stdout.trim() || null
  } catch (error) {
    version = null
    log('herdr.resolve.version_failed', { error: String(error) })
  }
  const binary = { ...resolution.binary, version }
  log('herdr.resolve', { found: true, path: binary.path, version: binary.version, source: binary.source })
  return { kind: 'found', binary }
}

/**
 * 재개 대상 agent pane 계수 (D2). herdr 는 서버 기동 뒤 첫 클라이언트가 붙으면 `agent_session` 이
 * 남은 pane 을 native 세션으로 재개한다 — 띄우기 **전에** 센다.
 *
 * 형식 판별은 herdr upstream 순서 그대로(`src/persist/snapshot.rs` `migrate_workspace`, 고정 commit b99002ac):
 * `identity_cwd` 가 있으면 현재 형식(`tabs[].panes`), 없고 `layout` 이 있으면 구형(`workspace.panes`, 덧붙은 tabs 무시).
 * **모르는 구조·읽기 실패·파싱 실패는 0 이 아니라 `known:false`** — 기동 결정에서 확인 쪽으로 간다(477 r2·r3 함정).
 * 출력은 개수와 종류뿐이다 — 경로·세션 id·대화 내용은 싣지 않는다.
 */
export function countRestoreTargets(text: string | null): RestoreSummary {
  if (text === null) return { known: true, total: 0, agents: [] }
  let session: unknown
  try {
    session = JSON.parse(text)
  } catch {
    return { known: false, reason: 'session.json 을 JSON 으로 읽지 못했다' }
  }
  if (!isRecord(session)) return { known: false, reason: 'session 이 객체가 아니다' }
  // 비어 있지 않은 파일인데 workspaces 가 없으면 0 이 아니라 모름이다 — 키 이름이 바뀐 버전일 수 있다(r1 R1-02). 파일 없음만 0.
  if (!('workspaces' in session)) return { known: false, reason: 'workspaces 가 없다' }
  const workspaces = session['workspaces']
  if (!Array.isArray(workspaces)) return { known: false, reason: 'workspaces 가 배열이 아니다' }
  const paneMaps: Record<string, unknown>[] = []
  for (const [index, workspace] of workspaces.entries()) {
    if (!isRecord(workspace)) return { known: false, reason: `workspace ${index} 가 객체가 아니다` }
    if ('identity_cwd' in workspace) {
      const tabs = workspace['tabs']
      if (!Array.isArray(tabs)) return { known: false, reason: `workspace ${index} 는 현재 형식인데 tabs 가 배열이 아니다` }
      for (const [tabIndex, tab] of tabs.entries()) {
        if (!isRecord(tab) || !isRecord(tab['panes'])) return { known: false, reason: `workspace ${index} tab ${tabIndex} 의 panes 를 모른다` }
        paneMaps.push(tab['panes'])
      }
    } else if ('layout' in workspace) {
      const panes = workspace['panes']
      if (!isRecord(panes)) return { known: false, reason: `workspace ${index} 는 구형인데 panes 가 객체가 아니다` }
      paneMaps.push(panes)
    } else {
      return { known: false, reason: `workspace ${index} 구조를 모른다` }
    }
  }
  const counts = new Map<string, number>()
  let total = 0
  for (const panes of paneMaps)
    for (const pane of Object.values(panes)) {
      // 객체가 아닌 pane·객체도 null 도 아닌 agent_session 은 건너뛰지 않는다 — 셀 수 없는 것을 0 으로 세면 자동 기동이 재개를 일으킨다(r1 R1-02·G-2).
      if (!isRecord(pane)) return { known: false, reason: 'pane 이 객체가 아니다' }
      const agentSession = pane['agent_session']
      if (agentSession === undefined || agentSession === null) continue
      if (!isRecord(agentSession)) return { known: false, reason: 'agent_session 이 객체가 아니다' }
      total += 1
      const kind = typeof agentSession['agent'] === 'string' ? agentSession['agent'] : 'unknown'
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
  const agents = [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => a.kind.localeCompare(b.kind))
  return { known: true, total, agents }
}

/** 세션 디렉터리의 session.json 을 읽어 센다. 디렉터리를 모르면(조회 실패) 모름이다 — 0 으로 흘리지 않는다. */
export function readRestoreTargets(sessionDir: string | null): RestoreSummary {
  if (sessionDir === null) return { known: false, reason: '세션 디렉터리를 알 수 없다' }
  const file = path.join(sessionDir, 'session.json')
  let text: string | null
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') text = null
    // 원문에는 경로가 실린다 — 계수 출력에는 코드만 남긴다(K2ⓓ).
    else return { known: false, reason: `session.json 을 읽지 못했다 (${isRecord(error) && typeof error['code'] === 'string' ? error['code'] : '알 수 없는 오류'})` }
  }
  return countRestoreTargets(text)
}

/**
 * 서버에 넘기지 않는 환경변수 — 서버가 띄우는 모든 pane 셸이 물려받는다 (D4).
 * `HERDR_*` 는 **pane·클라이언트 범위 변수만** 지운다(r1 R1-08) — corral 이 herdr pane 안에서 떴으면 그 pane 의 세션·소켓·id 가
 * 실려 있다. 설정·로그 변수(`HERDR_CONFIG_PATH`·`HERDR_LOG` 등)는 사용자가 직접 띄운 서버와 같은 설정을 읽도록 남긴다.
 * 목록 출처: herdr 0.9.0 바이너리 문자열(`strings /opt/homebrew/bin/herdr | grep HERDR_`) 중 pane·플러그인·훅 실행 문맥으로 주입되는 것.
 */
const HERDR_PANE_SCOPED = new Set([
  'HERDR_ENV', 'HERDR_SESSION', 'HERDR_SOCKET_PATH', 'HERDR_CLIENT_SOCKET_PATH', 'HERDR_BIN_PATH',
  'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID', 'HERDR_ACTION', 'HERDR_REATTACH_COMMAND', 'HERDR_STARTUP_CWD',
  'HERDR_HOOK_INPUT_FILE', 'HERDR_INTEGRATION_ID', 'HERDR_INTEGRATION_VERSION',
])

export function serverEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (/^(CORRAL_|ELECTRON_|VITE_)/.test(key)) continue
    if (HERDR_PANE_SCOPED.has(key) || /^HERDR_(ACTIVE|PLUGIN)_/.test(key)) continue
    if (key === 'NODE_OPTIONS' || key === 'NODE_ENV' || key === 'NODE_CHANNEL_FD') continue
    // npm 스크립트로 띄운 개발 실행이 싣는 변수 — pane 셸에 새면 그 셸의 npm 이 엉뚱한 설정을 읽는다(r2 R2-06).
    if (/^npm_(config|lifecycle)_/.test(key)) continue
    out[key] = value
  }
  return out
}

export type ServerSpawn = { ok: true; pid: number; logPath: string } | { ok: false; error: string; logPath: string }

/**
 * 서버를 **앱과 분리해** 띄운다 (D4). `herdr server` 는 포그라운드라 분리는 우리 몫이다:
 * 새 세션(`detached` → setsid)·부모와 끊긴 stdio(stdin 은 /dev/null, 출력은 로그 파일)·`unref`.
 * herdr 자신의 자동 기동(무인자 `herdr`)이 같은 바이너리 + `server` 를 setsid + null stdio 로 띄우는 것과 같은 모양이다.
 * 앱 종료 때 끄지 않는다 — PTY 영속이 herdr 의 역할이다.
 */
export function spawnServer(input: { binary: string; logPath: string; onExit: (code: number | null, signal: string | null) => void }): ServerSpawn {
  let fd: number
  try {
    fs.mkdirSync(path.dirname(input.logPath), { recursive: true })
    rotateLog(input.logPath)
    fd = fs.openSync(input.logPath, 'a')
  } catch (error) {
    return { ok: false, error: `로그 파일을 열지 못했다: ${String(error)}`, logPath: input.logPath }
  }
  try {
    fs.writeSync(fd, `\n--- corral ${new Date().toISOString()} spawn ${input.binary} server\n`)
  } catch (error) {
    // 열었는데 쓰지 못했다 — fd 를 닫고 돌아간다(r2 R2-08).
    fs.closeSync(fd)
    return { ok: false, error: `로그 파일에 쓰지 못했다: ${String(error)}`, logPath: input.logPath }
  }
  try {
    const child = spawn(input.binary, ['server'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: serverEnv(process.env),
      cwd: os.homedir(),
    })
    // 실행 파일이 없으면 pid 없이 'error' 가 뒤늦게 온다 — 듣지 않으면 uncaught 다. 판정은 아래 pid 로 한다.
    child.once('error', (error) => log('herdr.server.spawn_error', { error: String(error) }))
    child.once('exit', (code, signal) => input.onExit(code, signal))
    child.unref()
    if (child.pid === undefined) return { ok: false, error: 'spawn 이 pid 를 주지 않았다', logPath: input.logPath }
    log('herdr.server.spawn', { binary: input.binary, pid: child.pid, logPath: input.logPath })
    return { ok: true, pid: child.pid, logPath: input.logPath }
  } catch (error) {
    return { ok: false, error: String(error), logPath: input.logPath }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 그 pid 가 우리가 띄운 herdr 서버인가(r5 R5-01) — 그룹 리더(pgid===pid)이고 명령이 정확히 `<binary> server`.
 * 남긴 자식을 다음 기동에서 끝내기 직전에 본다. 번호가 재사용된 남의 프로세스(그룹)를 끝내지 않기 위해서다(native-down.sh 와 같은 원칙).
 */
export async function inspectServerProcess(pid: number, binary: string | null): Promise<{ ours: boolean; detail: string }> {
  if (binary === null) return { ours: false, detail: 'herdr 경로를 모른다' }
  let stdout: string
  try {
    stdout = (await run('/bin/ps', ['-o', 'pgid=,args=', '-p', String(pid)], { timeout: 2000 })).stdout
  } catch {
    return { ours: false, detail: `pid ${pid} 없음` }
  }
  const match = /^\s*(\d+)\s+(.*?)\s*$/.exec(stdout.split('\n')[0] ?? '')
  if (match === null) return { ours: false, detail: `ps 출력을 읽지 못했다: ${stdout.slice(0, 120)}` }
  const pgid = Number(match[1])
  const args = match[2] ?? ''
  if (pgid !== pid) return { ours: false, detail: `그룹 리더 아님 (pgid ${pgid})` }
  if (args !== `${binary} server`) return { ours: false, detail: `명령 불일치: ${args.slice(0, 160)}` }
  return { ours: true, detail: args }
}

/** 서버 로그 상한 — 넘으면 기동 직전에 `.1` 로 한 번 밀어 둔다(r1 R1-10, 무한 증가 방지). 서버가 도는 동안은 자르지 않는다. */
export const SERVER_LOG_MAX_BYTES = 1024 * 1024

/**
 * 남는 경합(r2 R2-04, 주석만): 기동 직전 재조회와 spawn 사이에 다른 손이 서버를 띄우면, 그 서버가 이미 쓰고 있는 로그를 여기서 `.1` 로
 * 밀 수 있다(우리 자식은 락에 지고 끝난다). 피해는 그 서버 로그가 `.1` 에 이어 쓰이는 위치 혼선뿐이라 프로세스 간 락을 두지 않는다.
 */
export function rotateLog(logPath: string, maxBytes = SERVER_LOG_MAX_BYTES): boolean {
  try {
    if (fs.statSync(logPath).size <= maxBytes) return false
  } catch {
    return false
  }
  fs.renameSync(logPath, `${logPath}.1`)
  return true
}

/** 로그 끝부분 — 「시작 실패」 원문. */
export function readLogTail(logPath: string, bytes = 1200): string {
  try {
    const text = fs.readFileSync(logPath, 'utf8')
    return text.slice(-bytes).trim()
  } catch {
    return ''
  }
}

/**
 * 시한을 넘긴 서버의 프로세스 그룹을 끝낸다(r2 R2-01). `detached` 로 띄워 pid = 그룹 id 다. SIGTERM → `graceMs` 기다림 → SIGKILL.
 * 끝났으면 true. 이미 없으면 true.
 */
export async function stopProcessGroup(pid: number, graceMs = 2000): Promise<boolean> {
  const alive = (): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const signal = (name: NodeJS.Signals): void => {
    try {
      process.kill(-pid, name)
    } catch {
      // 그룹이 이미 없다
    }
  }
  if (!alive()) return true
  signal('SIGTERM')
  const deadline = Date.now() + graceMs
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  if (alive()) signal('SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const gone = !alive()
  log('herdr.server.stop_group', { pid, gone })
  return gone
}
