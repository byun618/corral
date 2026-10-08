// LIFE-556 B14 분기 — 임시 HOME 에서 「Install CLI」·「Uninstall CLI」 의 규칙을 실제 파일로 본다.
// ⓐ 이미 이 번들 심링크 ⓑ 다른 corral(확인 거절·확인) ⓒ PATH 에 없음 ⓓ PATH 앞쪽이 가림 ⓔ Uninstall 은 이 번들일 때만.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cliTarget, inspectCliSlot, installCli, parseShellView, pathAdvice, uninstallCli, type ShellView } from './install-cli.js'

let home = ''
let shim = ''
let target = ''
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l556-home-')))
  shim = path.join(home, 'Applications/corral.app/Contents/Resources/bin/corral')
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.writeFileSync(shim, '#!/bin/sh\necho shim\n', { mode: 0o755 })
  target = cliTarget(home)
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

const onPath = (corral: string | null = null): (() => Promise<ShellView>) => async () => ({ path: ['/usr/bin', path.dirname(target)], corral: corral ?? target })
const neverAsk = vi.fn(async () => true)

describe('installCli', () => {
  it('없음 → 폴더를 만들고 심링크 하나, 셸 파일은 건드리지 않는다', async () => {
    const zshrc = path.join(home, '.zshrc')
    fs.writeFileSync(zshrc, '# user\n')
    const result = await installCli({ target, shim, confirmReplace: neverAsk, shellView: onPath() })
    expect(result).toEqual({ kind: 'installed', target, replaced: null, advice: { kind: 'ok' } })
    expect(fs.readlinkSync(target)).toBe(shim)
    expect(fs.readFileSync(zshrc, 'utf8')).toBe('# user\n')
    expect(fs.readdirSync(path.dirname(target))).toEqual(['corral'])
    expect(neverAsk).not.toHaveBeenCalled()
  })
  it('ⓐ 이미 이 번들 심링크 → 무변경·「이미 설치됨」, 확인을 묻지 않는다', async () => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(shim, target)
    const before = fs.lstatSync(target)
    const ask = vi.fn(async () => true)
    const result = await installCli({ target, shim, confirmReplace: ask, shellView: onPath() })
    expect(result.kind).toBe('already')
    expect(ask).not.toHaveBeenCalled()
    expect(fs.lstatSync(target).ino).toBe(before.ino)
  })
  it('ⓑ 다른 대상 심링크 — 거절하면 byte 그대로, 확인하면 교체', async () => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync('/opt/elsewhere/corral', target)
    const declined = await installCli({ target, shim, confirmReplace: async () => false, shellView: onPath() })
    expect(declined).toEqual({ kind: 'declined', target, current: '다른 곳을 가리키는 심링크 (→ /opt/elsewhere/corral)' })
    expect(fs.readlinkSync(target)).toBe('/opt/elsewhere/corral')
    const ask = vi.fn(async () => true)
    const replaced = await installCli({ target, shim, confirmReplace: ask, shellView: onPath() })
    expect(ask).toHaveBeenCalledWith('다른 곳을 가리키는 심링크 (→ /opt/elsewhere/corral)')
    expect(replaced.kind === 'installed' && replaced.replaced).toBe('다른 곳을 가리키는 심링크 (→ /opt/elsewhere/corral)')
    expect(fs.readlinkSync(target)).toBe(shim)
  })
  it('ⓑ 일반 파일 — 거절하면 원래 byte 그대로', async () => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const body = Buffer.from('#!/bin/sh\necho mine\n')
    fs.writeFileSync(target, body, { mode: 0o755 })
    const result = await installCli({ target, shim, confirmReplace: async () => false, shellView: onPath() })
    expect(result.kind).toBe('declined')
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(target).equals(body)).toBe(true)
  })
  it('디렉터리면 확인도 묻지 않고 거절', async () => {
    fs.mkdirSync(target, { recursive: true })
    const ask = vi.fn(async () => true)
    expect((await installCli({ target, shim, confirmReplace: ask, shellView: onPath() })).kind).toBe('refused')
    expect(ask).not.toHaveBeenCalled()
    expect(fs.statSync(target).isDirectory()).toBe(true)
  })
  it('ⓒ 대상 폴더가 로그인 셸 PATH 에 없으면 추가할 한 줄을 안내만 한다', async () => {
    const result = await installCli({ target, shim, confirmReplace: neverAsk, shellView: async () => ({ path: ['/usr/bin', '/bin'], corral: null }) })
    expect(result.kind === 'installed' && result.advice).toMatchObject({ kind: 'not-on-path', dir: path.dirname(target) })
    expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(false)
  })
  it('ⓓ PATH 앞쪽의 다른 corral 이 가리면 그 경로를 알린다', async () => {
    const result = await installCli({ target, shim, confirmReplace: neverAsk, shellView: onPath('/usr/local/bin/corral') })
    expect(result.kind === 'installed' && result.advice).toEqual({ kind: 'shadowed', by: '/usr/local/bin/corral' })
  })
  it('셸 조회 실패는 모름으로 낸다 — 설치는 그대로', async () => {
    const result = await installCli({ target, shim, confirmReplace: neverAsk, shellView: async () => null })
    expect(result.kind === 'installed' && result.advice).toEqual({ kind: 'unknown' })
  })
})

describe('uninstallCli ⓔ', () => {
  it('이 번들을 가리키는 심링크만 지운다', () => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(shim, target)
    expect(uninstallCli({ target, shim })).toEqual({ kind: 'removed', target })
    expect(fs.existsSync(target)).toBe(false)
    expect(uninstallCli({ target, shim })).toEqual({ kind: 'absent', target })
  })
  it('다른 대상 심링크·일반 파일은 그대로 둔다', () => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync('/opt/elsewhere/corral', target)
    expect(uninstallCli({ target, shim }).kind).toBe('kept')
    expect(fs.readlinkSync(target)).toBe('/opt/elsewhere/corral')
    fs.unlinkSync(target)
    fs.writeFileSync(target, 'mine')
    expect(uninstallCli({ target, shim }).kind).toBe('kept')
    expect(fs.readFileSync(target, 'utf8')).toBe('mine')
  })
  it('상대 심링크·중간 링크를 지나도 이 번들 shim 으로 풀리면 이 번들이다', () => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(path.relative(path.dirname(target), shim), target)
    expect(inspectCliSlot({ target, shim }).kind).toBe('ours')
  })
})

describe('pathAdvice·parseShellView', () => {
  it('PATH 항목의 끝 / 는 같은 폴더로 본다', () => {
    expect(pathAdvice({ target: '/h/.local/bin/corral', view: { path: ['/h/.local/bin/'], corral: '/h/.local/bin/corral' } })).toEqual({ kind: 'ok' })
  })
  it('잡음 섞인 셸 출력에서 PATH 와 corral 을 읽는다', () => {
    const MARK = '__CORRAL_CLI__'
    expect(parseShellView(`banner\n${MARK}/a:/b${MARK}/b/corral${MARK}tail`)).toEqual({ path: ['/a', '/b'], corral: '/b/corral' })
    expect(parseShellView(`${MARK}/a${MARK}${MARK}`)).toEqual({ path: ['/a'], corral: null })
    expect(parseShellView('no marks')).toBeNull()
  })
})
