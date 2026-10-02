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
import { DEFAULT_SIDEBAR_VIEW, sidebarViewToPrefs } from '../shared/sidebar-view.js'
import { UiPrefsStore, type UiPrefs } from './ui-prefs.js'

/** LIFE-470 이 더한 칸의 기본값 — 470 이전 파일을 읽으면 이 값으로 선다. */
// LIFE-478: 고정 칸(`pinnedWorktrees`)이 새로 생겨 옛 파일을 읽으면 빈 목록으로 선다 — 옛 칸 기본값과 같은 자리에 둔다.
const L470_DEFAULTS = { manualFlatOrder: [], pinnedWorktrees: [], ...sidebarViewToPrefs(DEFAULT_SIDEBAR_VIEW) }

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
    expect(store.get()).toEqual({ sidebarWidth: null, sidebarCollapsed: false, collapsedRepos: [], collapsedGroups: [], expandedAgentGroups: [], tabOrdinals: [], groupLayouts: [], manualRepoOrder: [], manualWorktreeOrder: {}, ...L470_DEFAULTS })
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
    expect({ version: 1, ...rest }).toEqual({ ...LEGACY, ...L470_DEFAULTS })
  })

  it('K6ⓑ 469 이전 파일 → 첫 순서 저장 뒤 파일에 기존 칸이 바이트 값 그대로 남는다', () => {
    fs.writeFileSync(file, JSON.stringify(LEGACY))
    const store = new UiPrefsStore(dir)
    store.load()
    store.update({ manualRepoOrder: ['/r/a', '/r/b'], manualWorktreeOrder: { '/r/a': ['/r/a/wt'] } })
    const written: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(written).toEqual({ ...LEGACY, manualRepoOrder: ['/r/a', '/r/b'], manualWorktreeOrder: { '/r/a': ['/r/a/wt'] }, ...L470_DEFAULTS })
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

describe('Workspace options 영속 (LIFE-470 K9)', () => {
  /** 469 출고 직후 사용자 파일의 키 구성(raw/claude/k9b-user-ui-prefs-keys.md) — 값은 지어낸 것. */
  const L469_BODY = {
    sidebarWidth: 300,
    sidebarCollapsed: false,
    collapsedRepos: ['/r/b'],
    collapsedGroups: [],
    expandedAgentGroups: ['/r/a/wt'],
    tabOrdinals: [{ tabId: 'wA:t1', groupId: 'wA', ordinal: 1 }],
    groupLayouts: [{ worktree: '/r/a', tree: { kind: 'leaf' } }],
    manualRepoOrder: ['/r/b', '/r/a'],
    manualWorktreeOrder: { '/r/a': ['/r/a/wt', '/r/a'] },
  }
  const L469 = { version: 1, ...L469_BODY }

  it('K9ⓑ 470 이전 파일 — 옵션 칸은 기본값(Manual·Project·필터 없음), 469 칸은 그대로', () => {
    fs.writeFileSync(file, JSON.stringify(L469))
    const store = new UiPrefsStore(dir)
    store.load()
    expect(store.get()).toEqual({ ...L469_BODY, ...L470_DEFAULTS })
    expect(store.get().sidebarSortBy).toBe('manual')
    expect(store.get().sidebarGroupBy).toBe('repo')
    expect(store.get().sidebarProjectOrderBy).toBe('manual')
  })

  it('K9ⓐ 모든 옵션을 쓰고 → 새 스토어로 읽으면 같은 값(재시작)', () => {
    fs.writeFileSync(file, JSON.stringify(L469))
    const first = new UiPrefsStore(dir)
    first.load()
    const patch: Partial<UiPrefs> = {
      sidebarGroupBy: 'none',
      sidebarSortBy: 'smart',
      sidebarProjectOrderBy: 'recent',
      sidebarRepoFilter: ['/r/a'],
      sidebarHideDefaultBranch: true,
      sidebarHideDetachedHead: true,
      manualFlatOrder: ['/r/a/wt', '/r/b'],
    }
    first.update(patch)
    const second = new UiPrefsStore(dir)
    second.load()
    expect(second.get()).toMatchObject(patch)
    expect(second.get().manualRepoOrder).toEqual(L469.manualRepoOrder)
  })

  it('K9ⓒ 옵션 하나를 써도 파일의 기존 칸은 값 그대로 남는다', () => {
    fs.writeFileSync(file, JSON.stringify(L469))
    const store = new UiPrefsStore(dir)
    store.load()
    store.update({ sidebarSortBy: 'name' })
    const written: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(written).toEqual({ ...L469, ...L470_DEFAULTS, sidebarSortBy: 'name' })
  })

  it('K9ⓓ 손상된 새 칸(타입 틀림·모르는 모드 문자열)은 칸마다 기본값, 다른 칸은 살아남는다', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...L469,
        sidebarGroupBy: 'status',
        sidebarSortBy: 42,
        sidebarProjectOrderBy: 'manual',
        sidebarRepoFilter: ['/r/a', 3, '', '/r/a', null],
        sidebarHideDefaultBranch: 'yes',
        sidebarHideDetachedHead: true,
        manualFlatOrder: 'nope',
      }),
    )
    const store = new UiPrefsStore(dir)
    store.load()
    const got = store.get()
    expect(got.sidebarGroupBy).toBe('repo')
    expect(got.sidebarSortBy).toBe('manual')
    expect(got.sidebarProjectOrderBy).toBe('manual')
    expect(got.sidebarRepoFilter).toEqual(['/r/a'])
    expect(got.sidebarHideDefaultBranch).toBe(false)
    expect(got.sidebarHideDetachedHead).toBe(true)
    expect(got.manualFlatOrder).toEqual([])
    expect(got.manualRepoOrder).toEqual(L469.manualRepoOrder)
    expect(got.tabOrdinals).toEqual(L469.tabOrdinals)
  })

  it('`get()` 의 필터 목록을 고쳐도 스토어 안이 안 바뀐다', () => {
    const store = new UiPrefsStore(dir)
    store.load()
    store.update({ sidebarRepoFilter: ['/r/a'] })
    store.get().sidebarRepoFilter.push('/x')
    expect(store.get().sidebarRepoFilter).toEqual(['/r/a'])
  })
})

describe('카드 표시 영속 (LIFE-477 K7)', () => {
  /** 470 출고 직후 사용자 파일의 키 구성(raw/claude/k7b-user-ui-prefs-keys.md, 17칸) — 값은 지어낸 것. */
  const L470 = {
    version: 1,
    sidebarWidth: 300,
    sidebarCollapsed: false,
    collapsedRepos: ['/r/b'],
    collapsedGroups: [],
    expandedAgentGroups: ['/r/a/wt'],
    tabOrdinals: [{ tabId: 'wA:t1', groupId: 'wA', ordinal: 1 }],
    groupLayouts: [{ worktree: '/r/a', tree: { kind: 'leaf' } }],
    manualRepoOrder: ['/r/b', '/r/a'],
    manualWorktreeOrder: { '/r/a': ['/r/a/wt', '/r/a'] },
    manualFlatOrder: ['/r/a/wt'],
    sidebarGroupBy: 'none',
    sidebarSortBy: 'recent',
    sidebarProjectOrderBy: 'recent',
    sidebarRepoFilter: ['/r/a'],
    sidebarHideDefaultBranch: true,
    sidebarHideDetachedHead: false,
  }
  const { version: _version, ...L470_BODY } = L470
  void _version

  it('K7ⓑ 477 이전 파일 — 카드 표시 칸은 기본값(Detailed·에이전트 활동 켬·Compact 에이전트), 470 칸은 그대로', () => {
    fs.writeFileSync(file, JSON.stringify(L470))
    const store = new UiPrefsStore(dir)
    store.load()
    expect(store.get()).toEqual({ ...L470_BODY, pinnedWorktrees: [], sidebarCardLayout: 'detailed', sidebarCardProperties: ['inline-agents'], sidebarAgentActivityLayout: 'compact' })
  })

  it('K7ⓐ 세 칸을 쓰고 → 새 스토어로 읽으면 같은 값(재시작)', () => {
    fs.writeFileSync(file, JSON.stringify(L470))
    const first = new UiPrefsStore(dir)
    first.load()
    const patch: Partial<UiPrefs> = { sidebarCardLayout: 'compact', sidebarCardProperties: [], sidebarAgentActivityLayout: 'full' }
    first.update(patch)
    const second = new UiPrefsStore(dir)
    second.load()
    expect(second.get()).toMatchObject(patch)
  })

  it('K7ⓒ 카드 표시 칸 하나를 써도 파일의 기존 칸은 값 그대로 남는다(전후 JSON 대조)', () => {
    fs.writeFileSync(file, JSON.stringify(L470))
    const store = new UiPrefsStore(dir)
    store.load()
    store.update({ sidebarAgentActivityLayout: 'full' })
    const written: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(written).toEqual({ ...L470, pinnedWorktrees: [], sidebarCardLayout: 'detailed', sidebarCardProperties: ['inline-agents'], sidebarAgentActivityLayout: 'full' })
  })

  it('K7ⓓ 손상된 새 칸(타입 틀림·모르는 값·모르는 속성 id)은 기본값/정규화, 다른 칸은 살아남는다', () => {
    fs.writeFileSync(file, JSON.stringify({ ...L470, sidebarCardLayout: 'dense', sidebarCardProperties: ['branch', 'inline-agents', 7, 'inline-agents'], sidebarAgentActivityLayout: 3 }))
    const store = new UiPrefsStore(dir)
    store.load()
    const got = store.get()
    expect(got.sidebarCardLayout).toBe('detailed')
    expect(got.sidebarCardProperties).toEqual(['inline-agents'])
    expect(got.sidebarAgentActivityLayout).toBe('compact')
    expect(got.sidebarGroupBy).toBe('none')
    expect(got.manualFlatOrder).toEqual(['/r/a/wt'])
    expect(got.expandedAgentGroups).toEqual(['/r/a/wt'])
  })

  it('K7ⓓ 속성 칸이 배열이 아니면 기본값, 빈 배열은 빈 배열(= 에이전트 활동 끔 — 198 `[]` 규칙)', () => {
    fs.writeFileSync(file, JSON.stringify({ ...L470, sidebarCardProperties: 'inline-agents' }))
    const a = new UiPrefsStore(dir)
    a.load()
    expect(a.get().sidebarCardProperties).toEqual(['inline-agents'])
    fs.writeFileSync(file, JSON.stringify({ ...L470, sidebarCardProperties: [] }))
    const b = new UiPrefsStore(dir)
    b.load()
    expect(b.get().sidebarCardProperties).toEqual([])
  })

  it('`get()` 의 속성 목록을 고쳐도 스토어 안이 안 바뀐다', () => {
    const store = new UiPrefsStore(dir)
    store.load()
    store.get().sidebarCardProperties.push('inline-agents')
    expect(store.get().sidebarCardProperties).toEqual(['inline-agents'])
  })
})

describe('고정 영속 (LIFE-478 K5ⓖ · 게이트 ⓪ Q1 — ui-prefs)', () => {
  /** 477 출고 뒤 사용자 파일의 키 구성(raw/claude/user-prefs-keys-before.md, 20칸) — 값은 지어낸 것. */
  const L477 = {
    version: 1,
    sidebarWidth: 280,
    sidebarCollapsed: false,
    collapsedRepos: [],
    collapsedGroups: [],
    expandedAgentGroups: ['/r/a/wt'],
    tabOrdinals: [{ tabId: 'wA:t1', groupId: 'wA', ordinal: 1 }],
    groupLayouts: [],
    manualRepoOrder: ['/r/a'],
    manualWorktreeOrder: { '/r/a': ['/r/a', '/r/a/wt'] },
    manualFlatOrder: [],
    sidebarGroupBy: 'repo',
    sidebarSortBy: 'manual',
    sidebarProjectOrderBy: 'manual',
    sidebarRepoFilter: [],
    sidebarHideDefaultBranch: false,
    sidebarHideDetachedHead: false,
    sidebarCardLayout: 'detailed',
    sidebarCardProperties: ['inline-agents'],
    sidebarAgentActivityLayout: 'compact',
  }
  const { version: _v, ...L477_BODY } = L477
  void _v

  it('ⓖ 477 모양 파일 — 고정은 빈 목록, 나머지 칸은 그대로(= 이전 빌드와 같은 사이드바)', () => {
    fs.writeFileSync(file, JSON.stringify(L477))
    const store = new UiPrefsStore(dir)
    store.load()
    expect(store.get()).toEqual({ ...L477_BODY, pinnedWorktrees: [] })
  })

  it('ⓖ 고정 목록을 쓰고 새 스토어로 읽으면 같은 값(재시작), 파일의 다른 칸은 값 그대로', () => {
    fs.writeFileSync(file, JSON.stringify(L477))
    const first = new UiPrefsStore(dir)
    first.load()
    first.update({ pinnedWorktrees: ['/r/a/wt', '/r/a'] })
    const second = new UiPrefsStore(dir)
    second.load()
    expect(second.get().pinnedWorktrees).toEqual(['/r/a/wt', '/r/a'])
    const written: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(written).toEqual({ ...L477, pinnedWorktrees: ['/r/a/wt', '/r/a'] })
  })

  it('ⓖ 손상된 고정 칸 — 문자열 아닌 값·빈 문자열·중복은 버리고 다른 칸은 산다', () => {
    fs.writeFileSync(file, JSON.stringify({ ...L477, pinnedWorktrees: ['/r/a/wt', 3, '', '/r/a/wt', null] }))
    const store = new UiPrefsStore(dir)
    store.load()
    expect(store.get().pinnedWorktrees).toEqual(['/r/a/wt'])
    expect(store.get().manualWorktreeOrder).toEqual(L477.manualWorktreeOrder)
    fs.writeFileSync(file, JSON.stringify({ ...L477, pinnedWorktrees: '/r/a/wt' }))
    const other = new UiPrefsStore(dir)
    other.load()
    expect(other.get().pinnedWorktrees).toEqual([])
  })

  it('`get()` 의 고정 목록을 고쳐도 스토어 안이 안 바뀐다', () => {
    const store = new UiPrefsStore(dir)
    store.load()
    store.get().pinnedWorktrees.push('/x')
    expect(store.get().pinnedWorktrees).toEqual([])
  })
})
