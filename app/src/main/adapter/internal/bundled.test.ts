// LIFE-556 B2·B3·B6 단위 — 설치본 동봉 herdr 해소·폴더 이름·서버 env. 개발 실행 경로가 그대로인지도 같이 본다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_HERDR_APP_DIR, STOCK_HERDR_APP_DIR, bundledHerdrPath, bundledServerEnv, locateHerdr, serverEnv, type HerdrResolution } from './server.js'
import { herdrHome, listSessions } from './sessions.js'

const external = (): Promise<HerdrResolution> => Promise.resolve({ kind: 'found', binary: { path: '/opt/homebrew/bin/herdr', source: 'login-shell', version: null } })

describe('locateHerdr (B3·B5 — 설치본은 동봉 바이너리만)', () => {
  it('동봉 자리는 bin/ 이 아니라 backend/ 다 — shim 폴더를 PATH 에 올려도 herdr 가 풀리지 않는다', () => {
    expect(bundledHerdrPath('/Applications/corral.app/Contents/Resources')).toBe('/Applications/corral.app/Contents/Resources/backend/herdr')
  })
  it('설치본 + 동봉 실행 가능 → bundled, 외부 조회를 부르지 않는다', async () => {
    const spy = vi.fn(external)
    const result = await locateHerdr({ override: undefined, bundled: '/R/backend/herdr', isExecutable: () => true, external: spy })
    expect(result).toEqual({ kind: 'found', binary: { path: '/R/backend/herdr', source: 'bundled', version: null } })
    expect(spy).not.toHaveBeenCalled()
  })
  it('설치본인데 동봉이 없으면 missing(bundled) — brew·로그인 셸 herdr 로 새지 않는다', async () => {
    const spy = vi.fn(external)
    const result = await locateHerdr({ override: undefined, bundled: '/R/backend/herdr', isExecutable: () => false, external: spy })
    expect(result).toEqual({ kind: 'missing', searched: ['/R/backend/herdr'], bundled: true })
    expect(spy).not.toHaveBeenCalled()
  })
  it('개발 실행(bundled null)은 종전 외부 해소 그대로', async () => {
    const spy = vi.fn(external)
    const result = await locateHerdr({ override: undefined, bundled: null, isExecutable: () => true, external: spy })
    expect(spy).toHaveBeenCalledOnce()
    expect(result.kind === 'found' && result.binary.source).toBe('login-shell')
  })
  it('CORRAL_HERDR_BIN 은 어느 쪽에서도 먼저다 (측정 전용)', async () => {
    const result = await locateHerdr({ override: '/fake/herdr', bundled: '/R/backend/herdr', isExecutable: () => true, external })
    expect(result.kind === 'found' && result.binary).toEqual({ path: '/fake/herdr', source: 'env', version: null })
    const missing = await locateHerdr({ override: '/fake/herdr', bundled: null, isExecutable: () => false, external })
    expect(missing).toEqual({ kind: 'missing', searched: ['CORRAL_HERDR_BIN=/fake/herdr'], bundled: false })
  })
})

describe('bundledServerEnv (B2 — XDG 주입 없음, HERDR_* 전부 뺌)', () => {
  const input = {
    PATH: '/usr/bin', HOME: '/h', XDG_CONFIG_HOME: '/x', XDG_STATE_HOME: '/s', LANG: 'ko',
    HERDR_CONFIG_PATH: '/h/.config/herdr/config.toml', HERDR_LOG: 'debug', HERDR_SOCKET_PATH: '/h/.config/herdr/herdr.sock', CORRAL_SESSION: 's',
  }
  it('설정·로그 변수까지 HERDR_* 는 하나도 넘기지 않고, XDG 는 앱 env 그대로 둔다', () => {
    expect(bundledServerEnv(input)).toEqual({ PATH: '/usr/bin', HOME: '/h', XDG_CONFIG_HOME: '/x', XDG_STATE_HOME: '/s', LANG: 'ko', FORCE_HYPERLINK: '1' })
  })
  it('XDG 가 없으면 만들지 않는다', () => {
    const env = bundledServerEnv({ PATH: '/usr/bin', HOME: '/h' })
    expect(Object.keys(env).filter((key) => key.startsWith('XDG_'))).toEqual([])
  })
  it('개발 실행의 serverEnv 는 종전대로 설정 변수를 남긴다', () => {
    expect(serverEnv(input)).toMatchObject({ HERDR_CONFIG_PATH: '/h/.config/herdr/config.toml', HERDR_LOG: 'debug' })
  })
})

describe('LIFE-565 C6ⓗ — 서버 기동 env 에 FORCE_HYPERLINK=1 (worktree.open·create 첫 pane 용)', () => {
  it('serverEnv·bundledServerEnv 둘 다 싣는다 — 입력에 없어도', () => {
    expect(serverEnv({ PATH: '/usr/bin' })['FORCE_HYPERLINK']).toBe('1')
    expect(bundledServerEnv({ PATH: '/usr/bin' })['FORCE_HYPERLINK']).toBe('1')
  })
  it('사용자 env 의 같은 키는 덮어쓴다 — pane 단위 env 가 늘 1 을 싣으므로 서버 쪽만 존중하면 값이 갈린다', () => {
    expect(serverEnv({ PATH: '/usr/bin', FORCE_HYPERLINK: '0' })['FORCE_HYPERLINK']).toBe('1')
    expect(bundledServerEnv({ PATH: '/usr/bin', FORCE_HYPERLINK: '0' })['FORCE_HYPERLINK']).toBe('1')
  })
  it('다른 키는 더하지 않는다 — 빈 입력의 출력은 그 키 하나', () => {
    expect(serverEnv({})).toEqual({ FORCE_HYPERLINK: '1' })
    expect(bundledServerEnv({})).toEqual({ FORCE_HYPERLINK: '1' })
  })
  it('입력 env 객체를 바꾸지 않는다 — corral 앱 env(process.env)로 새지 않게', () => {
    const input: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    serverEnv(input)
    bundledServerEnv(input)
    expect(input).toEqual({ PATH: '/usr/bin' })
  })
})

describe('herdrHome·listSessions 폴백 (B2 — corral 쪽 폴더 해석)', () => {
  const saved = { xdg: process.env.XDG_CONFIG_HOME, dir: process.env.HERDR_CONFIG_DIR, socket: process.env.CORRAL_BACKEND_SOCKET, session: process.env.CORRAL_SESSION }
  afterEach(() => {
    for (const [key, value] of [['XDG_CONFIG_HOME', saved.xdg], ['HERDR_CONFIG_DIR', saved.dir], ['CORRAL_BACKEND_SOCKET', saved.socket], ['CORRAL_SESSION', saved.session]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  it('동봉 폴더 이름은 herdr·herdr-dev 가 아니다', () => {
    expect(BUNDLED_HERDR_APP_DIR).toBe('corral-herdr')
    expect([STOCK_HERDR_APP_DIR, 'herdr-dev']).not.toContain(BUNDLED_HERDR_APP_DIR)
  })
  it('XDG_CONFIG_HOME 이 있으면 그 아래, 없으면 ~/.config 아래 동봉 폴더', () => {
    process.env.XDG_CONFIG_HOME = '/x'
    expect(herdrHome(BUNDLED_HERDR_APP_DIR)).toBe('/x/corral-herdr')
    delete process.env.XDG_CONFIG_HOME
    expect(herdrHome(BUNDLED_HERDR_APP_DIR)).toBe(path.join(os.homedir(), '.config', 'corral-herdr'))
  })
  it('HERDR_CONFIG_DIR 덮어쓰기는 별도 설치 herdr 에만 — 동봉 폴더를 돌리지 않는다', () => {
    process.env.HERDR_CONFIG_DIR = '/elsewhere'
    delete process.env.XDG_CONFIG_HOME
    expect(herdrHome(STOCK_HERDR_APP_DIR)).toBe('/elsewhere')
    expect(herdrHome(BUNDLED_HERDR_APP_DIR)).toBe(path.join(os.homedir(), '.config', 'corral-herdr'))
  })
  it('파일시스템 폴백은 동봉 폴더만 본다 — 같은 XDG 에 herdr 소켓이 있어도 세지 않는다', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l556-'))
    try {
      delete process.env.CORRAL_BACKEND_SOCKET
      delete process.env.CORRAL_SESSION
      process.env.XDG_CONFIG_HOME = root
      fs.mkdirSync(path.join(root, 'herdr'))
      fs.writeFileSync(path.join(root, 'herdr', 'herdr.sock'), '')
      const bundled = await listSessions({ binary: null, appDir: BUNDLED_HERDR_APP_DIR })
      expect(bundled.sessions).toEqual([])
      fs.mkdirSync(path.join(root, 'corral-herdr'))
      fs.writeFileSync(path.join(root, 'corral-herdr', 'herdr.sock'), '')
      const again = await listSessions({ binary: null, appDir: BUNDLED_HERDR_APP_DIR })
      expect(again.sessions.map((session) => session.socketPath)).toEqual([path.join(root, 'corral-herdr', 'herdr.sock')])
      // 양성 대조 — 같은 자리를 stock 이름으로 보면 herdr 쪽 소켓이 잡힌다.
      const stock = await listSessions({ binary: null, appDir: STOCK_HERDR_APP_DIR })
      expect(stock.sessions.map((session) => session.socketPath)).toEqual([path.join(root, 'herdr', 'herdr.sock')])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
