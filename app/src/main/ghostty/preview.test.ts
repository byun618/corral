// Ghostty 구성 탐색·테마 해석·미리보기 (LIFE-513 K1·K3·K4) — 실제 파일을 임시 홈에 깔고 읽는다. 사용자 홈은 보지 않는다(env 를 주입한다).
// 순서 기대값은 Ghostty v1.3.1 `Config.zig` `loadDefaultFiles`(같은 폴더 `config.ghostty` 가 `config` 를 이긴다 — Orca 198 과 반대, D1).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, copySettings, sanitizeSettingsPatch, type Settings } from '../../shared/terminal-settings.js'
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

describe('리뷰 r3 repro.mts·edge-fixtures.mts 테마·파일 사례 — 기대값 = Ghostty 의미(fix3)', () => {
  const good = { terminalColorOverrides: { background: '#abcdef', red: '#123456' } }
  const themeReject = (value: string): { key: string; reason: string } => ({ key: 'theme', reason: `"${value}" — Ghostty 테마 문법이 아님 (이름 하나 또는 light:이름,dark:이름) · Ghostty 도 받지 않아 이 줄은 무시됨` })
  beforeEach(() => { put({ file: path.join(xdgDir(), 'themes', 'Good'), content: 'background=#abcdef\npalette=1=#123456\n' }) })

  it.each<[string, string, Partial<Settings>, Array<{ key: string; reason: string }>]>([
    ['theme-valid-control', 'theme=Good', good, []],
    ['theme-invalid-incomplete-pair (R3-04)', 'theme=Good\ntheme=light:missing', good, [themeReject('light:missing')]],
    ['theme-invalid-struct (R3-04)', 'theme=Good\ntheme=garbage:value', good, [themeReject('garbage:value')]],
    ['theme-invalid-equal (R3-04)', 'theme=Good\ntheme=foo=bar', good, [themeReject('foo=bar')]],
    ['theme-reset-reject (R3-04)', 'theme=Good\ntheme=\ntheme=light:missing', {}, [themeReject('light:missing'), { key: 'theme', reason: '빈 값 — 기본값으로 되돌리는 설정은 가져오지 않음' }]],
    ['theme-valid-pair', 'theme=Good\ntheme=light:Good,dark:Good', {}, [{ key: 'theme', reason: 'light:/dark: 쌍은 지원하지 않음 (corral 은 다크 테마 하나)' }]],
    ['theme-colors-quoted-space (R3-01)', 'theme=Good\nbackground=" red "', { terminalColorOverrides: { red: '#123456' } }, [{ key: 'background', reason: 'hex 색만 받음 (#RRGGBB·RRGGBB·#RGB) — 색 이름·특수값은 지원하지 않음' }]],
  ])('%s', async (_name, content, diff, unsupported) => {
    put({ file: path.join(xdgDir(), 'config'), content })
    const result = await found()
    expect(result.diff).toEqual(diff)
    expect(result.unsupported).toEqual(unsupported)
  })

  it('불확정 = 가져오지 않음 — 따옴표가 든 light/dark 쌍이면 앞 테마도 안 가져오고 사유', async () => {
    put({ file: path.join(xdgDir(), 'config'), content: 'theme=Good\ntheme=light:"Good",dark:"Good"\nfont-size=16\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalFontSize: 16 })
    expect(result.unsupported).toEqual([{ key: 'theme', reason: '"light:"Good",dark:"Good"" — 따옴표·이스케이프가 든 light/dark 쌍 · Ghostty 해석을 확정할 수 없어 가져오지 않음' }])
  })

  it('edge: 두 파일 — 테마 위 font-size 18 · background, 뒤 파일 font-size=nope(거절)·background=" red "(X11 수용)', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'T'), content: 'background=#123456\npalette=1=#654321' })
    put({ file: path.join(xdgDir(), 'config'), content: 'theme=T\nfont-size=18\nbackground=#111111' })
    put({ file: path.join(xdgDir(), 'config.ghostty'), content: 'font-size=nope\nbackground=" red "' })
    const result = await found()
    expect(result.diff).toEqual({ terminalFontSize: 18, terminalColorOverrides: { red: '#654321' } })
    expect(result.unsupported).toEqual([{ key: 'font-size', reason: '숫자가 아님 · Ghostty 도 받지 않아 이 줄은 무시됨' }, { key: 'background', reason: 'hex 색만 받음 (#RRGGBB·RRGGBB·#RGB) — 색 이름·특수값은 지원하지 않음' }])
  })

  it('edge: 테마 파일 안 반복 — 뒤 줄 " #abcdef " 는 trim 해서 받는다', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'T'), content: 'background=#123456\nbackground=" #abcdef "' })
    put({ file: path.join(xdgDir(), 'config'), content: 'theme=T' })
    expect((await found()).diff).toEqual({ terminalColorOverrides: { background: '#abcdef' } })
  })

  it('edge: 테마 쌍·리셋·단독 light: — 쌍·리셋은 앞 테마 없음, 단독 light: 는 거절이라 앞 테마 유지', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'T'), content: 'background=#123456\npalette=1=#654321' })
    put({ file: path.join(xdgDir(), 'config'), content: 'theme=T\ntheme=light:T,dark:T' })
    expect((await found()).diff).toEqual({})
    put({ file: path.join(xdgDir(), 'config'), content: 'theme=T\ntheme=' })
    expect((await found()).diff).toEqual({})
    put({ file: path.join(xdgDir(), 'config'), content: 'theme=T\ntheme=light:T' })
    expect((await found()).diff).toEqual({ terminalColorOverrides: { background: '#123456', red: '#654321' } })
  })

  it('edge: 일반 파일 심볼릭 링크는 읽고 __proto__·constructor 는 그냥 모르는 키, 디렉터리 링크는 없음', async () => {
    const target = put({ file: path.join(home, 'link-target'), content: 'font-size=18\n__proto__=bad\nconstructor=bad' })
    fs.mkdirSync(xdgDir(), { recursive: true })
    fs.symlinkSync(target, path.join(xdgDir(), 'config'))
    const result = await found()
    expect(result.diff).toEqual({ terminalFontSize: 18 })
    expect(result.unsupported.map((entry) => entry.key)).toEqual(['__proto__', 'constructor'])
    fs.unlinkSync(path.join(xdgDir(), 'config'))
    fs.symlinkSync(xdgDir(), path.join(xdgDir(), 'config'))
    expect(await preview()).toEqual({ status: 'not-found' })
  })

  it('edge: override 패치의 __proto__·constructor 는 버리고, 빈 override 는 비움으로 받는다', () => {
    expect(sanitizeSettingsPatch(JSON.parse('{"terminalColorOverrides":{"__proto__":"#fff","constructor":"#aaa"}}')).accepted).toEqual({})
    expect(sanitizeSettingsPatch({ terminalColorOverrides: {} }).accepted).toEqual({ terminalColorOverrides: {} })
  })
})


describe('리뷰 r4 repro.mts·controls.mts 구성·테마 파일 사례 — 기대값 = Ghostty 의미(fix4 R4-01~03)', () => {
  const longComment = (bytes: number): string => `#${'x'.repeat(bytes - 1)}`
  const stopped = ({ file, line }: { file: string; line: number }): { key: string; reason: string } => ({ key: file, reason: `${file} ${line}번째 줄이 4094바이트를 넘어 Ghostty 처럼 그 뒤를 읽지 않음` })

  it.each<[string, string, Partial<Settings>]>([
    ['unicode-nbsp-color', 'background = #111111\nbackground = #222222\n', { terminalColorOverrides: { background: '#111111' } }],
    ['embedded-cr-font', 'font-size = 18\nfont-size =\r20\n', { terminalFontSize: 18 }],
    ['unicode-nbsp-reset', 'font-size = 18\nfont-size = \n', { terminalFontSize: 18 }],
    ['comment-limit-control', `font-size = 18\n${longComment(4094)}\nfont-size = 20\n`, { terminalFontSize: 20 }],
    ['leading-dot-percent', 'adjust-cell-height = .5%\n', { terminalLineHeight: 1.005 }],
    ['trailing-dot-percent', 'adjust-cell-height = 14.%\n', { terminalLineHeight: 1.14 }],
    ['percent-spelling-control', 'adjust-cell-height = 0.5%\n', { terminalLineHeight: 1.005 }],
    ['quoted-cr-nan', 'font-size = 18\nfont-size = "nan\r"\n', { terminalFontSize: 18 }],
  ])('구성 파일 %s', async (_name, content, diff) => {
    put({ file: path.join(xdgDir(), 'config'), content })
    expect((await found()).diff).toEqual(diff)
  })

  it('구성 파일 overlong-comment — 4095바이트 줄에서 그 파일은 멈추고(앞 할당 유지) 사유를 보인다', async () => {
    const file = put({ file: path.join(xdgDir(), 'config'), content: `font-size = 18\n${longComment(4095)}\nfont-size = 20\n` })
    const result = await found()
    expect(result.diff).toEqual({ terminalFontSize: 18 })
    expect(result.unsupported).toEqual([stopped({ file, line: 2 })])
  })

  it('긴 줄에서 멈춘 파일 뒤의 다른 후보 파일은 계속 읽는다(파일마다 LineIterator 를 새로 만든다)', async () => {
    const first = put({ file: path.join(xdgDir(), 'config'), content: `font-size = 18\n${longComment(5000)}\nfont-size = 20\nbackground = #111111\n` })
    put({ file: path.join(appDir(), 'config'), content: 'background = #222222\n' })
    const result = await found()
    expect(result.configPaths).toEqual([first, path.join(appDir(), 'config')])
    expect(result.diff).toEqual({ terminalFontSize: 18, terminalColorOverrides: { background: '#222222' } })
    expect(result.unsupported).toEqual([stopped({ file: first, line: 2 })])
  })

  it('멀티바이트 문자가 경계에 걸친 줄 — 4095바이트(글자 수 4093)면 멈춘다', async () => {
    const file = put({ file: path.join(xdgDir(), 'config'), content: `font-size = 18\n#${'x'.repeat(4091)}가\nfont-size = 20\n` })
    expect(await found()).toMatchObject({ diff: { terminalFontSize: 18 }, unsupported: [stopped({ file, line: 2 })] })
    put({ file, content: `font-size = 18\n#${'x'.repeat(4090)}가\nfont-size = 20\n` })
    expect(await found()).toMatchObject({ diff: { terminalFontSize: 20 }, unsupported: [] })
  })

  it('테마 파일 R4-01 — NBSP 가 붙은 뒤 값은 Ghostty 가 거절해 앞 값이 남는다', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'T'), content: 'background=#111111\nbackground= #222222\n' })
    put({ file: path.join(xdgDir(), 'config'), content: 'theme=T\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalColorOverrides: { background: '#111111' } })
    expect(result.unsupported).toEqual([{ key: 'background', reason: 'hex 색만 받음 (#RRGGBB·RRGGBB·#RGB) — 색 이름·특수값은 지원하지 않음 · Ghostty 도 받지 않아 이 줄은 무시됨' }])
  })

  it('테마 파일 R4-02 — 4095바이트 줄에서 테마 파일만 멈추고(앞 색 유지) 사유, 구성 파일은 끝까지 읽는다', async () => {
    const theme = put({ file: path.join(xdgDir(), 'themes', 'T'), content: `background=#111111\n${longComment(4095)}\nbackground=#222222\n` })
    put({ file: path.join(xdgDir(), 'config'), content: 'theme=T\nfont-size=18\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalFontSize: 18, terminalColorOverrides: { background: '#111111' } })
    expect(result.unsupported).toEqual([{ key: 'theme', reason: `${theme} 2번째 줄이 4094바이트를 넘어 Ghostty 처럼 그 뒤를 읽지 않음` }])
    put({ file: theme, content: `background=#111111\n${longComment(4094)}\nbackground=#222222\n` })
    expect(await found()).toMatchObject({ diff: { terminalFontSize: 18, terminalColorOverrides: { background: '#222222' } }, unsupported: [] })
  })

  it('구성 파일 긴 줄과 테마 파일은 따로 — 구성이 멈춰도 그 전에 나온 theme 은 끝까지 읽는다', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'T'), content: 'background=#111111\npalette=1=#123456\n' })
    const file = put({ file: path.join(xdgDir(), 'config'), content: `theme=T\n${longComment(4095)}\nbackground=#222222\n` })
    const result = await found()
    expect(result.diff).toEqual({ terminalColorOverrides: { background: '#111111', red: '#123456' } })
    expect(result.unsupported).toEqual([stopped({ file, line: 2 })])
  })

  it('BOM — 구성 파일은 건너뛰고(Config.loadReader 3886-3896) 테마 파일은 첫 줄 키에 남아 그 줄을 안 가져온다(loadTheme 4413-4418)', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'T'), content: '﻿background=#111111\npalette=1=#123456\n' })
    put({ file: path.join(xdgDir(), 'config'), content: '﻿theme=T\nfont-size=18\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalFontSize: 18, terminalColorOverrides: { red: '#123456' } })
    expect(result.unsupported).toEqual([])
  })

  it('controls — R3-04 마지막 수용 테마 · 불확정 테마 쌍은 가져오지 않음', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'T'), content: 'background=#123456\n' })
    for (const suffix of ['light:Missing', 'garbage:value', 'foo=bar']) {
      put({ file: path.join(xdgDir(), 'config'), content: `theme=T\ntheme=${suffix}\n` })
      expect((await found()).diff.terminalColorOverrides?.background).toBe('#123456')
    }
    put({ file: path.join(xdgDir(), 'config'), content: 'theme=T\ntheme=light:"T",dark:T\ntheme=T\nfont-size=18\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalFontSize: 18 })
    expect(result.unsupported[0]?.reason).toMatch(/확정할 수 없어/)
  })
})

describe('리뷰 r5 repro-enotdir.mts — 테마 위치 열기 오류 분류, 기대값 = Ghostty theme.zig 198-217(fix5 R5-01)', () => {
  const readFailed = (code: string): { key: string; reason: string } => ({ key: 'theme', reason: expect.stringMatching(new RegExp(`^테마 파일을 읽을 수 없음: ${code}`)) })

  it('사용자 themes 자리가 일반 파일(ENOTDIR) + 리소스에 같은 이름 → 사유·색 없음, font-size 는 가져옴', async () => {
    put({ file: path.join(xdgDir(), 'config'), content: 'theme = Night\nfont-size = 18\n' })
    put({ file: path.join(xdgDir(), 'themes'), content: 'this is a file, not a directory' })
    put({ file: path.join(resDir(), 'themes', 'Night'), content: 'background = #123456\n' })
    const result = await found()
    expect(result.diff).toEqual({ terminalFontSize: 18 })
    expect(result.unsupported).toEqual([readFailed('ENOTDIR')])
  })

  it('음성 대조 — 사용자 themes 폴더가 실제로 없으면(ENOENT) 리소스 테마로 넘어간다', async () => {
    put({ file: path.join(xdgDir(), 'config'), content: 'theme = Night\nfont-size = 18\n' })
    put({ file: path.join(resDir(), 'themes', 'Night'), content: 'background = #123456\n' })
    expect(await found()).toMatchObject({ diff: { terminalFontSize: 18, terminalColorOverrides: { background: '#123456' } }, unsupported: [] })
    fs.mkdirSync(path.join(xdgDir(), 'themes'))
    expect(await found()).toMatchObject({ diff: { terminalFontSize: 18, terminalColorOverrides: { background: '#123456' } }, unsupported: [] })
  })

  it('정규 파일 심볼릭 링크는 읽는다 · 끊긴 링크는 ENOENT 라 다음 위치로', async () => {
    const target = put({ file: path.join(home, 'elsewhere', 'Night'), content: 'background = #abcdef\n' })
    put({ file: path.join(resDir(), 'themes', 'Night'), content: 'background = #123456\n' })
    fs.mkdirSync(path.join(xdgDir(), 'themes'), { recursive: true })
    fs.symlinkSync(target, path.join(xdgDir(), 'themes', 'Night'))
    expect(await resolveGhosttyTheme({ name: 'Night', env })).toEqual({ status: 'found', colors: new Map([['background', ['#abcdef']]]), stopped: null })
    fs.unlinkSync(target)
    expect(await resolveGhosttyTheme({ name: 'Night', env })).toEqual({ status: 'found', colors: new Map([['background', ['#123456']]]), stopped: null })
  })

  it('테마 대상이 디렉터리 → 사유, 리소스로 넘어가지 않는다(theme.zig 「it is a directory」)', async () => {
    fs.mkdirSync(path.join(xdgDir(), 'themes', 'Night'), { recursive: true })
    put({ file: path.join(resDir(), 'themes', 'Night'), content: 'background = #123456\n' })
    expect(await resolveGhosttyTheme({ name: 'Night', env })).toEqual({ status: 'failed', reason: `테마 경로가 파일이 아님: ${path.join(xdgDir(), 'themes', 'Night')}` })
  })

  it('권한 오류(EACCES) → 사유, 리소스로 넘어가지 않는다', async () => {
    const file = put({ file: path.join(xdgDir(), 'themes', 'Night'), content: 'background = #abcdef\n' })
    put({ file: path.join(resDir(), 'themes', 'Night'), content: 'background = #123456\n' })
    fs.chmodSync(file, 0o000)
    try {
      expect(await resolveGhosttyTheme({ name: 'Night', env })).toEqual({ status: 'failed', reason: expect.stringMatching(/^테마 파일을 읽을 수 없음: EACCES/) })
    } finally {
      fs.chmodSync(file, 0o644)
    }
  })

  it('상한 초과 → 사유, 리소스로 넘어가지 않는다', async () => {
    put({ file: path.join(xdgDir(), 'themes', 'Night'), content: `background = #abcdef\n${'#'.repeat(MAX_THEME_BYTES)}` })
    put({ file: path.join(resDir(), 'themes', 'Night'), content: 'background = #123456\n' })
    expect(await resolveGhosttyTheme({ name: 'Night', env })).toMatchObject({ status: 'failed', reason: expect.stringContaining('너무 큼') })
  })

  it('같은 함수의 리소스 위치·절대경로도 Ghostty 와 같다 — 리소스 themes 가 일반 파일이면 ENOTDIR 사유, 절대경로 ENOTDIR 도 실패', async () => {
    put({ file: path.join(resDir(), 'themes'), content: 'file' })
    expect(await resolveGhosttyTheme({ name: 'Night', env })).toEqual({ status: 'failed', reason: expect.stringMatching(/^테마 파일을 읽을 수 없음: ENOTDIR/) })
    const notDir = put({ file: path.join(home, 'plain'), content: 'file' })
    expect(await resolveGhosttyTheme({ name: path.join(notDir, 'Night'), env })).toEqual({ status: 'failed', reason: expect.stringMatching(/^테마 파일을 읽을 수 없음: ENOTDIR/) })
    expect(await resolveGhosttyTheme({ name: path.join(home, 'absent', 'Night'), env })).toEqual({ status: 'failed', reason: `테마 파일을 찾을 수 없음: ${path.join(home, 'absent', 'Night')}` })
  })
})
