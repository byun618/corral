// 폴백 번호 배정 (LIFE-366 **C10**, 수정 라운드 7).
//
// 통과선이 요구하는 것은 둘이다 — **① 비어 있는 가장 작은 번호를 생성 시 배정** ② **기존 탭의
// 번호는 탭을 닫아도 안 바뀐다**. 둘을 한 표에서 같이 본다: ①만 있으면 매 렌더에 다시 세는
// 구현도 통과하는데, 그건 옆 탭을 닫을 때마다 남은 탭의 제목이 바뀌는 바로 그 결함이다.
//
// 반례(관문 ⑤ ⓒ)는 배정을 `tab.number` 로 되돌린 빌드다 — 탭 넷 중 둘을 닫고 새로 만들면
// 재사용이 없어 번호가 계속 올라간다. 아래 「닫고 다시 만든다」 칸이 그 자리다.

import { describe, expect, it } from 'vitest'
import { createOrdinalBook } from './fallback-ordinal.js'

const W = 'wA'

describe('폴백 번호 = 비어 있는 가장 작은 번호 (C10)', () => {
  it('처음 보는 순서대로 1부터 배정한다', () => {
    const book = createOrdinalBook()
    expect(book.ordinalFor({ tabId: 't1', groupId: W })).toBe(1)
    expect(book.ordinalFor({ tabId: 't2', groupId: W })).toBe(2)
    expect(book.ordinalFor({ tabId: 't3', groupId: W })).toBe(3)
  })

  it('한 번 배정한 번호는 **다시 물어도 같다** — 제목이 렌더마다 흔들리면 안 된다', () => {
    const book = createOrdinalBook()
    book.ordinalFor({ tabId: 't1', groupId: W })
    const second = book.ordinalFor({ tabId: 't2', groupId: W })
    expect(book.ordinalFor({ tabId: 't2', groupId: W })).toBe(second)
    expect(book.ordinalFor({ tabId: 't2', groupId: W })).toBe(second)
  })

  it('옆 탭이 닫혀도 **남은 탭의 번호는 안 바뀐다** (②)', () => {
    const book = createOrdinalBook()
    for (const tabId of ['t1', 't2', 't3', 't4']) book.ordinalFor({ tabId, groupId: W })
    book.keepOnly(['t3', 't4'])
    expect(book.ordinalFor({ tabId: 't3', groupId: W })).toBe(3)
    expect(book.ordinalFor({ tabId: 't4', groupId: W })).toBe(4)
  })

  it('닫고 다시 만들면 **빈 번호를 다시 쓴다** — 여기가 herdr 표찰(`TabRow.number`)과 갈린다 (①)', () => {
    const book = createOrdinalBook()
    for (const tabId of ['t1', 't2', 't3', 't4']) book.ordinalFor({ tabId, groupId: W })
    book.keepOnly(['t3', 't4']) // 1·2 가 풀린다
    expect(book.ordinalFor({ tabId: 't5', groupId: W })).toBe(1)
    expect(book.ordinalFor({ tabId: 't6', groupId: W })).toBe(2)
    expect(book.ordinalFor({ tabId: 't7', groupId: W })).toBe(5)
    // herdr 표찰이었다면 t5·t6 은 5·6 이었다 — 사용자가 본 `terminal 7` 이 그 모양이다.
  })

  it('가운데만 비면 **그 가운데**를 채운다 (가장 작은 빈 번호)', () => {
    const book = createOrdinalBook()
    for (const tabId of ['t1', 't2', 't3']) book.ordinalFor({ tabId, groupId: W })
    book.keepOnly(['t1', 't3'])
    expect(book.ordinalFor({ tabId: 't9', groupId: W })).toBe(2)
  })

  it('워크스페이스마다 번호 공간이 따로다 — 옆 워크스페이스가 번호를 안 먹는다', () => {
    const book = createOrdinalBook()
    expect(book.ordinalFor({ tabId: 't1', groupId: 'wA' })).toBe(1)
    expect(book.ordinalFor({ tabId: 't2', groupId: 'wB' })).toBe(1)
    expect(book.ordinalFor({ tabId: 't3', groupId: 'wA' })).toBe(2)
  })

  it('탭이 다른 워크스페이스로 옮겨가면 그쪽 번호를 새로 받는다', () => {
    const book = createOrdinalBook()
    book.ordinalFor({ tabId: 't1', groupId: 'wA' })
    book.ordinalFor({ tabId: 't2', groupId: 'wB' })
    expect(book.ordinalFor({ tabId: 't1', groupId: 'wB' })).toBe(2)
  })

  it('`keepOnly` 는 살아 있는 탭만 남긴다 — 배정표가 무한히 자라지 않는다', () => {
    const book = createOrdinalBook()
    for (const tabId of ['t1', 't2', 't3']) book.ordinalFor({ tabId, groupId: W })
    book.keepOnly(['t2'])
    expect(book.entries()).toEqual([{ tabId: 't2', groupId: W, ordinal: 2 }])
  })

  // --- C13: 재기동에도 남는다 (수정 라운드 8) -----------------------------------

  it('저장된 배정표를 실으면 **그 번호 그대로**다', () => {
    const book = createOrdinalBook()
    book.hydrate([
      { tabId: 't9', groupId: W, ordinal: 4 },
      { tabId: 't8', groupId: W, ordinal: 2 },
    ])
    expect(book.ordinalFor({ tabId: 't9', groupId: W })).toBe(4)
    expect(book.ordinalFor({ tabId: 't8', groupId: W })).toBe(2)
    // 그 뒤 새 탭은 여전히 **비어 있는 가장 작은 번호**를 받는다.
    expect(book.ordinalFor({ tabId: 't1', groupId: W })).toBe(1)
    expect(book.ordinalFor({ tabId: 't2', groupId: W })).toBe(3)
  })

  it('싣기 전에 이미 배정된 게 있어도 **저장값이 이긴다** (부팅 경합)', () => {
    const book = createOrdinalBook()
    book.ordinalFor({ tabId: 't9', groupId: W }) // 1 을 집었다
    book.hydrate([{ tabId: 't9', groupId: W, ordinal: 4 }])
    expect(book.ordinalFor({ tabId: 't9', groupId: W })).toBe(4)
  })

  it('저장 파일이 망가져 있어도 화면이 안 깨진다 — 같은 번호·이상한 값은 버린다', () => {
    const book = createOrdinalBook()
    book.hydrate([
      { tabId: 't1', groupId: W, ordinal: 1 },
      { tabId: 't2', groupId: W, ordinal: 1 }, // 중복 — 버린다
      { tabId: 't3', groupId: W, ordinal: 0 }, // 1 미만 — 버린다
      { tabId: '', groupId: W, ordinal: 2 }, // 빈 tabId — 버린다
    ])
    expect(book.entries()).toEqual([{ tabId: 't1', groupId: W, ordinal: 1 }])
    expect(book.ordinalFor({ tabId: 't2', groupId: W })).toBe(2)
  })

  it('`entries()` 가 그대로 저장되고 그대로 실린다 — 왕복이 값을 안 바꾼다', () => {
    const book = createOrdinalBook()
    for (const tabId of ['t1', 't2', 't3']) book.ordinalFor({ tabId, groupId: W })
    book.keepOnly(['t2', 't3'])
    const saved = JSON.parse(JSON.stringify(book.entries()))
    const next = createOrdinalBook()
    next.hydrate(saved)
    expect(next.entries()).toEqual(book.entries())
  })
})
