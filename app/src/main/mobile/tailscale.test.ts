import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FUNNEL_PORTS,
  MOBILE_HTTPS_PORT,
  funnelOn,
  locateTailscale,
  parseNodeStatus,
  parseServeConfig,
  portUse,
  runTailscale,
  serveAddArgs,
  serveRemoveArgs,
} from './tailscale.js'

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/l577/fake-tailscale.mjs')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('전용 포트·argv [E7]', () => {
  it('전용 포트는 Funnel 허용 포트 밖', () => {
    expect(FUNNEL_PORTS).not.toContain(MOBILE_HTTPS_PORT)
  })

  it('추가·제거 argv 는 상수 + 숫자 — reset·funnel 없음, 제거는 같은 포트 + off', () => {
    const add = serveAddArgs({ httpsPort: MOBILE_HTTPS_PORT, serverPort: 51234 })
    const remove = serveRemoveArgs({ httpsPort: MOBILE_HTTPS_PORT })
    expect(add).toEqual(['serve', '--bg', '--yes', `--https=${MOBILE_HTTPS_PORT}`, 'http://127.0.0.1:51234'])
    expect(remove).toEqual(['serve', '--yes', `--https=${MOBILE_HTTPS_PORT}`, '--set-path=/', 'off'])
    for (const args of [add, remove]) {
      expect(args).not.toContain('reset')
      expect(args).not.toContain('funnel')
    }
    expect(() => serveAddArgs({ httpsPort: MOBILE_HTTPS_PORT, serverPort: 0 })).toThrow()
    expect(() => serveAddArgs({ httpsPort: 70000, serverPort: 1 })).toThrow()
  })
})

describe('status 읽기', () => {
  it('BackendState·DNS 이름(끝 점 제거)·CertDomains 에 자기 이름', () => {
    expect(parseNodeStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.t.ts.net.' }, CertDomains: ['mac.t.ts.net'] })))
      .toEqual({ running: true, backendState: 'Running', dnsName: 'mac.t.ts.net', https: true })
    expect(parseNodeStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.t.ts.net.' }, CertDomains: null }))?.https).toBe(false)
    expect(parseNodeStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.t.ts.net.' }, CertDomains: ['other.t.ts.net'] }))?.https).toBe(false)
    expect(parseNodeStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }))).toEqual({ running: false, backendState: 'NeedsLogin', dnsName: null, https: false })
    expect(parseNodeStatus('nope')).toBeNull()
  })

  it('serve 설정 — 빈 출력은 빈 설정, 모양 모름은 null', () => {
    expect(parseServeConfig('')).toEqual({})
    expect(parseServeConfig('{}')).toEqual({})
    expect(parseServeConfig('[]')).toBeNull()
    expect(parseServeConfig('x')).toBeNull()
  })
})

describe('Funnel 감지 [E1]', () => {
  it('최상위 AllowFunnel · Foreground 안 · 없음', () => {
    expect(funnelOn({})).toBe(false)
    expect(funnelOn({ AllowFunnel: { 'm:443': false } })).toBe(false)
    expect(funnelOn({ AllowFunnel: { 'm:443': true } })).toBe(true)
    expect(funnelOn({ Foreground: { a1: { AllowFunnel: { 'm:8443': true } } } })).toBe(true)
    expect(funnelOn({ Foreground: { a1: { TCP: {} } } })).toBe(false)
  })
})

describe('포트 사용 판정', () => {
  const port = MOBILE_HTTPS_PORT
  it('free · 우리 모양 proxy · 그 밖은 other', () => {
    expect(portUse({ config: {}, port })).toEqual({ kind: 'free' })
    expect(portUse({ config: { TCP: { '443': { HTTPS: true } }, Web: { 'm:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }, port })).toEqual({ kind: 'free' })
    expect(portUse({ config: { TCP: { [port]: { HTTPS: true } }, Web: { [`m:${port}`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } } } }, port }))
      .toEqual({ kind: 'proxy', host: 'm', target: 'http://127.0.0.1:1' })
    // 경로 여러 개 · 파일 핸들러 · TCP 포워드 · Web 만 있음
    expect(portUse({ config: { TCP: { [port]: { HTTPS: true } }, Web: { [`m:${port}`]: { Handlers: { '/': { Proxy: 'x' }, '/b': { Proxy: 'y' } } } } }, port }).kind).toBe('other')
    expect(portUse({ config: { TCP: { [port]: { HTTPS: true } }, Web: { [`m:${port}`]: { Handlers: { '/': { Path: '/tmp' } } } } }, port }).kind).toBe('other')
    expect(portUse({ config: { TCP: { [port]: { TCPForward: '127.0.0.1:22' } } }, port }).kind).toBe('other')
    expect(portUse({ config: { Web: { [`m:${port}`]: { Handlers: {} } } }, port }).kind).toBe('other')
  })
})

describe('CLI 찾기', () => {
  const yes = (): boolean => true
  it('override 가 있으면 그것만 — 없는 파일이면 없음(실제 CLI 로 내려가지 않는다)', async () => {
    let shellAsked = false
    const lookup = async (): Promise<string | null> => { shellAsked = true; return '/x/tailscale' }
    expect(await locateTailscale({ override: '/fake', candidates: ['/a'], isExecutable: (f) => f === '/fake', loginShellLookup: lookup })).toBe('/fake')
    expect(await locateTailscale({ override: '/missing', candidates: ['/a'], isExecutable: (f) => f === '/a', loginShellLookup: lookup })).toBeNull()
    expect(shellAsked).toBe(false)
  })

  it('알려진 위치 → 로그인 셸 순 (Finder 실행 PATH 없음 대비)', async () => {
    expect(await locateTailscale({ override: undefined, candidates: ['/a', '/b'], isExecutable: (f) => f === '/b', loginShellLookup: async () => null })).toBe('/b')
    expect(await locateTailscale({ override: undefined, candidates: ['/a'], isExecutable: (f) => f === '/s/tailscale', loginShellLookup: async () => '/s/tailscale' })).toBe('/s/tailscale')
    expect(await locateTailscale({ override: '', candidates: [], isExecutable: yes, loginShellLookup: async () => 'relative' })).toBeNull()
  })
})

describe('실행 타임아웃', () => {
  it('무응답 CLI 는 타임아웃에 그룹째 죽고 돌아온다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l577r-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ hang: ['status'] }))
    process.env.FAKE_TAILSCALE_DIR = dir
    const started = Date.now()
    const result = await runTailscale({ bin: FAKE, args: ['status', '--json'], timeoutMs: 300 })
    expect(result).toEqual({ ok: false, reason: 'timeout', detail: '300ms' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('abort 신호로 즉시 끝난다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l577r-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ hang: ['status'] }))
    process.env.FAKE_TAILSCALE_DIR = dir
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const result = await runTailscale({ bin: FAKE, args: ['status', '--json'], timeoutMs: 10_000, signal: controller.signal })
    expect(result).toMatchObject({ ok: false, reason: 'timeout', detail: 'aborted' })
  })

  it('정상 응답은 stdout 을 돌려준다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l577r-'))
    dirs.push(dir)
    process.env.FAKE_TAILSCALE_DIR = dir
    const result = await runTailscale({ bin: FAKE, args: ['version'], timeoutMs: 5000 })
    expect(result).toEqual({ ok: true, stdout: '1.102.2-fake\n' })
  })
})
