// 파일 탭 (LIFE-590 F2 · E1·E2) — 탭 **종류 구분**과 미리보기 규칙의 순수 함수.
//
// 탭은 영역 배치(`group-tree.ts`)에서 여전히 **문자열 id** 다. 종류는 id 가 말한다:
//   · 터미널 탭 = herdr `tab_id`(`w1:t1` 모양) — 살아 있는지는 herdr 가 정한다(`reconcileLayout`·`dropDeadTabs`)
//   · 파일 탭   = `file:<worktree 루트 기준 상대 경로>` — **배치 자체가 진실**이다(herdr 에 없다). 배치에 있으면 열려 있다
// 배치는 worktree 마다 따로 사므로 상대 경로만으로 유일하다(「파일 탭은 worktree 에 속한다」 — E1ⓑ). 한 worktree 의 한 파일은 배치 전체에서 탭 하나다
// (같은 id 는 `reconcileLayout` 이 중복으로 걷는다) — 이미 열린 파일을 다시 열면 그 탭이 있는 영역에서 그 탭이 활성이 된다(E1ⓐ·E2ⓒ).
//
// 문자열 id 를 유지하는 이유(하위 방향 E1ⓓ): 기준 commit 빌드가 새 형식 `ui-prefs.json` 을 읽으면 파일 탭 id 는 herdr 에 없는 탭으로 걸러지고
// 터미널 탭 배치·핀·색은 그대로 남는다 — 구 앱이 죽거나 터미널 배치를 버릴 모양(객체 id 등)을 만들지 않는다.
import { FILE_TAB_PREFIX, findGroup, groupOfTab, isFileTabId, listGroups, removeTabFromGroup, updateGroup, type GroupLayout, type TabGroup } from './group-tree.js'
import { remapRel } from '../../shared/explorer-ops.js'

export { FILE_TAB_PREFIX, isFileTabId }

export type TabKind = { kind: 'terminal'; tabId: string } | { kind: 'file'; tabId: string; rel: string }

export function fileTabId(rel: string): string {
  return `${FILE_TAB_PREFIX}${rel}`
}

export function tabKindOf(tabId: string): TabKind {
  return isFileTabId(tabId) ? { kind: 'file', tabId, rel: tabId.slice(FILE_TAB_PREFIX.length) } : { kind: 'terminal', tabId }
}

/** 파일 이름(탭 제목) — 경로 마지막 성분. */
/**
 * 터미널 pane 을 대상으로 하는 단축키(⌘D·⌘⇧D 분할 · ⌘⌥방향 인접 포커스 · ⌘⇧Z 줌)의 대상 — 활성 영역의 활성 탭이 **파일 탭이면 없음**(무동작).
 * 파일 탭으로 바꿔도 `selectedPane` 은 직전 터미널 pane 에 남아 있어, 그대로 쓰면 보이지 않는 터미널을 분할·줌한다(수정 r1 R1-B).
 */
export function terminalKeyTarget(input: { activeTabId: string | null; selectedPane: string | null }): string | null {
  return input.activeTabId !== null && isFileTabId(input.activeTabId) ? null : input.selectedPane
}

export function fileTabLabel(rel: string): string {
  const parts = rel.split('/')
  return parts[parts.length - 1] ?? rel
}

/** 그 영역의 미리보기 탭이 아직 그 영역에 있는 파일 탭일 때만 — 손으로 고친 파일·옛 값 대비. */
export function previewOf(group: TabGroup): string | null {
  const preview = group.previewTabId ?? null
  return preview !== null && isFileTabId(preview) && group.tabOrder.includes(preview) ? preview : null
}

/**
 * 파일을 연다 (E2 — VS Code `workbench.editor.enablePreview` 설명문·Orca `open-file-apply.ts` 와 같은 규칙).
 *   · 이미 열려 있으면(어느 영역이든) 그 영역에서 그 탭을 활성 — 미리보기면 `preview: false`(더블클릭) 일 때만 고정, `preview: true` 면 미리보기 그대로
 *   · 새로 열면 **활성 영역**에 — `preview: true` 이고 그 영역에 미리보기 탭이 있으면 **그 자리에서 교체**(고정 탭은 교체 안 됨),
 *     없으면 활성 탭 바로 오른쪽(VS Code `workbench.editor.openPositioning: right`)
 * 교체로 밀려난 파일은 `replaced` 로 돌려준다 — 부르는 쪽이 닫은 탭 기록(⌘⇧T)에 넣는다(Orca 와 같다).
 */
export function openFileTab(input: { layout: GroupLayout; rel: string; preview: boolean }): { layout: GroupLayout; replaced: { rel: string; groupId: string; index: number } | null } {
  const { layout, preview } = input
  const tabId = fileTabId(input.rel)
  const owner = groupOfTab(layout.root, tabId)
  if (owner !== null) {
    const pinNow = !preview && previewOf(owner) === tabId
    const next = updateGroup(layout, owner.groupId, (group) => ({ ...group, activeTabId: tabId, previewTabId: pinNow ? null : (group.previewTabId ?? null) }))
    return { layout: { ...next, activeGroupId: owner.groupId }, replaced: null }
  }
  const target = findGroup(layout.root, layout.activeGroupId) ?? listGroups(layout.root)[0]
  if (target === undefined) return { layout, replaced: null }
  const current = previewOf(target)
  let replaced: { rel: string; groupId: string; index: number } | null = null
  const next = updateGroup(layout, target.groupId, (group) => {
    if (preview && current !== null) {
      const index = group.tabOrder.indexOf(current)
      replaced = { rel: current.slice(FILE_TAB_PREFIX.length), groupId: group.groupId, index }
      const tabOrder = group.tabOrder.map((id) => (id === current ? tabId : id))
      return { ...group, tabOrder, activeTabId: tabId, previewTabId: tabId }
    }
    const at = group.activeTabId === null ? group.tabOrder.length : group.tabOrder.indexOf(group.activeTabId) + 1
    const tabOrder = [...group.tabOrder.slice(0, at), tabId, ...group.tabOrder.slice(at)]
    return { ...group, tabOrder, activeTabId: tabId, previewTabId: preview ? tabId : (group.previewTabId ?? null) }
  })
  return { layout: { ...next, activeGroupId: target.groupId }, replaced }
}

/** 미리보기 탭을 고정한다(탭 더블클릭·탐색기 더블클릭 — E2ⓐ). 미리보기가 아니면 그대로. */
export function keepFileTab(input: { layout: GroupLayout; tabId: string }): GroupLayout {
  const owner = groupOfTab(input.layout.root, input.tabId)
  if (owner === null || previewOf(owner) !== input.tabId) return input.layout
  return updateGroup(input.layout, owner.groupId, (group) => ({ ...group, previewTabId: null }))
}

/** 파일 탭을 닫는다 — 영역에서 뺀다(마지막이면 영역 접힘·미리보기 표시도 걷힘 — `removeTabFromGroup`). 닫기 전 자리를 돌려준다(⌘⇧T). */
export function closeFileTab(input: { layout: GroupLayout; tabId: string }): { layout: GroupLayout; closed: { groupId: string; index: number; preview: boolean } | null } {
  const owner = groupOfTab(input.layout.root, input.tabId)
  if (owner === null) return { layout: input.layout, closed: null }
  const closed = { groupId: owner.groupId, index: owner.tabOrder.indexOf(input.tabId), preview: previewOf(owner) === input.tabId }
  return { layout: removeTabFromGroup(input.layout, owner.groupId, input.tabId), closed }
}

/**
 * 닫은 파일 탭을 다시 연다(⌘⇧T — E3ⓓ) — **같은 영역·같은 자리**, 미리보기였으면 미리보기로. 그 영역이 없어졌으면 활성 영역 끝.
 * 이미 열려 있으면 그 탭을 활성으로만.
 */
export function reopenFileTab(input: { layout: GroupLayout; rel: string; groupId: string; index: number; preview: boolean }): GroupLayout {
  const tabId = fileTabId(input.rel)
  const owner = groupOfTab(input.layout.root, tabId)
  if (owner !== null) return { ...updateGroup(input.layout, owner.groupId, (group) => ({ ...group, activeTabId: tabId })), activeGroupId: owner.groupId }
  const target = findGroup(input.layout.root, input.groupId) ?? findGroup(input.layout.root, input.layout.activeGroupId) ?? listGroups(input.layout.root)[0]
  if (target === undefined) return input.layout
  const sameGroup = target.groupId === input.groupId
  const next = updateGroup(input.layout, target.groupId, (group) => {
    const at = sameGroup ? Math.max(0, Math.min(input.index, group.tabOrder.length)) : group.tabOrder.length
    // 미리보기로 되살리면 그 영역의 기존 미리보기는 고정으로 남는다(영역당 미리보기 1개 — 새로 연 쪽이 미리보기).
    return { ...group, tabOrder: [...group.tabOrder.slice(0, at), tabId, ...group.tabOrder.slice(at)], activeTabId: tabId, previewTabId: input.preview ? tabId : (group.previewTabId ?? null) }
  })
  return { ...next, activeGroupId: target.groupId }
}

/** 배치에 열린 파일 탭 전부(영역 순서·탭 순서) — 복원 때 경로를 다시 가두는 대상(E3ⓔ·E7ⓐ). */
export function fileTabsOf(layout: GroupLayout): { tabId: string; rel: string; groupId: string }[] {
  return listGroups(layout.root).flatMap((group) =>
    group.tabOrder.flatMap((tabId) => {
      const kind = tabKindOf(tabId)
      return kind.kind === 'file' ? [{ tabId, rel: kind.rel, groupId: group.groupId }] : []
    }),
  )
}

/**
 * 탐색기 이름 변경·이동(LIFE-592 E4ⓐ) — `from`(파일 또는 폴더) 밑 파일 탭 id 를 `to` 쪽으로 바꾼다. 영역·탭 순서·활성·미리보기 여부는 그대로(문자열 id 만 바뀐다 —
 * `groupLayouts` 영속 **형식** 무변경). 바뀐 id 쌍을 돌려준다(view state·Markdown 모드·닫은 탭 기록을 같이 옮긴다). 대상 id 가 이미 배치에 있으면 그 탭은 두고
 * 건너뛴다(부르는 쪽이 미리 거른다 — 같은 파일 탭이 둘이 되지 않게).
 */
export function retargetFileTabs(input: { layout: GroupLayout; from: string; to: string }): { layout: GroupLayout; moved: { from: string; to: string }[] } {
  const present = new Set(listGroups(input.layout.root).flatMap((group) => group.tabOrder))
  const map = new Map<string, string>()
  for (const tabId of present) {
    const kind = tabKindOf(tabId)
    if (kind.kind !== 'file') continue
    const rel = remapRel(kind.rel, input.from, input.to)
    if (rel === null || rel === kind.rel) continue
    const next = fileTabId(rel)
    if (!present.has(next)) map.set(tabId, next)
  }
  if (map.size === 0) return { layout: input.layout, moved: [] }
  const swap = (tabId: string | null | undefined): string | null => (tabId === null || tabId === undefined ? null : (map.get(tabId) ?? tabId))
  let layout = input.layout
  for (const group of listGroups(input.layout.root)) {
    if (!group.tabOrder.some((tabId) => map.has(tabId))) continue
    layout = updateGroup(layout, group.groupId, (current) => ({ ...current, tabOrder: current.tabOrder.map((tabId) => map.get(tabId) ?? tabId), activeTabId: swap(current.activeTabId), previewTabId: swap(current.previewTabId), ...(current.recentTabIds === undefined ? {} : { recentTabIds: current.recentTabIds.map((tabId) => map.get(tabId) ?? tabId) }) }))
  }
  return { layout, moved: [...map].map(([from, to]) => ({ from, to })) }
}

/** `rel`(파일 또는 폴더) 자신이거나 그 밑의 열린 파일 탭 id. */
export function fileTabsUnder(input: { layout: GroupLayout; rel: string }): string[] {
  return fileTabsOf(input.layout).filter((tab) => tab.rel === input.rel || tab.rel.startsWith(`${input.rel}/`)).map((tab) => tab.tabId)
}
