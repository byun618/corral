// LIFE-485 K1ⓐ·K2ⓐⓑⓓ·K4ⓖ — 바이너리 해소·재개 대상 계수·서버 환경·분리 기동의 실패 경로.
// 계수 입력은 LIFE-477 관문 `session-restore-check.mjs --self-check` 의 합성 입력을 **전부** 그대로 옮겼다 —
// 같은 입력에 같은 판정(개수·모름)이 나와야 한다. 모름은 0 이 아니다.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { countRestoreTargets, isExecutableFile, parseShellLookup, readRestoreTargets, resolveHerdr, rotateLog, serverEnv, spawnServer, stopProcessGroup, inspectServerProcess } from './server.js'

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
    expect(result).toEqual({ kind: 'missing', searched: ['로그인 셸 command -v herdr', '/a/herdr', '/b/herdr'], bundled: false })
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
    // r1 R1-02·G-2 — 비어 있지 않은 파일의 0 누출 경로
    { name: '[r1] 최상위 workspaces 없음(키 이름이 바뀐 버전)', input: { version: 9, spaces: [{ identity_cwd: '/synthetic', tabs: [{ panes: { 1: agent('claude') } }] }] }, total: 'unknown' },
    { name: '[r1] 빈 객체', input: {}, total: 'unknown' },
    { name: '[r1] 현재 형식 안 pane 이 객체 아님', input: current({ 1: 'pane', 2: agent('claude') }), total: 'unknown' },
    { name: '[r1] 구형 안 pane 이 null', input: legacy({ 1: null }), total: 'unknown' },
    { name: '[r1] agent_session 이 문자열', input: current({ 1: { cwd: '/synthetic', agent_session: 'claude' } }), total: 'unknown' },
    { name: '[r1] agent_session 이 배열', input: current({ 1: { cwd: '/synthetic', agent_session: [] } }), total: 'unknown' },
    { name: '[r1] agent_session null 은 셸', input: current({ 1: { cwd: '/synthetic', agent_session: null } }), total: 0 },
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

describe('serverEnv (D4·r1 R1-08)', () => {
  it('corral·Electron·node 옵션·herdr pane 범위 변수를 넘기지 않고, herdr 설정·로그 변수는 남긴다', () => {
    const env = serverEnv({
      PATH: '/usr/bin', HOME: '/h', XDG_CONFIG_HOME: '/x', LANG: 'ko',
      CORRAL_USER_DATA: '/u', CORRAL_SESSION: 's', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', VITE_DEV: '1',
      HERDR_ENV: '1', HERDR_SESSION: 'other', HERDR_SOCKET_PATH: '/s', HERDR_CLIENT_SOCKET_PATH: '/cs', HERDR_BIN_PATH: '/b',
      HERDR_WORKSPACE_ID: 'w', HERDR_TAB_ID: 't', HERDR_PANE_ID: 'p', HERDR_ACTIVE_PANE_ID: 'ap', HERDR_PLUGIN_ROOT: '/pr',
      HERDR_CONFIG_PATH: '/c', HERDR_LOG: 'debug',
      npm_config_prefix: '/p', npm_lifecycle_event: 'dev', npm_lifecycle_script: 'electron-vite dev', npm_package_name: 'corral',
    })
    // r2 R2-06 — npm_config_*·npm_lifecycle_* 는 빠진다(npm_package_* 는 범위 밖이라 남는다)
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/h', XDG_CONFIG_HOME: '/x', LANG: 'ko', HERDR_CONFIG_PATH: '/c', HERDR_LOG: 'debug', npm_package_name: 'corral', FORCE_HYPERLINK: '1' })
  })
  it('세션 마커는 넘기지 않고 허용 목록(CODEX_HOME·GROK_HOME·CLAUDE_CONFIG_DIR)은 남긴다 (LIFE-555 A5)', () => {
    const env = serverEnv({
      PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_PID: '9', CLAUDE_EFFORT: 'high', CLAUDE_CODE_ENTRYPOINT: 'cli', ORCA_AGENT_HOOK_PORT: '7',
      CODEX_HOME: '/h/.codex', GROK_HOME: '/h/.grok', CLAUDE_CONFIG_DIR: '/h/.claude',
    })
    expect(env).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/h/.codex', GROK_HOME: '/h/.grok', CLAUDE_CONFIG_DIR: '/h/.claude', FORCE_HYPERLINK: '1' })
  })
})

describe('LIFE-565 C6ⓗ — spawnServer 가 서버를 그 env 로 띄운다 (리뷰 C6R-01)', () => {
  /** 가짜 herdr: 자기 env 를 파일로 덤프하고 끝난다. 경로는 스크립트에 박는다 — env 로 넘기면 serverEnv 가 거를 수 있다. */
  async function spawnedEnv(bundled: boolean): Promise<Record<string, string>> {
    const dump = path.join(dir, `env-${bundled ? 'bundled' : 'stock'}.txt`)
    const fake = file(`env-herdr-${bundled ? 'b' : 's'}`, `#!/bin/sh\n/usr/bin/env > '${dump}'\n`, 0o755)
    await new Promise<void>((resolve, reject) => {
      const result = spawnServer({ binary: fake, logPath: path.join(dir, 'server.log'), onExit: () => resolve(), bundled })
      if (!result.ok) reject(new Error(result.error))
    })
    const out: Record<string, string> = {}
    for (const line of fs.readFileSync(dump, 'utf8').split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) out[line.slice(0, at)] = line.slice(at + 1)
    }
    return out
  }
  beforeEach(() => {
    // 앱 env 에는 FORCE_HYPERLINK 가 없고(있으면 process.env 를 그대로 넘겨도 통과한다), 번들이 지워야 할 HERDR_* 설정 변수는 있다.
    vi.stubEnv('FORCE_HYPERLINK', undefined)
    vi.stubEnv('HERDR_CONFIG_PATH', '/l565/herdr/config.toml')
    vi.stubEnv('CORRAL_USER_DATA', '/l565/ud')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })
  it('일반 분기 — 자식 env 에 FORCE_HYPERLINK=1, serverEnv 가 남기는 HERDR 설정 변수는 남고 CORRAL_* 는 빠진다', async () => {
    const env = await spawnedEnv(false)
    expect(env['FORCE_HYPERLINK']).toBe('1')
    expect(env['HERDR_CONFIG_PATH']).toBe('/l565/herdr/config.toml')
    expect(env['CORRAL_USER_DATA']).toBeUndefined()
  })
  it('번들 분기 — 자식 env 에 FORCE_HYPERLINK=1, HERDR_* 는 하나도 없다(bundledServerEnv)', async () => {
    const env = await spawnedEnv(true)
    expect(env['FORCE_HYPERLINK']).toBe('1')
    expect(Object.keys(env).filter((key) => key.startsWith('HERDR_'))).toEqual([])
    expect(env['CORRAL_USER_DATA']).toBeUndefined()
  })
})

describe('rotateLog (r1 R1-10)', () => {
  it('상한 이하면 그대로, 넘으면 .1 로 민다', () => {
    const log = path.join(dir, 'herdr-server.log')
    fs.writeFileSync(log, 'x'.repeat(10))
    expect(rotateLog(log, 100)).toBe(false)
    expect(fs.existsSync(log)).toBe(true)
    fs.writeFileSync(log, 'y'.repeat(200))
    fs.writeFileSync(`${log}.1`, 'old')
    expect(rotateLog(log, 100)).toBe(true)
    expect(fs.existsSync(log)).toBe(false)
    expect(fs.readFileSync(`${log}.1`, 'utf8')).toBe('y'.repeat(200))
  })
  it('파일이 없으면 아무것도 안 한다', () => {
    expect(rotateLog(path.join(dir, 'none.log'), 1)).toBe(false)
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

describe('spawnServer fd·stopProcessGroup (r2 R2-08·R2-01)', () => {
  it('로그를 열 수 없으면 ok:false (폴더 자리에 파일)', () => {
    const blocker = path.join(dir, 'blocked')
    fs.writeFileSync(blocker, '')
    const result = spawnServer({ binary: '/bin/true', logPath: path.join(blocker, 'server.log'), onExit: () => undefined })
    expect(result.ok).toBe(false)
  })
  it('열었는데 쓰지 못하면 그 fd 를 닫고 ok:false — writeSync 실패 분기를 실제로 밟는다 (r3 R3-03)', () => {
    const opened: number[] = []
    const closed: number[] = []
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      openSpy.mockRestore()
      const fd = fs.openSync(...args)
      opened.push(fd)
      return fd
    })
    const writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw new Error('ENOSPC 주입')
    })
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
      closed.push(fd)
      closeSpy.mockRestore()
      fs.closeSync(fd)
    })
    try {
      const result = spawnServer({ binary: '/bin/true', logPath: path.join(dir, 'w.log'), onExit: () => undefined })
      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toContain('로그 파일에 쓰지 못했다')
      expect(writeSpy).toHaveBeenCalledTimes(1)
      expect(opened.length).toBe(1)
      expect(closed).toEqual(opened)
    } finally {
      writeSpy.mockRestore()
      openSpy.mockRestore()
      closeSpy.mockRestore()
    }
  })
  it('시한 초과 자식의 프로세스 그룹을 끝낸다 — 손자까지', async () => {
    const fake = file('group-herdr', '#!/bin/sh\nsleep 30 &\necho $! > "$(dirname "$0")/grandchild.pid"\nexec sleep 30\n', 0o755)
    const result = spawnServer({ binary: fake, logPath: path.join(dir, 'g.log'), onExit: () => undefined })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    let grand = ''
    for (let i = 0; i < 40 && grand === ''; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      grand = fs.existsSync(path.join(dir, 'grandchild.pid')) ? fs.readFileSync(path.join(dir, 'grandchild.pid'), 'utf8').trim() : ''
    }
    expect(grand).not.toBe('')
    expect(await stopProcessGroup(result.pid, 1000)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
    expect(alive(result.pid)).toBe(false)
    expect(alive(Number(grand))).toBe(false)
  })
  it('이미 없는 pid 는 true', async () => {
    expect(await stopProcessGroup(999999, 10)).toBe(true)
  })
})

describe('inspectServerProcess — 남긴 자식의 신원 (r5 R5-01)', () => {
  const hangServer = (): string => {
    // `<경로> server` 로 보이고 그룹 리더인 가짜 — 짝 없는 FIFO 를 여는 cat 이 막혀 기다린다
    return file('hang-herdr', '#!/bin/bash\ncd "$(dirname "$0")" && { [ -p server ] || mkfifo server; } && exec -a "$0" cat server\n', 0o755)
  }
  it('그룹 리더 + `<binary> server` 면 ours', async () => {
    const bin = hangServer()
    const result = spawnServer({ binary: bin, logPath: path.join(dir, 'i.log'), onExit: () => undefined })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    let seen = { ours: false, detail: '' }
    for (let i = 0; i < 40 && !seen.ours; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      seen = await inspectServerProcess(result.pid, bin)
    }
    expect(seen).toEqual({ ours: true, detail: `${bin} server` })
    // 다른 경로로 해소했으면 우리 것이 아니다
    expect(await inspectServerProcess(result.pid, '/opt/homebrew/bin/herdr')).toEqual({ ours: false, detail: `명령 불일치: ${bin} server` })
    await stopProcessGroup(result.pid, 1000)
  })
  it('그룹 리더라도 명령이 다르면 ours 아님(번호 재사용 흉내) — 명령 불일치 분기', async () => {
    const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid ?? -1
    try {
      const result = await inspectServerProcess(pid, '/bin/sleep')
      expect(result.ours).toBe(false)
      expect(result.detail).toBe('명령 불일치: /bin/sleep 30')
    } finally {
      process.kill(pid, 'SIGKILL')
    }
  })
  it('그룹 리더가 아니면 ours 아님 — detached 아닌 자식(pgid = 부모 그룹 ≠ 자기 pid)', async () => {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    const pid = child.pid ?? -1
    try {
      // 명령까지 같게 줘도 그룹 리더 검사에서 먼저 떨어진다
      const result = await inspectServerProcess(pid, '/bin/sleep')
      expect(result.ours).toBe(false)
      expect(result.detail).toMatch(/^그룹 리더 아님 \(pgid \d+\)$/)
    } finally {
      child.kill('SIGKILL')
    }
  })
  it('없는 pid · 경로 모름', async () => {
    expect(await inspectServerProcess(999999, '/x')).toEqual({ ours: false, detail: 'pid 999999 없음' })
    expect(await inspectServerProcess(process.pid, null)).toEqual({ ours: false, detail: 'herdr 경로를 모른다' })
  })
})
