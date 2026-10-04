// LIFE-497 K1·K4 — 클립보드 이미지 → 임시 PNG, 그리고 정리가 corral 이 만든 파일만 지우는지.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { electronClipboardPng, isPasteFileName, pasteFileName, PASTE_FILE_MAX_AGE_MS, saveClipboardImage, sweepPasteFiles } from './clipboard-image.js'

const UUID = '0b6f6c2e-3a1d-4c55-9a8e-2f1d0c9b7a61'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l497-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('pasteFileName', () => {
  it('셸 메타문자·공백이 없는 이름이다 (K1ⓑ — raw 경로로 안전)', () => {
    const name = pasteFileName({ now: 1759600000000, uuid: UUID })
    expect(name).toBe(`corral-paste-1759600000000-${UUID}.png`)
    expect(name).toMatch(/^[a-zA-Z0-9_.@:-]+$/)
    expect(isPasteFileName(name)).toBe(true)
  })

  it('비슷하지만 corral 꼴이 아닌 이름은 corral 파일이 아니다', () => {
    for (const name of [`orca-paste-1-${UUID}.png`, 'corral-paste-1-abc.png', `corral-paste-1-${UUID}.png.bak`, `corral-paste-x-${UUID}.png`, 'Screenshot.png'])
      expect(isPasteFileName(name)).toBe(false)
  })
})

describe('electronClipboardPng', () => {
  const blobItem = (types: string[], bytes: Buffer) => ({ types, getType: async () => new Blob([new Uint8Array(bytes)]) })

  it('image/png 를 그대로 읽는다', async () => {
    const read = electronClipboardPng({ read: async () => [blobItem(['image/png'], PNG)], toPng: () => Buffer.alloc(0) })
    expect(await read()).toEqual(PNG)
  })

  it('다른 image/* 는 PNG 로 바꾼다', async () => {
    const read = electronClipboardPng({ read: async () => [blobItem(['image/jpeg'], Buffer.from([1]))], toPng: () => PNG })
    expect(await read()).toEqual(PNG)
  })

  it('이미지 항목이 없으면 null (텍스트·파일 참조만)', async () => {
    const read = electronClipboardPng({ read: async () => [blobItem(['text/plain', 'text/uri-list'], Buffer.from('x'))], toPng: () => PNG })
    expect(await read()).toBeNull()
  })

  it('변환 결과가 비면 null (디코드 실패)', async () => {
    const read = electronClipboardPng({ read: async () => [blobItem(['image/tiff'], Buffer.from([1]))], toPng: () => Buffer.alloc(0) })
    expect(await read()).toBeNull()
  })
})

describe('saveClipboardImage', () => {
  it('PNG 를 corral 폴더에 쓰고 절대경로를 준다', async () => {
    const target = path.join(dir, 'corral-paste')
    const result = await saveClipboardImage({ readPng: async () => PNG, dir: target, now: 5, uuid: UUID })
    expect(result).toEqual({ status: 'saved', path: path.join(target, `corral-paste-5-${UUID}.png`) })
    if (result.status === 'saved') expect(fs.readFileSync(result.path)).toEqual(PNG)
  })

  it('이미지가 없으면 empty — 파일을 만들지 않는다', async () => {
    const target = path.join(dir, 'corral-paste')
    expect(await saveClipboardImage({ readPng: async () => null, dir: target })).toEqual({ status: 'empty' })
    expect(fs.existsSync(target)).toBe(false)
  })

  it('읽기·쓰기 실패는 값으로 돌려준다 (K1ⓓ)', async () => {
    expect(await saveClipboardImage({ readPng: async () => { throw new Error('clipboard busy') }, dir })).toEqual({ status: 'failed', error: 'clipboard busy' })
    const blocked = path.join(dir, 'file')
    fs.writeFileSync(blocked, 'x')
    const result = await saveClipboardImage({ readPng: async () => PNG, dir: path.join(blocked, 'sub') })
    expect(result.status).toBe('failed')
  })
})

describe('sweepPasteFiles (K4ⓒ — corral 이 만든 파일만)', () => {
  const now = Date.now()
  const old = (file: string): void => {
    const at = new Date(now - PASTE_FILE_MAX_AGE_MS - 60_000)
    fs.utimesSync(file, at, at)
  }

  it('오래된 corral 파일만 지우고 사용자 파일·새 파일·하위 폴더·심링크는 남긴다', async () => {
    const oldOurs = path.join(dir, `corral-paste-1-${UUID}.png`)
    const freshOurs = path.join(dir, `corral-paste-2-${UUID}.png`)
    const userPng = path.join(dir, 'Screenshot 2026.png')
    const lookalike = path.join(dir, `orca-paste-1-${UUID}.png`)
    const sub = path.join(dir, `corral-paste-3-${UUID}.png`.replace('.png', ''))
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(outside)
    const outsideOurs = path.join(outside, `corral-paste-4-${UUID}.png`)
    for (const file of [oldOurs, freshOurs, userPng, lookalike, outsideOurs]) fs.writeFileSync(file, PNG)
    fs.mkdirSync(sub)
    const linkName = path.join(dir, `corral-paste-5-${UUID}.png`)
    fs.symlinkSync(outsideOurs, linkName)
    for (const file of [oldOurs, userPng, lookalike, outsideOurs]) old(file)
    fs.lutimesSync(linkName, new Date(now - PASTE_FILE_MAX_AGE_MS * 2), new Date(now - PASTE_FILE_MAX_AGE_MS * 2))

    const result = await sweepPasteFiles({ dir, now, maxAgeMs: PASTE_FILE_MAX_AGE_MS })

    expect(result.removed).toEqual([oldOurs])
    expect(result.kept).toBe(1)
    for (const file of [freshOurs, userPng, lookalike, outsideOurs, sub, linkName]) expect(fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()).toBe(true)
  })

  it('폴더가 없으면 아무것도 안 한다', async () => {
    expect(await sweepPasteFiles({ dir: path.join(dir, 'nope'), now, maxAgeMs: 1 })).toEqual({ removed: [], kept: 0 })
  })
})
