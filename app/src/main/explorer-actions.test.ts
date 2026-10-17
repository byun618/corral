// LIFE-589 E6 — 우클릭 동작: 가둠을 지난 경로만 쓰고(E7), 터미널은 폴더/부모 cwd 로 입구 하나를 부른다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explorerAction, type ExplorerActionDeps } from './explorer-actions.js'

let base = ''
let root = ''

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l589-act-')))
  root = path.join(base, 'wt')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a')
  fs.writeFileSync(path.join(base, 'outside.txt'), 'o')
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

function fakeDeps(): { deps: ExplorerActionDeps; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    deps: {
      roots: () => [root],
      writeClipboard: (text) => calls.push(`clip:${text}`),
      showItemInFolder: (target) => calls.push(`reveal:${target}`),
      openShell: async ({ cwd }) => {
        calls.push(`shell:${cwd}`)
        return null
      },
    },
  }
}

describe('E6 메뉴 동작', () => {
  it('경로 복사 — 절대 / 상대', async () => {
    const { deps, calls } = fakeDeps()
    expect(await explorerAction(deps, { action: 'copyPath', root, rel: 'src/a.ts', isDir: false })).toEqual({ ok: true, value: path.join(root, 'src', 'a.ts') })
    expect(await explorerAction(deps, { action: 'copyRelativePath', root, rel: 'src/a.ts', isDir: false })).toEqual({ ok: true, value: 'src/a.ts' })
    expect(calls).toEqual([`clip:${path.join(root, 'src', 'a.ts')}`, 'clip:src/a.ts'])
  })
  it('터미널 — 파일이면 부모, 폴더면 그 폴더', async () => {
    const { deps, calls } = fakeDeps()
    await explorerAction(deps, { action: 'openTerminal', root, rel: 'src/a.ts', isDir: false })
    await explorerAction(deps, { action: 'openTerminal', root, rel: 'src', isDir: true })
    await explorerAction(deps, { action: 'openTerminal', root, rel: 'src/a.ts', isDir: false })
    expect(calls).toEqual([`shell:${path.join(root, 'src')}`, `shell:${path.join(root, 'src')}`, `shell:${path.join(root, 'src')}`])
  })
  it('Finder 에서 보기', async () => {
    const { deps, calls } = fakeDeps()
    await explorerAction(deps, { action: 'reveal', root, rel: 'src', isDir: true })
    expect(calls).toEqual([`reveal:${path.join(root, 'src')}`])
  })
})

describe('E7 가둠 — 거절이면 부수 효과 0', () => {
  it('탈출·미등록 루트·모르는 동작은 아무것도 안 부른다', async () => {
    const { deps, calls } = fakeDeps()
    expect(await explorerAction(deps, { action: 'copyPath', root, rel: '../outside.txt', isDir: false })).toMatchObject({ ok: false, code: 'outside_root' })
    expect(await explorerAction(deps, { action: 'reveal', root: base, rel: 'outside.txt', isDir: false })).toMatchObject({ ok: false, code: 'not_worktree' })
    expect(await explorerAction(deps, { action: 'openTerminal', root, rel: '..', isDir: true })).toMatchObject({ ok: false, code: 'outside_root' })
    expect(await explorerAction(deps, { action: 'delete', root, rel: 'src', isDir: true })).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(await explorerAction(deps, null)).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(calls).toEqual([])
  })
})
