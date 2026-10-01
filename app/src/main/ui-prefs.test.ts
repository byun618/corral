// 폴백 번호가 **재기동에도 남는다** (LIFE-366 **C13**, 수정 라운드 8).
//
// 화면 쪽 왕복은 `fallback-ordinal.test.ts` 가 잡는다. 여기는 **파일 쪽**이다: 실제로 디스크에
// 쓰고, 새 스토어로 다시 읽는다. 반례(관문 ⑤)는 영속을 빼는 것이고, 그때 이 표가 무너진다.
//
// 손으로 고친 파일이 화면을 깨뜨리지 않는 것도 같이 본다 — `ui-prefs.json` 은 사용자가 열어
// 볼 수 있는 자리라 **모양을 확인하며** 읽어야 한다 (registry.ts 와 같은 결).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UiPrefsStore } from './ui-prefs.js'

let dir = ''
let file = ''
let saved: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l366-prefs-'))
  file = path.join(dir, 'ui-prefs.json')
  saved = process.env.CORRAL_UI_PREFS
  process.env.CORRAL_UI_PREFS = file
})

afterEach(() => {
  if (saved === undefined) delete process.env.CORRAL_UI_PREFS
  else process.env.CORRAL_UI_PREFS = saved
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('폴백 번호 영속 (C13)', () => {
  it('쓰고 → 새 스토어로 읽으면 **같은 배정표**다', () => {
    const first = new UiPrefsStore(dir)
    first.load()
    first.update({ tabOrdinals: [{ tabId: 'wA:t4', groupId: 'wA', ordinal: 2 }, { tabId: 'wA:t7', groupId: 'wA', ordinal: 1 }] })

    const second = new UiPrefsStore(dir)
    second.load()
    expect(second.get().tabOrdinals).toEqual([
      { tabId: 'wA:t4', groupId: 'wA', ordinal: 2 },
      { tabId: 'wA:t7', groupId: 'wA', ordinal: 1 },
    ])
  })

  it('앞 라운드가 쓰던 칸(폭·접힘)을 안 건드린다 — 부분 갱신이다', () => {
    const store = new UiPrefsStore(dir)
    store.load()
    store.update({ sidebarWidth: 320, sidebarCollapsed: true, collapsedRepos: ['/tmp/r'] })
    store.update({ tabOrdinals: [{ tabId: 'wA:t1', groupId: 'wA', ordinal: 1 }] })

    const next = new UiPrefsStore(dir)
    next.load()
    expect(next.get().sidebarWidth).toBe(320)
    expect(next.get().sidebarCollapsed).toBe(true)
    expect(next.get().collapsedRepos).toEqual(['/tmp/r'])
    expect(next.get().tabOrdinals).toHaveLength(1)
  })

  it('배정표가 없던 옛 파일도 읽힌다 — 빈 배열이 된다 (r7 동작)', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, sidebarWidth: 300, collapsedRepos: [], collapsedGroups: [] }))
    const store = new UiPrefsStore(dir)
    store.load()
    expect(store.get().tabOrdinals).toEqual([])
    expect(store.get().sidebarWidth).toBe(300)
  })

  it('망가진 칸은 버리고 **성한 칸만** 싣는다', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tabOrdinals: [
          { tabId: 'wA:t1', groupId: 'wA', ordinal: 1 },
          { tabId: 'wA:t2', groupId: 'wA', ordinal: '2' },
          { tabId: 'wA:t3', groupId: 'wA', ordinal: 1.5 },
          { tabId: 'wA:t4', groupId: 'wA' },
          'wA:t5',
          null,
        ],
      }),
    )
    const store = new UiPrefsStore(dir)
    store.load()
    expect(store.get().tabOrdinals).toEqual([{ tabId: 'wA:t1', groupId: 'wA', ordinal: 1 }])
  })

  it('파일 자체가 깨져 있으면 기본값이다 — 화면은 뜬다', () => {
    fs.writeFileSync(file, '{ 이건 JSON 이 아니다')
    const store = new UiPrefsStore(dir)
    store.load()
    expect(store.get()).toEqual({ sidebarWidth: null, sidebarCollapsed: false, collapsedRepos: [], collapsedGroups: [], expandedAgentGroups: [], tabOrdinals: [], groupLayouts: [], manualRepoOrder: [], manualWorktreeOrder: {} })
  })

  it('`get()` 이 준 배열을 고쳐도 스토어 안이 안 바뀐다 (복사본이다)', () => {
    const store = new UiPrefsStore(dir)
    store.load()
    store.update({ tabOrdinals: [{ tabId: 'wA:t1', groupId: 'wA', ordinal: 1 }] })
    const rows = store.get().tabOrdinals
    rows[0]!.ordinal = 99
    rows.push({ tabId: 'wA:t2', groupId: 'wA', ordinal: 2 })
    expect(store.get().tabOrdinals).toEqual([{ tabId: 'wA:t1', groupId: 'wA', ordinal: 1 }])
  })
})

describe('사이드바 수동 순서 영속 (LIFE-469 K4·K6)', () => {
  /** 469 이전(468 출고 직후) 사용자 파일 모양 — 키 구성은 raw/claude/k6-user-ui-prefs-keys.json, 값은 지어낸 것. */
  const LEGACY = {
    version: 1,
    sidebarWidth: 312,
    sidebarCollapsed: false,
    collapsedRepos: ['/r/b'],
    collapsedGroups: ['/r/a/wt'],
    expandedAgentGroups: ['/r/a'],
    tabOrdinals: [{ tabId: 'wA:t1', groupId: 'wA', ordinal: 1 }],
    groupLayouts: [{ worktree: '/r/a', tree: { kind: 'leaf' } }],
  }

  it('K6ⓐ 469 이전 파일 — 순서 칸이 비어 읽힌다(=기본 순서), 기존 칸은 그대로', () => {
    fs.writeFileSync(file, JSON.stringify(LEGACY))
    const store = new UiPrefsStore(dir)
    store.load()
    const { manualRepoOrder, manualWorktreeOrder, ...rest } = store.get()
    expect(manualRepoOrder).toEqual([])
    expect(manualWorktreeOrder).toEqual({})
    expect({ version: 1, ...rest }).toEqual(LEGACY)
  })

  it('K6ⓑ 469 이전 파일 → 첫 순서 저장 뒤 파일에 기존 칸이 바이트 값 그대로 남는다', () => {
    fs.writeFileSync(file, JSON.stringify(LEGACY))
    const store = new UiPrefsStore(dir)
    store.load()
    store.update({ manualRepoOrder: ['/r/a', '/r/b'], manualWorktreeOrder: { '/r/a': ['/r/a/wt'] } })
    const written: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(written).toEqual({ ...LEGACY, manualRepoOrder: ['/r/a', '/r/b'], manualWorktreeOrder: { '/r/a': ['/r/a/wt'] } })
  })

  it('K4ⓐ 순서를 쓰고 → 새 스토어로 읽으면 같은 순서다(재시작)', () => {
    const first = new UiPrefsStore(dir)
    first.load()
    first.update({ manualRepoOrder: ['/r/c', '/r/a', '/r/b'], manualWorktreeOrder: { '/r/a': ['/r/a/z', '/r/a/m'] } })
    const second = new UiPrefsStore(dir)
    second.load()
    expect(second.get().manualRepoOrder).toEqual(['/r/c', '/r/a', '/r/b'])
    expect(second.get().manualWorktreeOrder).toEqual({ '/r/a': ['/r/a/z', '/r/a/m'] })
  })

  it('K4ⓓ 손상된 순서 칸(타입 틀림·중복·NaN·null) — 성한 키만 남고 다른 칸은 살아남는다', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...LEGACY,
        manualRepoOrder: ['/r/a', 7, null, '/r/a', '', '/r/b', { x: 1 }],
        manualWorktreeOrder: { '/r/a': ['/r/a/1', NaN, '/r/a/1', '/r/a/2'], '/r/b': 'oops', '': ['/x'] },
      }),
    )
    const store = new UiPrefsStore(dir)
    store.load()
    expect(store.get().manualRepoOrder).toEqual(['/r/a', '/r/b'])
    expect(store.get().manualWorktreeOrder).toEqual({ '/r/a': ['/r/a/1', '/r/a/2'] })
    expect(store.get().sidebarWidth).toBe(312)
    expect(store.get().tabOrdinals).toEqual(LEGACY.tabOrdinals)
  })

  it('K4ⓓ 순서 칸이 통째로 다른 타입이면 빈 순서(=기본 순서)다', () => {
    fs.writeFileSync(file, JSON.stringify({ ...LEGACY, manualRepoOrder: 'abc', manualWorktreeOrder: [['/r/a']] }))
    const store = new UiPrefsStore(dir)
    store.load()
    expect(store.get().manualRepoOrder).toEqual([])
    expect(store.get().manualWorktreeOrder).toEqual({})
    expect(store.get().collapsedRepos).toEqual(['/r/b'])
  })

  it('`get()` 의 순서 목록을 고쳐도 스토어 안이 안 바뀐다', () => {
    const store = new UiPrefsStore(dir)
    store.load()
    store.update({ manualWorktreeOrder: { '/r/a': ['/r/a/1'] } })
    store.get().manualWorktreeOrder['/r/a']!.push('/r/a/2')
    expect(store.get().manualWorktreeOrder).toEqual({ '/r/a': ['/r/a/1'] })
  })
})
