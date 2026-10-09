// tailscale CLI 경계 (LIFE-577) — 찾기·실행(타임아웃)·`status --json`/`serve status --json` 읽기·corral 항목 argv.
//
// **electron 을 모른다** — vitest 가 가짜 CLI 로 그대로 돈다. 부르는 쪽(`exposure.ts`)이 순서·소유권을 정하고,
// 이 파일은 「무엇을 어떻게 부르나」 만 안다.
//
// - argv 는 **상수와 숫자만**으로 조립한다 — 사용자 입력·파일 내용이 섞이지 않는다(대상 URL 은 우리 서버 포트 숫자로 만든다).
// - `serve reset`·`funnel` 을 부르는 길이 없다. 제거는 켤 때와 같은 플래그 + `off` 하나뿐(00-analysis W2).
// - 모든 호출에 타임아웃이 있고, 넘기면 **프로세스 그룹째** SIGKILL 한다 — 래퍼 sh 가 자식을 남겨도 파이프가 안 막힌다.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { isRecord, readRecord, readString } from '../../shared/json.js'

/**
 * corral 전용 HTTPS 포트 [E7] — Funnel 허용 포트(443·8443·10000) 밖이라 이 항목은 구조적으로 Funnel 될 수 없다.
 * 443 은 사용자 몫으로 비운다(LA 본문).
 */
export const MOBILE_HTTPS_PORT = 8577
export const FUNNEL_PORTS: readonly number[] = [443, 8443, 10000]

/** 읽기 호출(status 류) 상한. tailscaled 가 죽어 있으면 CLI 가 오래 기다린다. */
export const TAILSCALE_READ_TIMEOUT_MS = 5_000
/** 쓰기 호출(serve 추가·제거) 상한. HTTPS 꺼짐이면 serve 가 승인 URL 을 띄우고 블록한다(W4) — 사전 점검이 막지만 여기서도 끊는다. */
export const TAILSCALE_WRITE_TIMEOUT_MS = 10_000

export type TailscaleRun = { ok: true; stdout: string } | { ok: false; reason: 'timeout' | 'exit' | 'spawn'; detail: string }

/** 실행기 — 주입식. 실제는 `runTailscale`, 시험은 가짜 CLI 경로를 같은 실행기로 돈다. */
export type TailscaleRunner = (input: { bin: string; args: readonly string[]; timeoutMs: number; signal?: AbortSignal }) => Promise<TailscaleRun>

const MAX_OUTPUT = 4 * 1024 * 1024

export const runTailscale: TailscaleRunner = ({ bin, args, timeoutMs, signal }) =>
  new Promise((resolve) => {
    let settled = false
    const settle = (result: TailscaleRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    // 종료 마감(앱 quit)이 오면 기다리지 않고 그룹째 죽인다 — 앱이 끝난 뒤 매달린 tailscale 자식이 남지 않게.
    const onAbort = (): void => {
      killGroup(child?.pid)
      settle({ ok: false, reason: 'timeout', detail: 'aborted' })
    }
    if (signal?.aborted) {
      resolve({ ok: false, reason: 'timeout', detail: 'aborted' })
      return
    }
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    delete env.ELECTRON_RUN_AS_NODE
    let child: ReturnType<typeof spawn> | null = null
    try {
      child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env })
    } catch (error) {
      resolve({ ok: false, reason: 'spawn', detail: String(error) })
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      killGroup(child?.pid)
      settle({ ok: false, reason: 'timeout', detail: `${timeoutMs}ms` })
    }, timeoutMs)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => settle({ ok: false, reason: 'spawn', detail: String(error) }))
    child.on('close', (code, killSignal) => {
      if (code === 0) settle({ ok: true, stdout })
      else settle({ ok: false, reason: 'exit', detail: `exit ${code ?? killSignal}: ${stderr.trim().slice(0, 300)}` })
    })
  })

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* 이미 끝났다 */ }
  }
}

// --- 찾기 ------------------------------------------------------------------------------------------------

/**
 * Finder 로 띄운 앱에는 셸 PATH 가 없다(F7) — 알려진 위치를 먼저 보고, 없으면 로그인 셸 `command -v tailscale`.
 * `/usr/local/bin/tailscale` 은 standalone 의 「CLI integration」 래퍼, 앱 번들 실행 파일은 CLI 로도 돈다(래퍼가 그것을 부른다).
 */
export const KNOWN_TAILSCALE_LOCATIONS: readonly string[] = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
]

/**
 * 해소 — `override`(격리 실행의 가짜 CLI, `CORRAL_TAILSCALE_BIN`)가 있으면 **그것만** 본다(없으면 없음 — 실제 CLI 로 내려가지 않는다).
 */
export async function locateTailscale(input: {
  override: string | undefined
  candidates: readonly string[]
  isExecutable: (file: string) => boolean
  loginShellLookup: () => Promise<string | null>
}): Promise<string | null> {
  if (input.override !== undefined && input.override.length > 0) return input.isExecutable(input.override) ? input.override : null
  for (const candidate of input.candidates) if (input.isExecutable(candidate)) return candidate
  const fromShell = await input.loginShellLookup().catch(() => null)
  return fromShell !== null && path.isAbsolute(fromShell) && input.isExecutable(fromShell) ? fromShell : null
}

const SHELL_MARK = '__CORRAL_TAILSCALE__'

export async function loginShellTailscale(): Promise<string | null> {
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  const result = await runTailscale({
    bin: shell,
    args: ['-ilc', `printf '${SHELL_MARK}%s${SHELL_MARK}' "$(command -v tailscale)"`],
    timeoutMs: 5_000,
  })
  if (!result.ok) return null
  const start = result.stdout.indexOf(SHELL_MARK)
  const end = start < 0 ? -1 : result.stdout.indexOf(SHELL_MARK, start + SHELL_MARK.length)
  if (end < 0) return null
  const value = result.stdout.slice(start + SHELL_MARK.length, end).trim()
  return value.length > 0 ? value : null
}

// --- 읽기 ------------------------------------------------------------------------------------------------

/** `tailscale status --json` 에서 쓰는 것만. */
export type NodeStatus = {
  /** `BackendState === 'Running'` — 로그인·연결됨. */
  running: boolean
  backendState: string | null
  /** 끝 점을 뗀 자기 DNS 이름(`mac.tailnet.ts.net`). 없으면 null. */
  dnsName: string | null
  /** `CertDomains` 에 자기 DNS 이름이 있다 — tailnet HTTPS 인증서가 켜졌다(W4). */
  https: boolean
}

export function parseNodeStatus(stdout: string): NodeStatus | null {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { return null }
  if (!isRecord(parsed)) return null
  const backendState = readString(parsed, 'BackendState')
  const self = readRecord(parsed, 'Self')
  const rawDns = self === null ? null : readString(self, 'DNSName')
  const dnsName = rawDns === null || rawDns.length === 0 ? null : rawDns.replace(/\.$/, '')
  const certDomains = Array.isArray(parsed.CertDomains) ? parsed.CertDomains : []
  const https = dnsName !== null && certDomains.some((domain) => typeof domain === 'string' && domain.replace(/\.$/, '') === dnsName)
  return { running: backendState === 'Running', backendState, dnsName, https }
}

/** `serve status --json` — 모양을 모르면 null(읽을 수 없음 = 아무것도 건드리지 않는다). 빈 출력·`{}` 는 빈 설정. */
export function parseServeConfig(stdout: string): Record<string, unknown> | null {
  if (stdout.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(stdout)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 노드에 Funnel 이 하나라도 켜져 있나 [E1] — 최상위 `AllowFunnel` 과 `Foreground.<세션>` 안을 재귀로(W3). */
export function funnelOn(config: Record<string, unknown>): boolean {
  const allow = readRecord(config, 'AllowFunnel')
  if (allow !== null && Object.values(allow).some((value) => value === true)) return true
  const foreground = readRecord(config, 'Foreground')
  if (foreground === null) return false
  return Object.values(foreground).some((session) => isRecord(session) && funnelOn(session))
}

/** 대상 URL — 우리 서버 포트 숫자로만 만든다. */
export function serveTarget(serverPort: number): string {
  return `http://127.0.0.1:${serverPort}`
}

/**
 * 그 HTTPS 포트를 누가 쥐고 있나.
 * - `free` — `TCP[port]` 도, `Web["*:port"]` 도 없다
 * - `proxy` — 우리 모양 하나뿐: `TCP[port].HTTPS` 이고 그 포트의 Web 핸들러가 `/` 하나, `Proxy` 가 있다. **누구 것인지는 여기서 모른다** —
 *   소유권 기록과 대조는 부르는 쪽(`exposure.ts`)이 한다
 * - `other` — 그 밖 전부(파일·텍스트 핸들러, 여러 경로, TCP 포워드, 여러 호스트 이름)
 */
export type PortUse = { kind: 'free' } | { kind: 'proxy'; host: string; target: string } | { kind: 'other' }

export function portUse(input: { config: Record<string, unknown>; port: number }): PortUse {
  const tcp = readRecord(input.config, 'TCP')
  const tcpEntry = tcp === null ? null : tcp[String(input.port)]
  const web = readRecord(input.config, 'Web') ?? {}
  const webKeys = Object.keys(web).filter((key) => key.endsWith(`:${input.port}`))
  if (tcpEntry === undefined || tcpEntry === null) {
    return webKeys.length === 0 ? { kind: 'free' } : { kind: 'other' }
  }
  if (!isRecord(tcpEntry) || tcpEntry.HTTPS !== true || webKeys.length !== 1) return { kind: 'other' }
  const host = webKeys[0]!
  const site = web[host]
  const handlers = isRecord(site) ? readRecord(site, 'Handlers') : null
  if (handlers === null || Object.keys(handlers).length !== 1) return { kind: 'other' }
  const root = handlers['/']
  const target = isRecord(root) ? readString(root, 'Proxy') : null
  if (target === null) return { kind: 'other' }
  return { kind: 'proxy', host: host.slice(0, -`:${input.port}`.length), target }
}

// --- argv (상수 + 숫자만) ----------------------------------------------------------------------------------

export function statusArgs(): string[] {
  return ['status', '--json']
}

export function serveStatusArgs(): string[] {
  return ['serve', 'status', '--json']
}

export function serveAddArgs(input: { httpsPort: number; serverPort: number }): string[] {
  return ['serve', '--bg', '--yes', `--https=${checkedPort(input.httpsPort)}`, serveTarget(checkedPort(input.serverPort))]
}

/** 켤 때와 같은 포트 + `--set-path=/` + `off` — 그 핸들러 하나만 지운다(W2). */
export function serveRemoveArgs(input: { httpsPort: number }): string[] {
  return ['serve', '--yes', `--https=${checkedPort(input.httpsPort)}`, '--set-path=/', 'off']
}

function checkedPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`잘못된 포트 ${port}`)
  return port
}
