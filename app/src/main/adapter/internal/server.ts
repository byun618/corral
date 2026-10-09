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
import { isSessionMarker } from '../../../shared/session-markers.js'
import type { BackendBinary, RestoreSummary } from '../../../shared/types.js'
import { log } from '../../log.js'
import { DEV_GUARD_APP_DIR, type DevGuardLookup } from './dev-guard.js'
import { PANE_ENV } from './pane-env.js'

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

/**
 * 설치본 안 동봉 herdr 자리 (LIFE-556) — `Contents/Resources/backend/herdr`. CLI shim 이 있는 `bin/` 과 다른 폴더라,
 * 사용자가 `bin/` 을 PATH 에 올려도 `herdr` 는 풀리지 않는다.
 */
export function bundledHerdrPath(resourcesPath: string): string {
  return path.join(resourcesPath, 'backend', 'herdr')
}

/**
 * herdr 설정·상태 폴더 이름. 동봉 herdr(release + `app/backend/herdr-bundle.patch`)의 `app_dir_name()` 은 `corral-herdr` 다 —
 * 별도로 설치된 herdr(`herdr`)와 소켓·세션·config 를 나누지 않게 한다. 두 값은 패치와 같이 바뀌어야 한다.
 */
export const STOCK_HERDR_APP_DIR = 'herdr'
export const BUNDLED_HERDR_APP_DIR = 'corral-herdr'

/**
 * `bundled` — 설치본이라 동봉 바이너리만 찾았다. 미설치 카드가 재설치 안내를 고르는 근거다.
 * `stale` — 개발 실행의 레포 guard 가 지금 체크아웃과 맞지 않는다(LIFE-561 G3). 그 바이너리도, 종전 후보도 쓰지 않는다.
 */
export type HerdrResolution =
  | { kind: 'found'; binary: BackendBinary }
  | { kind: 'missing'; searched: string[]; bundled: boolean }
  | { kind: 'stale'; path: string; reason: string }

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
  return { kind: 'missing', searched, bundled: false }
}

/**
 * 어디서 찾을지 (LIFE-556). 측정용 `CORRAL_HERDR_BIN` 이 먼저고, 설치본(`bundled` 자리가 있음)이면 **동봉 바이너리만** 본다 —
 * 없거나 실행할 수 없어도 로그인 셸·알려진 위치로 내려가지 않는다(그건 별도 설치 herdr 에 붙는 길이다).
 * 개발 실행은 바인딩이 없을 때만 레포 guard(LIFE-561)를 먼저 본다(`devGuard` — 바인딩이 있거나 설치본이면 null): 영수증이 맞으면 그것,
 * 낡았으면 멈춤(`stale`), 자리가 없으면 종전대로 `external`(로그인 셸 → 알려진 위치).
 */
export async function locateHerdr(input: {
  override: string | undefined
  bundled: string | null
  /** 없거나 null 이면 레포 guard 를 보지 않는다 — 설치본·바인딩 있는 개발 실행. */
  devGuard?: (() => Promise<DevGuardLookup>) | null
  isExecutable: (file: string) => boolean
  external: () => Promise<HerdrResolution>
}): Promise<HerdrResolution> {
  // `CORRAL_HERDR_BIN` — 측정이 가짜 바이너리(즉시 종료 등)를 물릴 때만 쓴다. 실행 불가면 없음으로 간다.
  if (input.override !== undefined && input.override.length > 0) {
    return input.isExecutable(input.override)
      ? { kind: 'found', binary: { path: input.override, source: 'env', version: null } }
      : { kind: 'missing', searched: [`CORRAL_HERDR_BIN=${input.override}`], bundled: input.bundled !== null }
  }
  if (input.bundled !== null) {
    return input.isExecutable(input.bundled)
      ? { kind: 'found', binary: { path: input.bundled, source: 'bundled', version: null } }
      : { kind: 'missing', searched: [input.bundled], bundled: true }
  }
  if (input.devGuard === undefined || input.devGuard === null) return input.external()
  const guard = await input.devGuard()
  if (guard.kind === 'ok') return { kind: 'found', binary: { path: guard.path, source: 'repo-guard', version: null } }
  if (guard.kind === 'stale') return { kind: 'stale', path: guard.path, reason: guard.reason }
  const external = await input.external()
  return external.kind === 'missing' ? { ...external, searched: [`레포 guard ${guard.place}`, ...external.searched] } : external
}

/** 레포 guard 로 풀렸나 (LIFE-561) — 낡음(`stale`)도 guard 쪽이다. 세션 폴더(F1)·default 고정(G2)의 근거. */
export function onRepoGuard(resolution: HerdrResolution | null): boolean {
  if (resolution === null) return false
  return resolution.kind === 'stale' || (resolution.kind === 'found' && resolution.binary.source === 'repo-guard')
}

/** 세션 폴백 폴더 — 바이너리와 같아야 한다: 동봉 `corral-herdr` · 레포 guard(debug) `herdr-dev` · 그 밖 `herdr`. */
export function herdrAppDirFor(input: { bundled: boolean; resolution: HerdrResolution | null }): string {
  if (input.bundled) return BUNDLED_HERDR_APP_DIR
  return onRepoGuard(input.resolution) ? DEV_GUARD_APP_DIR : STOCK_HERDR_APP_DIR
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

/**
 * 실제 해소 — 동봉(설치본) 또는 레포 guard·로그인 셸 + 알려진 위치, 그리고 버전. 결과(경로·버전·출처)를 로그에 한 줄 남긴다 (K1ⓒ).
 * `bundled` — 설치본의 동봉 바이너리 자리, 개발 실행은 null. `devGuard` — 바인딩 없는 개발 실행만(LIFE-561), 그 밖은 null.
 */
export async function resolveHerdrBinary(input: { bundled: string | null; devGuard: (() => Promise<DevGuardLookup>) | null }): Promise<HerdrResolution> {
  const resolution = await locateHerdr({
    override: process.env.CORRAL_HERDR_BIN,
    bundled: input.bundled,
    devGuard: input.devGuard,
    isExecutable: isExecutableFile,
    external: () => resolveHerdr({ loginShellLookup, candidates: knownHerdrLocations(os.homedir()), isExecutable: isExecutableFile }),
  })
  if (resolution.kind === 'missing') {
    log('herdr.resolve', { found: false, searched: resolution.searched, bundled: resolution.bundled })
    return resolution
  }
  if (resolution.kind === 'stale') {
    log('herdr.resolve', { found: false, stale: true, path: resolution.path, reason: resolution.reason, source: 'repo-guard' })
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
    // 에이전트 세션 안에서 뜬 corral 이 그 세션 마커를 pane 셸까지 물리지 않게(LIFE-555 A5) — 허용 목록 변수(CODEX_HOME 등)는 남는다.
    if (isSessionMarker(key)) continue
    // npm 스크립트로 띄운 개발 실행이 싣는 변수 — pane 셸에 새면 그 셸의 npm 이 엉뚱한 설정을 읽는다(r2 R2-06).
    if (/^npm_(config|lifecycle)_/.test(key)) continue
    out[key] = value
  }
  // LIFE-565 C6ⓗ — pane 단위 env(`tab.create`·`workspace.create`·`pane.split`)를 못 싣는 herdr 경로(`worktree.open`·`worktree.create` 의 첫 pane)도
  // OSC 8 을 받게 서버 env 에도 같은 값을 둔다. 사용자 env 에 같은 키가 있어도 덮어쓴다 — pane 단위 env 가 이미 서버 env 를 늘 덮어쓰므로,
  // 여기서만 존중하면 같은 서버 안에서 첫 pane 과 나머지 pane 의 값이 갈린다. 서버를 새로 띄울 때부터 적용된다(떠 있는 서버는 그대로).
  return { ...out, ...PANE_ENV }
}

/**
 * 동봉 서버 env (LIFE-556) — `serverEnv` 에서 `HERDR_*` 를 **전부** 더 뺀다. 남겨 두던 설정 변수(`HERDR_CONFIG_PATH` 등)는
 * 사용자가 별도 설치 herdr 용으로 둔 값이라, 동봉 서버가 그 config 를 읽으면 폴더를 나눈 뜻이 없다.
 * `XDG_*` 는 손대지 않는다 — pane 셸이 물려받으므로 앱 기동 env 그대로여야 한다(B2).
 */
export function bundledServerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(serverEnv(env)).filter(([key]) => !key.startsWith('HERDR_')))
}

export type ServerSpawn = { ok: true; pid: number; logPath: string } | { ok: false; error: string; logPath: string }

/**
 * 서버를 **앱과 분리해** 띄운다 (D4). `herdr server` 는 포그라운드라 분리는 우리 몫이다:
 * 새 세션(`detached` → setsid)·부모와 끊긴 stdio(stdin 은 /dev/null, 출력은 로그 파일)·`unref`.
 * herdr 자신의 자동 기동(무인자 `herdr`)이 같은 바이너리 + `server` 를 setsid + null stdio 로 띄우는 것과 같은 모양이다.
 * 앱 종료 때 끄지 않는다 — PTY 영속이 herdr 의 역할이다.
 */
export function spawnServer(input: {
  binary: string
  logPath: string
  onExit: (code: number | null, signal: string | null) => void
  /** 동봉 herdr 인가 (LIFE-556) — env 를 `bundledServerEnv` 로 거른다. */
  bundled?: boolean
}): ServerSpawn {
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
      env: input.bundled === true ? bundledServerEnv(process.env) : serverEnv(process.env),
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
