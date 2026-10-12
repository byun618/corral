// LIFE-589 E7ⓑ — 가둠 양성 대조(단위). 같은 함수에 ① 안 경로 ② `..` 탈출 ③ 절대 경로 ④ 밖을 가리키는 링크 ⑤ 등록 안 된 루트 ⑥ 형 위반 + 접두사 함정.
// 「거절이 그 검사에서 났다」 는 사유 코드로 보인다. 그리고 접두사 검사를 `startsWith(root)` 로 약하게 바꾸면(변이) 함정이 통과됨을 `isInside` 대조로 보인다.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { confine, isInside, listDir } from './explorer-fs.js'

let base = ''
let root = ''

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l589-fs-')))
  root = path.join(base, 'wt')
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a')
  // 접두사 함정: 루트 `wt` 옆의 `wtx` — 문자열 접두사는 같다.
  fs.mkdirSync(path.join(base, 'wtx'))
  fs.writeFileSync(path.join(base, 'wtx', 'secret.txt'), 's')
  fs.writeFileSync(path.join(base, 'outside.txt'), 'o')
  fs.symlinkSync(path.join(base, 'wtx'), path.join(root, 'escape-dir'))
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(root, 'escape-file'))
  fs.symlinkSync('../..', path.join(root, 'src', 'deep', 'up')) // 조상(루트)을 가리키는 링크 — 루프 후보
  fs.symlinkSync('nowhere', path.join(root, 'broken'))
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('E7ⓑ confine', () => {
  const roots = (): string[] => [root]
  it('① 안 경로는 통과', async () => {
    expect(await confine({ roots: roots(), root, rel: 'src/a.ts' })).toMatchObject({ ok: true, rel: 'src/a.ts' })
    expect(await confine({ roots: roots(), root, rel: '' })).toMatchObject({ ok: true })
  })
  it('② `..` 탈출은 realpath 접두사 검사에서 거절(outside_root)', async () => {
    expect(await confine({ roots: roots(), root, rel: '../outside.txt' })).toMatchObject({ ok: false, code: 'outside_root' })
    expect(await confine({ roots: roots(), root, rel: 'src/../../outside.txt' })).toMatchObject({ ok: false, code: 'outside_root' })
  })
  it('없는 경로도 탈출이면 「없음」 이 아니라 outside_root', async () => {
    expect(await confine({ roots: roots(), root, rel: '../nope' })).toMatchObject({ ok: false, code: 'outside_root' })
    expect(await confine({ roots: roots(), root, rel: 'src/nope' })).toMatchObject({ ok: false, code: 'not_found' })
  })
  it('③ 절대 경로는 형 검사에서 거절', async () => {
    expect(await confine({ roots: roots(), root, rel: path.join(base, 'outside.txt') })).toMatchObject({ ok: false, code: 'invalid_argument' })
  })
  it('④ worktree 안 링크가 밖을 가리키면 outside_root', async () => {
    expect(await confine({ roots: roots(), root, rel: 'escape-dir' })).toMatchObject({ ok: false, code: 'outside_root' })
    expect(await confine({ roots: roots(), root, rel: 'escape-dir/secret.txt' })).toMatchObject({ ok: false, code: 'outside_root' })
    expect(await confine({ roots: roots(), root, rel: 'escape-file' })).toMatchObject({ ok: false, code: 'outside_root' })
  })
  it('⑤ 등록 안 된 루트는 not_worktree — 루트의 하위 경로를 루트로 줘도', async () => {
    expect(await confine({ roots: roots(), root: path.join(base, 'wtx'), rel: '' })).toMatchObject({ ok: false, code: 'not_worktree' })
    expect(await confine({ roots: roots(), root: path.join(root, 'src'), rel: '' })).toMatchObject({ ok: false, code: 'not_worktree' })
  })
  it('⑥ 형 위반 — 문자열 아님·NUL·너무 김', async () => {
    expect(await confine({ roots: roots(), root, rel: 42 })).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(await confine({ roots: roots(), root, rel: 'a\0b' })).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(await confine({ roots: roots(), root, rel: 'a'.repeat(5000) })).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(await confine({ roots: roots(), root: 7, rel: '' })).toMatchObject({ ok: false, code: 'not_worktree' })
  })
  it('접두사 함정 `/a/b` vs `/a/bc` — 구분자를 붙여 검사한다(변이 대조: 맨 startsWith 는 통과시킨다)', async () => {
    expect(await confine({ roots: roots(), root, rel: '../wtx/secret.txt' })).toMatchObject({ ok: false, code: 'outside_root' })
    const sibling = path.join(base, 'wtx', 'secret.txt')
    expect(isInside(root, sibling)).toBe(false)
    expect(sibling.startsWith(root)).toBe(true) // 약한 검사였다면 여기서 새었다
  })
})

describe('E2ⓗ 목록 — 링크 표시·루프 안전', () => {
  it('링크 상태: 안(ok)·밖(outside)·깨짐(broken)', async () => {
    const top = await listDir({ roots: [root], root, rel: '' })
    if (!top.ok) throw new Error(top.error)
    const byName = Object.fromEntries(top.entries.map((entry) => [entry.name, `${entry.kind}:${entry.link}`]))
    // 밖 링크는 경계 판정(realpath) 뒤 더 읽지 않는다 — 종류를 모르니 `file`(R1-A).
    expect(byName).toMatchObject({ src: 'dir:none', 'escape-dir': 'file:outside', 'escape-file': 'file:outside', broken: 'file:broken' })
    const deep = await listDir({ roots: [root], root, rel: 'src/deep' })
    if (!deep.ok) throw new Error(deep.error)
    expect(deep.entries).toEqual([{ name: 'up', kind: 'dir', link: 'ok' }])
  })
  it('조상 링크를 따라 몇 겹을 펼쳐도 한 번에 한 폴더만 읽고 끝난다(재귀 없음) — real 은 실경로(R1-G)', async () => {
    const nested = await listDir({ roots: [root], root, rel: 'src/deep/up/src/deep/up/src' })
    expect(nested).toMatchObject({ ok: true, real: 'src' })
    expect(await listDir({ roots: [root], root, rel: 'src/deep/up' })).toMatchObject({ ok: true, real: '' })
    expect(await listDir({ roots: [root], root, rel: 'src' })).toMatchObject({ ok: true, real: 'src' })
  })
  it('파일을 폴더로 읽으면 not_directory', async () => {
    expect(await listDir({ roots: [root], root, rel: 'src/a.ts' })).toMatchObject({ ok: false, code: 'not_directory' })
  })
})

// R1-A — 검사(realpath)와 접근(readdir) 사이 바꿔치기. 리뷰어 `main-probes.mts` 와 같은 주입: realpath 가 값을 돌려주기 직전에 파일시스템을 바꾼다.
describe('R1-A 가둠 TOCTOU — 접근 뒤 재확인', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })
  const swapAfterRealpath = (target: string, swap: () => void): void => {
    const original = fsp.realpath
    let swapped = false
    vi.spyOn(fsp, 'realpath').mockImplementation(async (p, options) => {
      const real = await original(p, options)
      if (String(p) === target && !swapped) {
        swapped = true
        swap()
      }
      return real
    })
  }
  const setup = (name: string): { wt: string; outside: string } => {
    const wt = path.join(base, `${name}-wt`)
    const outside = path.join(base, `${name}-outside`)
    fs.mkdirSync(path.join(wt, 'mid', 'safe'), { recursive: true })
    fs.writeFileSync(path.join(wt, 'mid', 'safe', 'inside.txt'), 'i')
    fs.mkdirSync(path.join(outside, 'safe'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'OUTSIDE_SECRET_NAME.txt'), 'o')
    fs.writeFileSync(path.join(outside, 'safe', 'OUTSIDE_SECRET_NAME.txt'), 'o')
    return { wt, outside }
  }

  it('최종 성분 교체 — 밖 이름을 돌려주지 않고 changed', async () => {
    const { wt, outside } = setup('final')
    swapAfterRealpath(path.join(wt, 'mid', 'safe'), () => {
      fs.renameSync(path.join(wt, 'mid', 'safe'), path.join(wt, 'mid', 'saved'))
      fs.symlinkSync(outside, path.join(wt, 'mid', 'safe'))
    })
    const result = await listDir({ roots: [wt], root: wt, rel: 'mid/safe' })
    expect(result).toMatchObject({ ok: false, code: 'changed' })
    expect(JSON.stringify(result)).not.toContain('OUTSIDE_SECRET_NAME')
  })

  it('중간 성분 교체 — 밖 이름을 돌려주지 않고 changed', async () => {
    const { wt, outside } = setup('middle')
    swapAfterRealpath(path.join(wt, 'mid', 'safe'), () => {
      fs.renameSync(path.join(wt, 'mid'), path.join(wt, 'mid-saved'))
      fs.symlinkSync(outside, path.join(wt, 'mid'))
    })
    const result = await listDir({ roots: [wt], root: wt, rel: 'mid/safe' })
    expect(result).toMatchObject({ ok: false, code: 'changed' })
    expect(JSON.stringify(result)).not.toContain('OUTSIDE_SECRET_NAME')
  })

  it('양성 대조 — 바꿔치기 없으면 같은 경로가 그대로 읽힌다', async () => {
    const { wt } = setup('plain')
    expect(await listDir({ roots: [wt], root: wt, rel: 'mid/safe' })).toEqual({ ok: true, dir: 'mid/safe', real: 'mid/safe', entries: [{ name: 'inside.txt', kind: 'file', link: 'none' }] })
  })

  it('밖을 가리키는 링크 항목은 밖을 stat 하지 않는다', async () => {
    const { wt, outside } = setup('nostat')
    fs.symlinkSync(outside, path.join(wt, 'out-link'))
    const statSpy = vi.spyOn(fsp, 'stat')
    const result = await listDir({ roots: [wt], root: wt, rel: '' })
    expect(result).toMatchObject({ ok: true })
    expect(statSpy.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith(outside))).toEqual([])
  })
})
