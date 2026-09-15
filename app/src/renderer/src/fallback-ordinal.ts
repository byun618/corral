// 폴백 제목의 번호 `N` — **비어 있는 가장 작은 번호** (LIFE-366 C10, 수정 라운드 7).
//
// ## 무엇이 결함이었나
//
// r5 까지 폴백은 `terminal ${tab.number}` 였다. `TabRow.number` 는 herdr 표찰이고 **재사용이
// 없다** — 탭을 여럿 만들었다 닫으면 남은 하나가 `terminal 7` 로 뜬다. 사용자가 본 Orca 는
// 그 자리에서 `Terminal 1` 을 준다: 생성 시점에 **그때 비어 있는 가장 작은 번호**를 잡고
// 그 뒤로는 안 바꾼다 (`store/terminals/terminal-tab-creation.ts:25-38`).
//
// ```ts
// // Why: reuse the lowest free ordinal so a fresh terminal stays "Terminal 1"
// // after older tabs close, not a monotonic counter.
// ```
//
// ## 왜 렌더러가 들고 있나 — **herdr `tab.label` 에 쓰면 G5 가 되살아난다**
//
// Orca 는 배정값을 `tab.defaultTitle` 에 저장한다. corral 에는 그 자리가 없다. herdr 의
// `tab.label` 에 쓰면 `session-title.userLabel` 이 그 숫자를 **사용자가 준 이름**으로 읽어
// 맨 위 티어에 세운다 — `ai-title`·첫 발화·터미널 제목이 전부 가려지는 G5(수정 라운드 4)가
// 그대로 돌아온다. 그래서 **렌더러가 tabId→번호를 들고 있는다**
// (`05-orca-parity.md` §5.3 의 제약 문단).
//
// ## 두 규칙만 지키면 된다
//
//   ① **처음 본 순간 배정** — 그 순간 그 워크스페이스에서 비어 있는 가장 작은 번호
//   ② **한 번 배정한 번호는 그 탭이 닫힐 때까지 안 바뀐다** — 다른 탭이 닫혀도 그대로다.
//      여기가 `tab.number` 를 다시 세는 것과 갈리는 자리다: 매 렌더에 1..N 을 다시 매기면
//      옆 탭을 닫을 때마다 남은 탭의 폴백 제목이 **바뀐다**(G7 이 없앤 깜빡임의 폴백판).
//
// 번호 공간은 **워크스페이스 하나**다 — `tab.number` 가 그랬듯이. 갈래(`claude N`/`terminal N`)
// 별로 나누지 않는다: 갈래는 탭 수명 중에 바뀔 수 있고(셸 탭에서 에이전트를 띄운다), 그때
// 번호가 갈아끼워지면 ② 가 깨진다.
//
// **재기동에도 남는다** (C13, 수정 라운드 8). r7 은 "corral 에는 저장 자리가 없다" 고 적었는데
// 좁은 서술이었다 — herdr `tab.label` 이 막혀 있을 뿐(G5) 화면 영속 파일(`main/ui-prefs.ts`,
// `<userData>/ui-prefs.json`)이 있었다. 그 파일의 원칙("저장하는 것은 화면 UI 상태뿐")에 폴백
// 번호가 정확히 들어맞는다: herdr 는 이 번호를 모르고, 화면만 쓴다.
// 부팅 때 `hydrate` 로 싣고, 배정이 바뀔 때 `entries()` 를 그대로 저장한다 (App.tsx).

/** tabId → 폴백 번호 배정표. 렌더러 한 벌이 공유한다. */
export type OrdinalBook = {
  /** 이 탭의 번호. 처음 보는 탭이면 **그 순간 비어 있는 가장 작은 번호**를 배정한다. */
  ordinalFor: (input: { tabId: string; groupId: string }) => number
  /**
   * 살아 있는 탭만 남긴다 — 닫힌 탭이 쥐고 있던 번호가 여기서 풀린다.
   *
   * **지금 화면에 있는 워크스페이스 안에서만** 푼다 (`groupIds`). 안 그러면 재기동 직후처럼
   * 아직 아무 워크스페이스도 안 열린 순간에 `tabIds` 가 비어서 **실어 온 배정표가 통째로
   * 날아간다** — C13 이 화면에서 깨졌던 자리다(raw/claude/r8-ordinal-wipe.md).
   */
  keepOnly: (input: { tabIds: readonly string[]; groupIds: readonly string[] }) => void
  /** 저장된 배정표를 싣는다 (C13). **부팅 때 한 번**, 아무 탭도 그리기 전에 부른다. */
  hydrate: (rows: readonly { tabId: string; groupId: string; ordinal: number }[]) => void
  /** 지금 배정표 (검사·계측용). */
  entries: () => { tabId: string; groupId: string; ordinal: number }[]
}

export function createOrdinalBook(): OrdinalBook {
  const book = new Map<string, { groupId: string; ordinal: number }>()

  return {
    ordinalFor: ({ tabId, groupId }) => {
      const held = book.get(tabId)
      // 워크스페이스가 바뀌면(탭 이동) 옛 번호는 그 워크스페이스의 것이라 다시 배정한다.
      if (held !== undefined && held.groupId === groupId) return held.ordinal
      const used = new Set<number>()
      for (const [otherId, entry] of book) {
        if (otherId !== tabId && entry.groupId === groupId) used.add(entry.ordinal)
      }
      let ordinal = 1
      while (used.has(ordinal)) ordinal += 1
      book.set(tabId, { groupId, ordinal })
      return ordinal
    },
    hydrate: (rows) => {
      // 저장된 값이 **기준**이다 — 이 시점에 이미 배정된 게 있으면(부팅 경합) 저장값으로 덮는다.
      // 같은 번호가 둘이 되지 않게, 앞서 온 행이 이긴다.
      book.clear()
      for (const row of rows) {
        if (row.tabId.length === 0 || !Number.isInteger(row.ordinal) || row.ordinal < 1) continue
        if (book.has(row.tabId)) continue
        const taken = [...book.values()].some((entry) => entry.groupId === row.groupId && entry.ordinal === row.ordinal)
        if (taken) continue
        book.set(row.tabId, { groupId: row.groupId, ordinal: row.ordinal })
      }
    },
    keepOnly: ({ tabIds, groupIds }) => {
      const live = new Set(tabIds)
      const shown = new Set(groupIds)
      for (const [tabId, entry] of [...book.entries()]) {
        // 안 보이는 워크스페이스의 칸은 **그대로 둔다** — 그 탭들은 사라진 게 아니라
        // 아직 안 열렸을 뿐이다. 다시 열면 같은 번호로 돌아와야 한다 (C13).
        if (!shown.has(entry.groupId)) continue
        if (!live.has(tabId)) book.delete(tabId)
      }
    },
    entries: () =>
      [...book.entries()].map(([tabId, entry]) => ({ tabId, groupId: entry.groupId, ordinal: entry.ordinal })),
  }
}

/**
 * 렌더러가 공유하는 배정표 하나.
 *
 * 모듈 상수인 이유는 **사이드바와 탭바가 같은 번호를 그려야** 하기 때문이다 (B6 — 두 목록이
 * 갈라지면 같은 세션이 두 이름으로 보인다). 두 컴포넌트는 App 아래 서로 다른 가지에 있어
 * prop 으로 내리면 세 컴포넌트를 거쳐야 하고, 중간에서 한 번만 빠뜨려도 조용히 갈라진다.
 * 창이 하나뿐인 앱이라 전역 하나로 충분하다 — 테스트는 `createOrdinalBook()` 으로 자기 것을 판다.
 */
export const tabOrdinals = createOrdinalBook()
