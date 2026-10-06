// LIFE-485 K1ⓐ·K2ⓐⓑⓓ·K4ⓖ — 바이너리 해소·재개 대상 계수·서버 환경·분리 기동의 실패 경로.
// 계수 입력은 `scripts/l477/session-restore-check.mjs --self-check` 의 합성 입력을 **전부** 그대로 옮겼다 —
// 같은 입력에 같은 판정(개수·모름)이 나와야 한다. 모름은 0 이 아니다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countRestoreTargets, isExecutableFile, parseShellLookup, readRestoreTargets, resolveHerdr, serverEnv, spawnServer } from './server.js'

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l485-srv-'))
})
afterEach(() => {
  fs.chmodSync(dir, 0o700)
  fs.rmSync(dir, { recursive: true, force: true })
})

function file(name: string, body: string, mode: number): string {
  const full = path.join(dir, name)
  fs.writeFileSync(full, body, { mode })
  fs.chmodSync(full, mode)
  return full
}

describe('resolveHerdr (K1ⓐ)', () => {
  it('로그인 셸 결과가 있고 실행 가능하면 그것', async () => {
    const result = await resolveHerdr({ loginShellLookup: async () => '/shell/herdr', candidates: ['/a/herdr'], isExecutable: () => true })
    expect(result).toEqual({ kind: 'found', binary: { path: '/shell/herdr', source: 'login-shell', version: null } })
  })
  it('로그인 셸 결과가 없으면 알려진 위치 중 실행 가능한 첫 것', async () => {
    const result = await resolveHerdr({ loginShellLookup: async () => null, candidates: ['/a/herdr', '/b/herdr', '/c/herdr'], isExecutable: (f) => f !== '/a/herdr' })
    expect(result).toEqual({ kind: 'found', binary: { path: '/b/herdr', source: 'known-location', version: null } })
  })
  it('로그인 셸 조회가 던지면(시한 초과 등) 알려진 위치로 간다', async () => {
    const result = await resolveHerdr({ loginShellLookup: async () => { throw new Error('timeout') }, candidates: ['/a/herdr'], isExecutable: () => true })
    expect(result.kind === 'found' && result.binary.source).toBe('known-location')
  })
  it('로그인 셸이 상대경로를 주면 믿지 않는다', async () => {
    const result = await resolveHerdr({ loginShellLookup: async () => 'herdr', candidates: [], isExecutable: () => true })
    expect(result.kind).toBe('missing')
  })
  it('전부 없으면 없음 + 찾아 본 위치', async () => {
    const result = await resolveHerdr({ loginShellLookup: async () => null, candidates: ['/a/herdr', '/b/herdr'], isExecutable: () => false })
    expect(result).toEqual({ kind: 'missing', searched: ['로그인 셸 command -v herdr', '/a/herdr', '/b/herdr'] })
  })
  it('실행 권한 없는 파일은 건너뛴다 — 실제 파일로', async () => {
    const plain = file('plain-herdr', '#!/bin/sh\n', 0o644)
    const exec = file('exec-herdr', '#!/bin/sh\n', 0o755)
    expect(isExecutableFile(plain)).toBe(false)
    expect(isExecutableFile(exec)).toBe(true)
    expect(isExecutableFile(dir)).toBe(false)
    expect(isExecutableFile(path.join(dir, 'none'))).toBe(false)
    const result = await resolveHerdr({ loginShellLookup: async () => plain, candidates: [plain, exec], isExecutable: isExecutableFile })
    expect(result).toEqual({ kind: 'found', binary: { path: exec, source: 'known-location', version: null } })
  })
  it('셸 출력의 잡음(배너·프롬프트) 사이에서 구분자 안만 읽는다', () => {
    expect(parseShellLookup('omz banner\n__CORRAL_HERDR__/opt/homebrew/bin/herdr__CORRAL_HERDR__\nbye')).toBe('/opt/homebrew/bin/herdr')
    expect(parseShellLookup('__CORRAL_HERDR____CORRAL_HERDR__')).toBe(null)
    expect(parseShellLookup('no marks')).toBe(null)
  })
})

// l477 self-check 입력 그대로
const agent = (kind: string) => ({ cwd: '/synthetic', agent_session: { agent: kind, kind: 'id', source: `herdr:${kind}`, value: 'x' } })
const shell = { cwd: '/synthetic' }
const current = (panes: Record<string, unknown>) => ({ version: 1, workspaces: [{ id: 'w1', identity_cwd: '/synthetic', tabs: [{ layout: { Pane: 1 }, panes }] }] })
const legacy = (panes: Record<string, unknown>) => ({ version: 1, workspaces: [{ id: 'w1', layout: { Pane: 1 }, panes, zoomed: false }] })

describe('countRestoreTargets (K2ⓐⓑⓓ)', () => {
  const cases: { name: string; input: unknown; total: number | 'unknown'; agents?: Record<string, number> }[] = [
    { name: '현재 형식 2개', input: current({ 1: shell, 2: agent('claude'), 3: agent('grok') }), total: 2, agents: { claude: 1, grok: 1 } },
    { name: '현재 형식 셸만', input: current({ 1: shell }), total: 0 },
    { name: '구형 1개', input: legacy({ 1: shell, 2: agent('claude') }), total: 1, agents: { claude: 1 } },
    { name: '구형 셸만', input: legacy({ 1: shell }), total: 0 },
    { name: '현재+구형 섞임', input: { version: 1, workspaces: [current({ 1: agent('claude') }).workspaces[0], legacy({ 1: agent('codex') }).workspaces[0]] }, total: 2, agents: { claude: 1, codex: 1 } },
    { name: '빈 workspaces', input: { version: 1, workspaces: [] }, total: 0 },
    { name: 'identity_cwd·layout 둘 다 없음', input: { version: 1, workspaces: [{ id: 'w1', panes: { 1: agent('claude') } }] }, total: 'unknown' },
    { name: '구형 + 덧붙은 빈 tabs', input: { version: 3, active: 0, selected: 0, workspaces: [{ layout: { Pane: 1 }, panes: { 1: { cwd: '/synthetic', agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: '11111111-1111-4111-8111-111111111111' } } }, zoomed: false, focused: 1, root_pane: 1, tabs: [] }] }, total: 1, agents: { claude: 1 } },
    { name: 'tabs 만', input: { version: 3, workspaces: [{ tabs: [] }] }, total: 'unknown' },
    { name: '현재 형식 tabs 가 객체', input: { version: 1, workspaces: [{ id: 'w1', identity_cwd: '/synthetic', tabs: {} }] }, total: 'unknown' },
    { name: '구형 panes 가 배열', input: { version: 1, workspaces: [{ id: 'w1', layout: { Pane: 1 }, panes: [] }] }, total: 'unknown' },
    { name: '현재 형식 tab 에 panes 없음', input: { version: 1, workspaces: [{ id: 'w1', identity_cwd: '/synthetic', tabs: [{ layout: { Pane: 1 } }] }] }, total: 'unknown' },
    { name: 'workspaces 가 객체', input: { version: 1, workspaces: { w1: {} } }, total: 'unknown' },
  ]
  for (const item of cases) {
    it(item.name, () => {
      const result = countRestoreTargets(JSON.stringify(item.input))
      if (item.total === 'unknown') {
        expect(result.known).toBe(false)
      } else {
        expect(result).toEqual({ known: true, total: item.total, agents: Object.entries(item.agents ?? {}).map(([kind, count]) => ({ kind, count })) })
      }
      // K2ⓓ — 경로·세션 id 가 출력에 없다
      const out = JSON.stringify(result)
      expect(out).not.toContain('/synthetic')
      expect(out).not.toContain('11111111-1111')
    })
  }
  it('파일 없음 → 0 (known)', () => {
    expect(countRestoreTargets(null)).toEqual({ known: true, total: 0, agents: [] })
    expect(readRestoreTargets(dir)).toEqual({ known: true, total: 0, agents: [] })
  })
  it('JSON 파싱 실패 → 모름 (0 아님)', () => {
    expect(countRestoreTargets('{ not json').known).toBe(false)
    fs.writeFileSync(path.join(dir, 'session.json'), '{"workspaces": [')
    expect(readRestoreTargets(dir).known).toBe(false)
  })
  it('세션 디렉터리를 모르면 모름', () => {
    expect(readRestoreTargets(null).known).toBe(false)
  })
  it('읽기 실패(권한) → 모름, 사유에 경로가 없다', () => {
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(current({ 1: agent('claude') })))
    fs.chmodSync(dir, 0o000)
    const result = readRestoreTargets(dir)
    fs.chmodSync(dir, 0o700)
    expect(result.known).toBe(false)
    expect(JSON.stringify(result)).not.toContain(dir)
  })
  it('디렉터리의 실제 파일을 센다', () => {
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(current({ 1: agent('grok'), 2: agent('grok'), 3: agent('claude') })))
    expect(readRestoreTargets(dir)).toEqual({ known: true, total: 3, agents: [{ kind: 'claude', count: 1 }, { kind: 'grok', count: 2 }] })
  })
})

describe('serverEnv (D4)', () => {
  it('corral·Electron·herdr·node 옵션 변수를 넘기지 않는다', () => {
    const env = serverEnv({ PATH: '/usr/bin', HOME: '/h', XDG_CONFIG_HOME: '/x', CORRAL_USER_DATA: '/u', CORRAL_SESSION: 's', ELECTRON_RUN_AS_NODE: '1', HERDR_CONFIG_PATH: '/c', NODE_OPTIONS: '--x', VITE_DEV: '1', LANG: 'ko' })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h', XDG_CONFIG_HOME: '/x', LANG: 'ko' })
  })
})

describe('spawnServer 실패 경로 (K4ⓖ)', () => {
  it('존재하지 않는 바이너리 → ok:false', () => {
    const result = spawnServer({ binary: path.join(dir, 'no-such-herdr'), logPath: path.join(dir, 'log', 'server.log'), onExit: () => undefined })
    expect(result.ok).toBe(false)
  })
  it('즉시 종료하는 바이너리 → onExit 가 불리고 로그에 원문이 남는다', async () => {
    const fake = file('fake-herdr', '#!/bin/sh\necho "fake herdr: boom $1" >&2\nexit 3\n', 0o755)
    const logPath = path.join(dir, 'server.log')
    const exited = new Promise<string>((resolve) => {
      const result = spawnServer({ binary: fake, logPath, onExit: (code, signal) => resolve(`${String(code)}/${String(signal)}`) })
      expect(result.ok).toBe(true)
    })
    expect(await exited).toBe('3/null')
    expect(fs.readFileSync(logPath, 'utf8')).toContain('fake herdr: boom server')
  })
  it('분리 기동 — 자식은 새 세션·그룹의 리더다', async () => {
    const fake = file('sleepy-herdr', '#!/bin/sh\nsleep 5\n', 0o755)
    const result = spawnServer({ binary: fake, logPath: path.join(dir, 'server.log'), onExit: () => undefined })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      const row = execFileSync('/bin/ps', ['-o', 'pid=,pgid=,sess=', '-p', String(result.pid)], { encoding: 'utf8' }).trim().split(/\s+/)
      expect(row[0]).toBe(String(result.pid))
      expect(row[1]).toBe(String(result.pid))
      expect(String(process.pid)).not.toBe(row[1])
    } finally {
      process.kill(result.pid, 'SIGKILL')
    }
  })
})
