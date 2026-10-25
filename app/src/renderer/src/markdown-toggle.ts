// LIFE-629 ⇧⌘V Markdown 미리보기 전환 — 무엇을 바꿀지(대상)와 바꾸는 순서. App 처리기는 `createMarkdownToggleHandler` 가 만든 함수를 그대로 쓴다(수정 f2 N-2 — 처리기 본문을 행동 시험으로 잠근다).
//
// 대상(수정 f1 F1 — reviews.md r1 A): **포커스가 있는 Markdown 보기의 탭**이 먼저다(VS Code 처럼 포커스 편집기가 대상). 키 캡처는 포커스가 그 보기 안일 때만
// 키를 가져오므로(`useKeybindings`), 그 보기가 활성 영역이 아니어도(툴바 버튼 클릭 — 영역을 활성으로 만들지 않는다) 그 탭을 바꾸고 그 영역을 활성으로 만든다.
// 포커스가 Markdown 보기 밖이면(커맨드 팔레트 항목 — 포커스 무관) 활성 영역의 활성 탭이 대상이다.
import { fileTabId, tabKindOf } from './file-tabs.js'
import { toggleMarkdownMode, type MarkdownModeStore } from './components/FileView.js'

export type MarkdownToggleTarget = { groupId: string; tabId: string; rel: string }

/** 포커스 요소가 든 Markdown 보기(`FileView` 의 `.file-group[data-markdown-view]`) — 영역 id 와 파일 경로. 밖이면 null. */
export function focusedMarkdownView(focused: Element | null): { groupId: string; rel: string } | null {
  const view = focused?.closest('[data-markdown-view]') ?? null
  const groupId = view?.getAttribute('data-file-group') ?? null
  const rel = view?.getAttribute('data-file-view') ?? null
  return groupId === null || rel === null ? null : { groupId, rel }
}

/** 순수 판정 — 포커스 보기가 있으면 그 탭, 없으면 활성 영역의 활성 탭(파일 탭일 때만). 대상이 없으면 null. */
export function markdownToggleTarget(input: { focused: { groupId: string; rel: string } | null; activeGroupId: string | null; activeTabId: string | null }): MarkdownToggleTarget | null {
  if (input.focused !== null) return { groupId: input.focused.groupId, tabId: fileTabId(input.focused.rel), rel: input.focused.rel }
  if (input.activeGroupId === null || input.activeTabId === null) return null
  const kind = tabKindOf(input.activeTabId)
  return kind.kind === 'file' ? { groupId: input.activeGroupId, tabId: kind.tabId, rel: kind.rel } : null
}

/**
 * ⇧⌘V 처리 — 대상 보기를 바꾸고(붙어 있는 편집 가능한 Markdown 보기가 아니면 아무것도 안 하고 거짓), 대상 영역이 활성이 아니면 활성으로, 바뀐 보기에 포커스.
 */
export function runMarkdownToggle(deps: {
  focused: Element | null
  activeGroupId: string | null
  activeTabId: string | null
  store: MarkdownModeStore
  activateGroup: (groupId: string) => void
  focusFile: (rel: string) => void
}): boolean {
  const target = markdownToggleTarget({ focused: focusedMarkdownView(deps.focused), activeGroupId: deps.activeGroupId, activeTabId: deps.activeTabId })
  if (target === null || !toggleMarkdownMode({ store: deps.store, tabId: target.tabId })) return false
  if (target.groupId !== deps.activeGroupId) deps.activateGroup(target.groupId)
  deps.focusFile(target.rel)
  return true
}

/**
 * App 의 `markdown.togglePreview` 처리기 — 부를 때마다 지금 worktree·배치·포커스를 읽어 `runMarkdownToggle` 에 넘긴다(worktree 가 없으면 무동작).
 * 포커스는 미리보기면 보기 자리, 원문이면 편집기(붙는 대로) — 마우스 없이 다시 ⇧⌘V 가 먹고, 원문으로 오면 바로 타이핑된다(`focusOpenedFile`).
 */
export function createMarkdownToggleHandler(deps: {
  root: () => string | null
  layout: () => { activeGroupId: string | null; activeTabId: string | null }
  focused: () => Element | null
  markdownModesOf: (root: string) => MarkdownModeStore
  activateGroup: (groupId: string) => void
  focusOpenedFile: (input: { worktreePath: string; rel: string }) => void
}): () => void {
  return () => {
    const root = deps.root()
    if (root === null) return
    const layout = deps.layout()
    runMarkdownToggle({
      focused: deps.focused(),
      activeGroupId: layout.activeGroupId,
      activeTabId: layout.activeTabId,
      store: deps.markdownModesOf(root),
      activateGroup: deps.activateGroup,
      focusFile: (rel) => deps.focusOpenedFile({ worktreePath: root, rel }),
    })
  }
}
