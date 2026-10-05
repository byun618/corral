// Ghostty 구성 탐색·테마 해석·미리보기 (LIFE-513 K1·K3·K4) — 실제 파일을 임시 홈에 깔고 읽는다. 사용자 홈은 보지 않는다(env 를 주입한다).
// 순서 기대값은 Ghostty v1.3.1 `Config.zig` `loadDefaultFiles`(같은 폴더 `config.ghostty` 가 `config` 를 이긴다 — Orca 198 과 반대, D1).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, copySettings, type Settings } from '../../shared/terminal-settings.js'
import type { GhosttyImportPreview } from '../../shared/ghostty-import.js'
import { ghosttyConfigCandidates, type GhosttyPathEnv } from './discovery.js'
import { MAX_CONFIG_BYTES, diffAgainstCurrent, previewGhosttyImport } from './index.js'
import { MAX_THEME_BYTES, ghosttyThemeSearchDirs, resolveGhosttyTheme } from './theme-resolution.js'

let home = ''
let env: GhosttyPathEnv
const xdgDir = (): string => path.join(home, '.config', 'ghostty')
const appDir = (): string => path.join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty')
const resDir = (): string => path.join(home, 'ghostty-resources')

function put({ file, content }: { file: string; content: string }): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

const preview = (current: Settings = copySettings(DEFAULT_SETTINGS)): Promise<GhosttyImportPreview> => previewGhosttyImport({ env, current })

async function found(current?: Settings): Promise<Extract<GhosttyImportPreview, { status: 'found' }>> {
  const result = await preview(current)
  if (result.status !== 'found') throw new Error(`found 가 아님: ${JSON.stringify(result)}`)
  return result
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'l513-gh-'))
  // 리소스 폴더를 임시로 가리킨다 — 기본값(/Applications/Ghostty.app)을 테스트가 읽지 않게.
  env = { home, ghosttyResourcesDir: resDir() }
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('후보 경로·로드 순서(K1ⓐ)', () => {
  it('XDG config → XDG config.ghostty → AppSupport config → AppSupport config.ghostty', () => {
    expect(ghosttyConfigCandidates({ home: '/h' })).toEqual([
      '/h/.config/ghostty/config',
      '/h/.config/ghostty/config.ghostty',
      '/h/Library/Application Support/com.mitchellh.ghostty/config',
      '/h/Library/Application Support/com.mitchellh.ghostty/config.ghostty',
    ])
  })

  it('XDG_CONFIG_HOME 가 있으면 그 아래 ghostty, 빈 문자열이면 ~/.config', () => {
    expect(ghosttyConfigCandidates({ home: '/h', xdgConfigHome: '/x' }).slice(0, 2)).toEqual(['/x/ghostty/config', '/x/ghostty/config.ghostty'])
    expect(ghosttyConfigCandidates({ home: '/h', xdgConfigHome: '' })[0]).toBe('/h/.config/ghostty/config')
  })
})

describe('미리보기 — 파일 감지(K1ⓑⓒⓔ)', () => {
  it('파일 없음 → not-found', async () => {
    expect(await preview()).toEqual({ status: 'not-found' })
  })

  it('한쪽만 — 읽은 경로 하나', async () => {
    const file = put({ file: path.join(xdgDir(), 'config'), content: 'font-family = Menlo\nfont-size = 14\n' })
    const result = await found()
    expect(result.configPaths).toEqual([file])
    // 크기 14 는 기본값과 같아 diff 에서 빠진다(00-analysis A4).
    expect(result.diff).toEqual({ terminalFontFamily: 'Menlo' })
  })

  it('넷 다 — 로드 순서대로 모두 읽고 뒤가 이긴다(같은 폴더 config.ghostty 가 config 를 이긴다, D1)', async () => {
    const a = put({ file: path.join(xdgDir(), 'config'), content: 'font-size = 11\ncursor-style = bar\npalette = 0=#000001\n' })
    const b = put({ file: path.join(xdgDir(), 'config.ghostty'), content: 'font-size = 12\n' })
    const c = put({ file: path.join(appDir(), 'config'), content: 'font-size = 13\nfont-family = AppFont\npalette = 1=#000002\n' })
    const d = put({ file: path.join(appDir(), 'config.ghostty'), content: 'font-family = Last\n' })
    const result = await found()
    expect(result.configPaths).toEqual([a, b, c, d])
    expect(result.diff).toEqual({
      terminalFontSize: 13,
      terminalCursorStyle: 'bar',
      // font-family 은 파일을 넘어 누적되는 반복 키다 — 첫 값 AppFont 가 주 글꼴, Last 는 폴백(Ghostty 의미, D4).
      terminalFontFamily: 'AppFont',
      terminalColorOverrides: { black: '#000001', red: '#000002' },
    })
    expect(result.unsupported).toEqual([{ key: 'font-family', reason: '폴백 글꼴은 가져오지 않음: Last (주 글꼴 AppFont 만)' }])
  })

  it('XDG 두 파일만 — config.ghostty 가 이긴다', async () => {
    put({ file: path.join(xdgDir(), 'config'), content: 'font-size = 20\n' })
    put({ file: path.join(xdgDir(), 'config.ghostty'), content: 'font-size = 18\n' })
    expect((await found()).diff).toEqual({ terminalFontSize: 18 })
  })

  it('빈 파일(0바이트)은 읽지 않는다 — 경로 목록에 없다(D3, 이 사용자의 AppSupport config.ghostty)', async () => {
    const file = put({ file: path.join(xdgDir(), 'config'), content: 'font-family = Menlo\nfont-size = 14\n' })
    put({ file: path.join(appDir(), 'config.ghostty'), content: '' })
    expect((await found()).configPaths).toEqual([file])
  })

  it('빈 파일뿐이면 not-found', async () => {
    put({ file: path.join(appDir(), 'config.ghostty'), content: '' })
    expect(await preview()).toEqual({ status: 'not-found' })
  })

  it('디렉터리는 건너뛴다', async () => {
    fs.mkdirSync(path.join(xdgDir(), 'config'), { recursive: true })
    const file = put({ file: path.join(xdgDir(), 'config.ghostty'), content: 'font-size = 16\n' })
    expect((await found()).configPaths).toEqual([file])
    fs.rmSync(file)
    expect(await preview()).toEqual({ status: 'not-found' })
  })

  it('1MB 초과는 그 파일만 건너뛴다 — 다른 파일이 없으면 error(첫 오류 문구)', async () => {
    const big = put({ file: path.join(xdgDir(), 'config'), content: `font-size = 16\n${'#'.repeat(MAX_CONFIG_BYTES)}\n` })
    const result = await preview()
    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.error).toContain(big)
    const other = put({ file: path.join(appDir(), 'config'), content: 'font-size = 18\n' })
    const ok = await found()
    expect(ok.configPaths).toEqual([other])
    expect(ok.diff).toEqual({ terminalFontSize: 18 })
  })

  it('읽기 실패(권한 없음)는 그 파일만 건너뛴다', async () => {
    const locked = put({ file: path.join(xdgDir(), 'config'), content: 'font-size = 16\n' })
    fs.chmodSync(locked, 0o000)
    try {
      const result = await preview()
      expect(result.status).toBe('error')
      if (result.status === 'error') expect(result.error).toContain('구성을 읽을 수 없습니다')
      const other = put({ file: path.join(xdgDir(), 'config.ghostty'), content: 'font-size = 18\n' })
      expect((await found()).configPaths).toEqual([other])
    } finally {
      fs.chmodSync(locked, 0o600)
    }
  })

  it('XDG_CONFIG_HOME 이 가리키는 곳을 읽는다(~/.config 는 보지 않는다)', async () => {
    put({ file: path.join(xdgDir(), 'config'), content: 'font-size = 11\n' })
    const xdg = path.join(home, 'xdg')
    const file = put({ file: path.join(xdg, 'ghostty', 'config'), content: 'font-size = 22\n' })
    env = { ...env, xdgConfigHome: xdg }
    const result = await found()
    expect(result.configPaths).toEqual([file])
    expect(result.diff).toEqual({ terminalFontSize: 22 })
  })

  it('config-file 포함은 따라가지 않는다(K1ⓓ)', async () => {
    put({ file: path.join(xdgDir(), 'included'), content: 'font-size = 20\n' })
    put({ file: path.join(xdgDir(), 'config'), content: `config-file = ${path.join(xdgDir(), 'included')}\n` })
    const result = await found()
    expect(result.diff).toEqual({})
    expect(result.unsupported).toEqual([{ key: 'config-file', reason: '포함 파일은 따라가지 않음' }])
  })
})

describe('테마 해석(K3)', () => {
  it('탐색 폴더 — 사용자 테마 → GHOSTTY_RESOURCES_DIR/themes, 없으면 설치본 앱', () => {
    expect(ghosttyThemeSearchDirs({ home: '/h', ghosttyResourcesDir: '/r' })).toEqual(['/h/.config/ghostty/themes', '/r/themes'])
    expect(ghosttyThemeSearchDirs({ home: '/h' })[1]).toBe('/Applications/Ghostty.app/Contents/Resources/ghostty/themes')
  })

  it('사용자 폴더가 리소스 폴더를 가린다', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'Mine'), content: 'background = #111111\n' })
    put({ file: path.join(resDir(), 'themes', 'Mine'), content: 'background = #222222\n' })
    const result = await resolveGhosttyTheme({ name: 'Mine', env })
    expect(result.status === 'found' ? result.colors.get('background') : result).toEqual(['#111111'])
  })

  it('리소스 폴더에서 찾는다', async () => {
    put({ file: path.join(resDir(), 'themes', 'Bundled'), content: 'foreground = #eeeeee\n' })
    const result = await resolveGhosttyTheme({ name: 'Bundled', env })
    expect(result.status === 'found' ? result.colors.get('foreground') : result).toEqual(['#eeeeee'])
  })

  it('절대경로 허용', async () => {
    const file = put({ file: path.join(home, 'anywhere', 'abs-theme'), content: 'background = #333333\n' })
    const result = await resolveGhosttyTheme({ name: file, env })
    expect(result.status === 'found' ? result.colors.get('background') : result).toEqual(['#333333'])
  })

  it('없는 이름·경로 탈출 이름·크기 초과는 사유와 함께 실패', async () => {
    expect(await resolveGhosttyTheme({ name: 'Nope', env })).toMatchObject({ status: 'failed', reason: expect.stringContaining('찾을 수 없음') })
    for (const name of ['../evil', 'a/b', 'a\\b', '.', '..']) {
      expect(await resolveGhosttyTheme({ name, env })).toMatchObject({ status: 'failed', reason: expect.stringContaining('쓸 수 없음') })
    }
    put({ file: path.join(xdgDir(), 'themes', 'Huge'), content: `background = #000000\n${'#'.repeat(MAX_THEME_BYTES)}` })
    put({ file: path.join(resDir(), 'themes', 'Huge'), content: 'background = #ffffff\n' })
    // 사용자 폴더의 것이 크기 초과면 리소스 폴더로 넘어가지 않는다(가려진 테마를 몰래 쓰지 않는다).
    expect(await resolveGhosttyTheme({ name: 'Huge', env })).toMatchObject({ status: 'failed', reason: expect.stringContaining('너무 큼') })
  })

  it('테마에서는 색 키만 받는다 — 글꼴·창 키 밀반입 금지', async () => {
    put({ file: path.join(resDir(), 'themes', 'Sneaky'), content: 'background = #101010\nfont-size = 20\nfont-family = Evil\ntheme = Other\nconfig-file = /etc/passwd\npalette = 3=#303030\n' })
    const result = await resolveGhosttyTheme({ name: 'Sneaky', env })
    expect(result.status === 'found' ? [...result.colors.keys()] : result).toEqual(['background', 'palette'])
  })

  it('미리보기 — 테마 색은 기본값, 구성의 명시 키가 이기고, palette 는 테마 뒤에 구성 것(인덱스별로 구성이 이긴다)', async () => {
    put({ file: path.join(resDir(), 'themes', 'Night'), content: 'background = #000010\nforeground = #e0e0e0\npalette = 0=#000000\npalette = 1=#aa0000\nsplit-divider-color = #445566\nfont-size = 20\n' })
    put({ file: path.join(xdgDir(), 'config'), content: 'theme = Night\nbackground = #101010\npalette = 1=#ff0000\n' })
    const result = await found()
    expect(result.diff).toEqual({
      terminalDividerColorDark: '#445566',
      terminalColorOverrides: { background: '#101010', foreground: '#e0e0e0', black: '#000000', red: '#ff0000' },
    })
    expect(result.unsupported).toEqual([])
  })

  it('palette 리셋은 파일을 넘어 테마 palette 까지 지운다, 테마의 다른 색은 남는다(R1-01)', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'Test'), content: 'palette = 1=#112233\npalette = 3=#334455\nbackground = #123123\n' })
    put({ file: path.join(xdgDir(), 'config'), content: 'theme = Test\npalette = 2=#223344\n' })
    put({ file: path.join(xdgDir(), 'config.ghostty'), content: 'palette = ""\npalette = 4=#445566\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalColorOverrides: { background: '#123123', blue: '#445566' } })
    expect(result.unsupported).toEqual([])
  })

  it('Ghostty 거절 할당은 앞 파일 값을 지우지 않는다 — 두 파일(fix2 R2-01)', async () => {
    put({ file: path.join(xdgDir(), 'config'), content: 'font-size = 18\nbackground = #101010\n' })
    put({ file: path.join(xdgDir(), 'config.ghostty'), content: 'font-size = not-a-number\nbackground = #xyzxyz\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalFontSize: 18, terminalColorOverrides: { background: '#101010' } })
    expect(result.unsupported.map((entry) => entry.key)).toEqual(['font-size', 'background'])
  })

  it('Ghostty 거절 명시 값은 테마 색을 지우지 않는다 — 테마 위(fix2 R2-01)', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'T'), content: 'background = #123123\nforeground = #aabbcc\n' })
    put({ file: path.join(xdgDir(), 'config'), content: 'theme = T\nbackground = #xyzxyz\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalColorOverrides: { background: '#123123', foreground: '#aabbcc' } })
    expect(result.unsupported.map((entry) => entry.key)).toEqual(['background'])
  })

  it('테마 파일 안 반복 — 거절된 뒤 줄은 앞 줄을 지우지 않는다(fix2 R2-01)', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'T'), content: 'background = #123123\nbackground = #xyzxyz\npalette = 1=#111111\npalette = 1=#xyzxyz\n' })
    put({ file: path.join(xdgDir(), 'config'), content: 'theme = T\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalColorOverrides: { background: '#123123', red: '#111111' } })
  })

  it('음성 대조 — 두 파일에서 18 → 13.5 는 18 로 되돌리지 않는다(fix2 R2-01)', async () => {
    put({ file: path.join(xdgDir(), 'config'), content: 'font-size = 18\n' })
    put({ file: path.join(appDir(), 'config'), content: 'font-size = 13.5\n' })
    const result = await found()
    expect(result.diff).toEqual({})
    expect(result.unsupported).toEqual([{ key: 'font-size', reason: '정수만 받음 (반올림하지 않음, 범위 10~24 정수)' }])
  })

  it('light:/dark: 쌍 → 지원되지 않는 키(사유), 나머지는 그대로 가져온다', async () => {
    put({ file: path.join(xdgDir(), 'config'), content: 'theme = light:Day,dark:Night\nfont-size = 16\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalFontSize: 16 })
    expect(result.unsupported).toEqual([{ key: 'theme', reason: 'light:/dark: 쌍은 지원하지 않음 (corral 은 다크 테마 하나)' }])
  })

  it('해석 실패(Ghostty 미설치 — 리소스 폴더 없음) → 사유, 나머지는 그대로', async () => {
    put({ file: path.join(xdgDir(), 'config'), content: 'theme = Catppuccin Mocha\nfont-family = Menlo\nbackground = #1e1e2e\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalFontFamily: 'Menlo', terminalColorOverrides: { background: '#1e1e2e' } })
    expect(result.unsupported).toEqual([{ key: 'theme', reason: '테마 파일을 찾을 수 없음: Catppuccin Mocha (Ghostty 미설치이거나 없는 이름)' }])
  })
})

describe('diff — 현재 설정과 다른 칸만(K4ⓑⓓ)', () => {
  it('같은 값은 빠지고, 전부 같으면 빈 diff', async () => {
    put({ file: path.join(xdgDir(), 'config'), content: 'font-family = Menlo\nfont-size = 14\nbackground = #101010\n' })
    const current = { ...copySettings(DEFAULT_SETTINGS), terminalFontFamily: 'Menlo', terminalColorOverrides: { background: '#101010' } }
    const result = await found(current)
    expect(result.diff).toEqual({})
  })

  it('override 는 내용 비교 — 바뀌는 색만 diff 에 오른다(키 순서 무관)', () => {
    const current = { ...copySettings(DEFAULT_SETTINGS), terminalColorOverrides: { red: '#ff0000', background: '#101010' } }
    expect(diffAgainstCurrent({ patch: { terminalColorOverrides: { background: '#101010', red: '#ff0000' } }, current })).toEqual({})
    expect(diffAgainstCurrent({ patch: { terminalColorOverrides: { background: '#101010', foreground: '#eeeeee' } }, current })).toEqual({ terminalColorOverrides: { foreground: '#eeeeee' } })
  })

  it('미리보기는 아무것도 쓰지 않는다 — 구성 파일·현재 설정 객체 불변', async () => {
    const file = put({ file: path.join(xdgDir(), 'config'), content: 'font-family = Menlo\nbackground = #101010\n' })
    const before = fs.readFileSync(file)
    const current = copySettings(DEFAULT_SETTINGS)
    const snapshot = JSON.stringify(current)
    await found(current)
    expect(JSON.stringify(current)).toBe(snapshot)
    expect(fs.readFileSync(file).equals(before)).toBe(true)
    expect(fs.readdirSync(xdgDir())).toEqual(['config'])
  })
})
