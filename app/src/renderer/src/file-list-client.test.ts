// LIFE-593 수정 r1 — 목록 요청 클라이언트: 취소된 요청의 늦은 성공이 더 새 목록을 덮지 않는다(R1-G-02) · 기억하는 목록 수 상한(R1-C-07).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedFileList, requestFileList } from './file-list-client.js'

type Pending = { input: { root: string; includeIgnored: boolean; requestId: string }; resolve: (value: unknown) => void }
let calls: Pending[] = []
const okOf = (root: string, files: string[]) => ({ ok: true, root, includeIgnored: false, paths: files.join('\0'), count: files.length, files, truncated: false, ms: 1 })

beforeEach(() => {
  calls = []
  vi.stubGlobal('window', {
    corral: {
      fileList: (input: Pending['input']) => new Promise((resolve) => calls.push({ input, resolve })),
      fileListCancel: vi.fn(),
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('file-list-client', () => {
  it('R1-G-02 취소된 앞 요청이 늦게 ok 로 와도 더 새 목록을 덮지 않고, 앞 요청은 cancelled 로 끝난다', async () => {
    const root = '/wt/g02'
    const first = requestFileList({ root, includeIgnored: false })
    first.cancel()
    const second = requestFileList({ root, includeIgnored: false })
    calls[1]?.resolve(okOf(root, ['new.ts']))
    const secondResult = await second.result
    expect(secondResult.ok).toBe(true)
    calls[0]?.resolve(okOf(root, ['old.ts']))
    const firstResult = await first.result
    expect(firstResult).toMatchObject({ ok: false, code: 'cancelled' })
    expect(cachedFileList({ root, includeIgnored: false })?.files).toEqual(['new.ts'])
  })
  it('R1-C-07 기억하는 목록은 최근 몇 개뿐이다(오래된 worktree 목록은 버린다)', async () => {
    for (let index = 0; index < 5; index += 1) {
      const root = `/wt/c07-${index}`
      const request = requestFileList({ root, includeIgnored: false })
      calls[calls.length - 1]?.resolve(okOf(root, [`f${index}.ts`]))
      await request.result
    }
    expect(cachedFileList({ root: '/wt/c07-0', includeIgnored: false })).toBeNull()
    expect(cachedFileList({ root: '/wt/c07-4', includeIgnored: false })?.files).toEqual(['f4.ts'])
  })
})
