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
import { DIFF_TAB_PREFIX, parseDiffTabId, type ScmDiffTarget } from '../../shared/scm.js'

export { FILE_TAB_PREFIX, isFileTabId }

/**
 * 탭 종류 — 터미널 · 파일 · diff(LIFE-683 소스 제어). diff 탭은 파일 탭과 같은 미리보기·고정·닫기 규칙을 따르되 문서(편집)가 없다.
 * 모양이 깨진 `diff:` id(손으로 고친 파일)는 `broken` — 탭바에 그리고 닫을 수 있게 둔다.
 */
export type TabKind = { kind: 'terminal'; tabId: string } | { kind: 'file'; tabId: string; rel: string } | { kind: 'diff'; tabId: string; target: ScmDiffTarget | null }

export function fileTabId(rel: string): string {
  return `${FILE_TAB_PREFIX}${rel}`
}

export function tabKindOf(tabId: string): TabKind {
  if (!isFileTabId(tabId)) return { kind: 'terminal', tabId }
  if (tabId.startsWith(DIFF_TAB_PREFIX)) return { kind: 'diff', tabId, target: parseDiffTabId(tabId) }
  return { kind: 'file', tabId, rel: tabId.slice(FILE_TAB_PREFIX.length) }
}

/**
 * 터미널 pane 을 대상으로 하는 단축키(⌘D·⌘⇧D 분할 · ⌘⌥방향 인접 포커스 · ⌘⇧Z 줌)의 대상 — 활성 영역의 활성 탭이 **파일 탭이면 없음**(무동작).
 * 파일 탭으로 바꿔도 `selectedPane` 은 직전 터미널 pane 에 남아 있어, 그대로 쓰면 보이지 않는 터미널을 분할·줌한다(수정 r1 R1-B).
 */
export function terminalKeyTarget(input: { activeTabId: string | null; selectedPane: string | null }): string | null {
  return input.activeTabId !== null && isFileTabId(input.activeTabId) ? null : input.selectedPane
}

/**
 * 파일 탭 닫기 뒤 입력 pane 따라가기의 대기 기록 (LIFE-691 K2ⓐ · f1 C·D) — 어느 worktree 에서, 닫기 직전 **활성 영역의 활성 탭**이 무엇이었고, 무엇을 닫았나.
 * 닫기 경로 둘(탭 닫기 `closeFileNow` · 탐색기 삭제/이동 `closeFiles`)이 같이 쓴다.
 */
export type CloseFollow = { worktreePath: string; activeTabBefore: string | null; closedTabIds: readonly string[] }

/**
 * 닫기를 대기 기록에 싣는다 — **활성 worktree 의 닫기만**(다른 worktree 닫기는 화면과 무관 → 기존 기록 그대로). 같은 worktree 의 대기가 있으면 닫은 탭만 보탠다
 * (여러 탭을 한 번에 닫을 때 `activeTabBefore` 는 첫 닫기 직전 값). 다른 worktree 의 대기는 버린다.
 */
export function recordCloseFollow(input: { pending: CloseFollow | null; activeWorktreePath: string | null; worktreePath: string; activeTabBefore: string | null; tabIds: readonly string[] }): CloseFollow | null {
  if (input.tabIds.length === 0 || input.worktreePath !== input.activeWorktreePath) return input.pending
  const { pending } = input
  if (pending !== null && pending.worktreePath === input.worktreePath) return { ...pending, closedTabIds: [...pending.closedTabIds, ...input.tabIds] }
  return { worktreePath: input.worktreePath, activeTabBefore: input.activeTabBefore, closedTabIds: [...input.tabIds] }
}

/**
 * 닫기 뒤 입력 pane 이 따라갈 터미널 탭 id — **같은 worktree 의 활성 영역에서 활성 탭이 닫혀 새 활성이 터미널 탭**일 때만. 아니면 null(선택 pane 을 그대로 둔다).
 * 다른 영역·비활성 탭·다른 worktree 닫기, 대기 중 worktree 가 바뀐 경우, 새 활성이 파일 탭인 경우가 null 이다. App 은 이 탭의 pane 을 `paneToFollow` 로 고른다.
 */
export function closeFollowTarget(input: { pending: CloseFollow | null; worktreePath: string | null; activeTabId: string | null }): string | null {
  const { pending, activeTabId } = input
  if (pending === null || pending.worktreePath !== input.worktreePath) return null
  if (pending.activeTabBefore === null || !pending.closedTabIds.includes(pending.activeTabBefore)) return null
  if (activeTabId === null || isFileTabId(activeTabId)) return null
  return activeTabId
}

/** 파일 이름(탭 제목) — 경로 마지막 성분. */
export function fileTabLabel(rel: string): string {
  const parts = rel.split('/')
  return parts[parts.length - 1] ?? rel
}

/** 부모 폴더(worktree 루트 기준 상대) — 루트 파일은 `''`(VS Code `labelService.getUriLabel(dirname, { relative: true })` 와 같다). */
function parentOf(rel: string): string {
  const at = rel.lastIndexOf('/')
  return at < 0 ? '' : rel.slice(0, at)
}

/**
 * 파일 탭 설명 (LIFE-689 — VS Code `workbench.editor.labelFormat: default`, `multiEditorTabsControl.ts` `shortenTabLabels` 4df8bb183f0e).
 * 입력 = **한 영역의 파일 탭** 상대 경로들(터미널 탭은 부르는 쪽이 뺀다). 돌려주는 값 = 설명이 붙는 탭만 `rel → 설명`.
 *   · 파일 이름이 그 영역에서 하나뿐이면 설명 없음
 *   · 같은 이름 묶음의 부모 폴더가 1종이면 설명 없음, 2종 이상이면 서로 다른 부모 폴더들을 `shorten` 한 값(루트 `''` → `./`)
 * VS Code 의 절대경로 재비교(`useLongDescriptions`)는 생략 — 한 worktree 안에서 상대 경로가 같으면 같은 탭이다.
 */
export function fileTabDescriptions(rels: readonly string[]): Map<string, string> {
  const byName = new Map<string, string[]>()
  for (const rel of rels) {
    const name = fileTabLabel(rel)
    byName.set(name, [...(byName.get(name) ?? []), rel])
  }
  const descriptions = new Map<string, string>()
  for (const same of byName.values()) {
    if (same.length < 2) continue
    const parents = [...new Set(same.map(parentOf))]
    if (parents.length < 2) continue
    const short = shorten(parents)
    for (const rel of same) descriptions.set(rel, short[parents.indexOf(parentOf(rel))] ?? '')
  }
  return descriptions
}

const ELLIPSIS = '\u2026'
const SEP = '/'
const HOME = '~'

/**
 * VS Code `labels.ts` `shorten`(4df8bb183f0e, 214–324행) 이식 — 경로마다 **다른 경로에 안 나오는 가장 짧은 연속 성분**을 뒤에서부터 찾고 잘린 쪽에 `…`.
 * 구분자는 `/` 고정(상대 경로만 들어온다). 원문의 URL 스킴·UNC 접두 분기는 뺐다(LIFE-689 범위 밖) — `/`·`~` 접두와 드라이브(`x:`) 보존은 원문 그대로.
 * 빈 문자열 = `./`, `null` 은 그대로(원문 `!originalPath` 분기 — 시험 사례 `['', null]`).
 */
export function shorten<T extends string | null>(paths: readonly T[]): (string | T)[] {
  const shortened: (string | T)[] = new Array<string | T>(paths.length)
  let match = false
  for (const [pathIndex, originalPath] of paths.entries()) {
    if (originalPath === '') {
      shortened[pathIndex] = `.${SEP}`
      continue
    }
    if (typeof originalPath !== 'string') {
      shortened[pathIndex] = originalPath
      continue
    }
    match = true

    // `/etc`·`~/etc` 접두는 떼어 두었다가 나중에 붙인다
    let prefix = ''
    let trimmedPath: string = originalPath
    if (trimmedPath.indexOf(SEP) === 0) {
      prefix = SEP
      trimmedPath = trimmedPath.slice(SEP.length)
    } else if (trimmedPath.indexOf(HOME) === 0) {
      prefix = HOME
      trimmedPath = trimmedPath.slice(HOME.length)
    }

    // 처음 찾은 가장 짧은 부분 경로
    const segments = trimmedPath.split(SEP)
    for (let subpathLength = 1; match && subpathLength <= segments.length; subpathLength++) {
      for (let start = segments.length - subpathLength; match && start >= 0; start--) {
        match = false
        let subpath = segments.slice(start, start + subpathLength).join(SEP)

        // 다른 어떤 경로에도 없는가
        for (let otherPathIndex = 0; !match && otherPathIndex < paths.length; otherPathIndex++) {
          const otherPath = paths[otherPathIndex]
          // 끝 성분은 따로 본다 — 'x' 와 'x/...' 는 겹침이 아니다
          if (otherPathIndex !== pathIndex && typeof otherPath === 'string' && otherPath !== '' && otherPath.indexOf(subpath) > -1) {
            const isSubpathEnding = start + subpathLength === segments.length
            // 구분자를 앞에 붙여 `endsWith` 가 성분 단위로 보게 한다 — 부분 경로가 맨 앞이거나 상대 경로에 폴더가 하나뿐이면 붙이지 않는다
            const subpathWithSep = start > 0 && otherPath.indexOf(SEP) > -1 ? SEP + subpath : subpath
            const isOtherPathEnding = otherPath.endsWith(subpathWithSep)
            match = !isSubpathEnding || isOtherPathEnding
          }
        }

        if (!match) {
          let result = ''
          // 드라이브·루트 접두 보존
          const first = segments[0] ?? ''
          if (first.endsWith(':') || prefix !== '') {
            if (start === 1) {
              // 부분 경로를 드라이브 접두까지 늘린다
              start = 0
              subpathLength++
              subpath = first + SEP + subpath
            }
            if (start > 0) result = first + SEP
            result = prefix + result
          }
          if (start > 0) result = result + ELLIPSIS + SEP
          result = result + subpath
          if (start + subpathLength < segments.length) {
            // 마지막 성분이 비었으면 끝 구분자를 남긴다
            result = start + subpathLength === segments.length - 1 && segments[segments.length - 1] === '' ? result + SEP : result + SEP + ELLIPSIS
          }
          shortened[pathIndex] = result
        }
      }
    }
    // 유일한 부분 경로가 없으면 원래 경로
    if (match) shortened[pathIndex] = originalPath
  }
  return shortened
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
export function openFileTab(input: { layout: GroupLayout; rel: string; preview: boolean; tabId?: string }): { layout: GroupLayout; replaced: { rel: string; groupId: string; index: number; tabId: string } | null } {
  const { layout, preview } = input
  // LIFE-683 — diff 탭도 같은 규칙으로 연다(`tabId` 를 주면 그 id). 밀려난 탭의 `rel` 은 파일 탭일 때만 뜻이 있다 — 부르는 쪽이 `tabId` 종류로 가른다.
  const tabId = input.tabId ?? fileTabId(input.rel)
  const owner = groupOfTab(layout.root, tabId)
  if (owner !== null) {
    const pinNow = !preview && previewOf(owner) === tabId
    const next = updateGroup(layout, owner.groupId, (group) => ({ ...group, activeTabId: tabId, previewTabId: pinNow ? null : (group.previewTabId ?? null) }))
    return { layout: { ...next, activeGroupId: owner.groupId }, replaced: null }
  }
  const target = findGroup(layout.root, layout.activeGroupId) ?? listGroups(layout.root)[0]
  if (target === undefined) return { layout, replaced: null }
  const current = previewOf(target)
  let replaced: { rel: string; groupId: string; index: number; tabId: string } | null = null
  const next = updateGroup(layout, target.groupId, (group) => {
    if (preview && current !== null) {
      const index = group.tabOrder.indexOf(current)
      replaced = { rel: current.slice(FILE_TAB_PREFIX.length), groupId: group.groupId, index, tabId: current }
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
