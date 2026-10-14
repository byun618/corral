// 파일 탭 본문 (LIFE-590 E4·E5) — 영역의 활성 탭이 파일 탭이면 터미널 자리에 선다. 내용은 main 읽기 전용 IPC(`readFile`·`readImage` — 가둠·상한·바이너리 판정)로만 받는다.
//
// 텍스트 = Monaco 읽기 전용(`editor/monaco.ts` — **이 컴포넌트가 처음 텍스트를 그릴 때 동적 import**, 그 전에는 편집기 코드가 로드되지 않는다 — E8ⓒ).
// 비활성 탭은 언마운트된다(터미널과 같은 구조) — 스크롤·선택 위치(Monaco view state)는 탭 id 별로 `viewStates` 에 맡겨 두고 다시 마운트할 때 되살린다(E3ⓕ).
// 외부 변경(E5) — App 이 main 감시 push 의 `stamp` 를 내려준다. 마지막으로 읽은 `stamp` 와 다르면 다시 읽고, **같은 편집기·모델에 내용만 바꿔** 스크롤을 지킨다.
// 지워지면(`exists: false`) 마지막 내용을 그대로 둔다(VS Code 와 같다 — 탭에 「삭제됨」, MainTabBar). 같은 경로에 다시 생기면 새 stamp 로 다시 읽는다.
// 이미지(E4ⓔ) = 바이트 → 캔버스·정화한 인라인 SVG(`editor/image.ts`). Markdown(E4ⓓ) = 원문(Monaco)과 미리보기(`editor/markdown.ts`) 전환 — 기본은 원문(VS Code 와 같다).
// 바이너리·상한 초과·읽기 실패는 한 줄 안내(문구는 VS Code `binaryEditor.ts` 를 옮김).
//
// LIFE-591 F3 — 텍스트는 **편집**한다. 모델(내용 + 실행 취소 기록)은 이 컴포넌트가 아니라 문서 저장소(`file-docs.ts`)에 있다 — 언마운트(탭 전환·끌기·worktree 전환)에는
// 편집기(뷰)만 버리고 모델은 남는다(E1ⓔ). 외부 변경(E4): 수정 없는 문서는 F2 처럼 같은 모델에 디스크 내용을 넣고, **수정 중이면 덮지 않고 배너**를 띄운다
// (「디스크 내용으로 되돌리기」 = 실행 취소 가능한 편집 · 「내 변경 유지」). 자기 저장 뒤 감시 push 는 문서 stamp 와 같아 아무 일도 없다(E2ⓒ).
// 읽기 전용(편집 안 함): UTF-8 로 손실 없이 안 읽히는 파일(Q4) · 하드링크(E6ⓑ⑪) · 20 MB 초과(E1ⓖ) — 안내 띠로 까닭을 보인다.
//
// 수정 r1 — 디스크 반영은 **이 컴포넌트**(FileView)가 한다(옛 코드는 TextBody 안에 있어, Markdown 미리보기처럼 TextBody 가 없으면 반영이 멈췄다 — R1-E).
//   · 감시 push 의 stamp 가 문서·마지막 읽기와 다르면 **다시 읽고**, 판단은 읽은 결과(stamp·내용 지문)로만 한다 — push stamp 로 바로 배너를 띄우지 않는다
//     (저장 중 찍힌 중간 stamp 가 늦게 와도 다시 읽으면 문서와 같아 아무 일도 없다 — 옛 `ignoredStamps` 일괄 무시 대신, R1-B)
//   · 저장 전·중에 요청한 읽기 결과(저장 세대가 다름)는 쓰지 않고 다시 읽는다
//   · 수정 없는 문서는 내용과 함께 읽기 전용 까닭(크기·비 UTF-8·하드링크)도 새로 잰다(R1-F) — 편집기 옵션이 따라온다
//   · 문서가 있으면 읽기가 실패해도(삭제됨 등) 편집기와 수정 내용을 보이고 「삭제됨」 띠를 단다(R1-D)
// 감시 쪽 한계(R1-C 기록): 같은 크기·같은 mtime 으로 내용만 바뀌면 감시 stamp 가 같아 push 가 없다 — 수정 없는 탭은 그 변경을 반영하지 못한다.
// 저장은 main 이 내용 지문으로 막는다(덮지 않고 충돌 확인).
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { imageMimeOf, LARGE_FILE_BYTES, type FileReadResult, type ImageReadResult } from '../../../shared/file-view.js'
import { adoptDoc, disposeDoc, docKey, docsVersion, editingFrozen, getDoc, readMatchesDoc, reloadDoc, revertDoc, setComposing, setExternal, subscribeDocs, type DiskState, type FileDoc, type ReadOnlyReason } from '../file-docs.js'
import './file-view.css'

type MonacoModule = typeof import('../editor/monaco.js')
type Editor = ReturnType<MonacoModule['createEditor']>
type ViewState = ReturnType<Editor['saveViewState']>
type TextRead = Extract<FileReadResult, { kind: 'text' }>

/** 이 읽기 결과를 편집할 수 없는 까닭 — 없으면 null. */
export function readOnlyReasonOf(read: Pick<TextRead, 'utf8' | 'nlink' | 'size'>): ReadOnlyReason | null {
  if (!read.utf8) return 'encoding'
  if (read.nlink > 1) return 'hardlink'
  if (read.size > LARGE_FILE_BYTES) return 'large'
  return null
}

/** 읽은 텍스트 → 문서에 넣을 디스크 상태. */
const diskStateOf = (read: TextRead): DiskState => ({ text: read.text, bom: read.bom, stamp: read.stamp, hash: read.hash, readOnly: readOnlyReasonOf(read), large: read.size > LARGE_FILE_BYTES })

/** 편집기가 붙어 있으면 FileView 가 디스크 반영 때 스크롤·선택을 지킨다. */
type MountedEditor = { editor: Editor; host: HTMLDivElement }

const READ_ONLY_NOTICE: Record<ReadOnlyReason, string> = {
  encoding: 'UTF-8 로 읽을 수 없는 바이트가 있어 읽기 전용으로 엽니다 — 저장하면 그 바이트가 깨지므로 편집하지 않습니다.',
  hardlink: '다른 위치와 하드링크로 연결된 파일이라 읽기 전용으로 엽니다.',
  large: '20 MB 를 넘는 파일은 편집하지 않습니다(읽기 전용).',
}

/** 탭 id 별 Monaco view state — App 이 worktree 마다 하나 들고 있다(렌더 대상이 아니다). */
export type ViewStateStore = Map<string, ViewState>
/** 탭 id 별 Markdown 보기(원문/미리보기) — 탭을 오가도 유지(E4ⓓ). */
export type MarkdownModeStore = Map<string, 'source' | 'preview'>

/**
 * 지금 붙어 있는 편집기(view state 저장소별) — LIFE-592 수정 r1 R1-E. 탐색기 이름 변경·이동은 탭 id 를 바꾸고(FileView 는 탭 id 로 다시 마운트된다),
 * 떠나는 편집기는 정리 때 **새 id** 로 view state 를 맡겨야 새 편집기가 커서·스크롤을 되살린다. `retargetLiveEditors` 가 그 id 를 같은 틱에 바꿔 둔다.
 */
type LiveEditor = { tabId: string; editor: Editor }
const liveEditors = new WeakMap<ViewStateStore, Set<LiveEditor>>()
const liveEditorsOf = (store: ViewStateStore): Set<LiveEditor> => {
  const found = liveEditors.get(store)
  if (found !== undefined) return found
  const made = new Set<LiveEditor>()
  liveEditors.set(store, made)
  return made
}
/** 탭 id 가 바뀐 편집기 — 지금 view state 를 새 id 로 맡기고, 정리 때도 새 id 로 저장하게 한다. */
export function retargetLiveEditors(store: ViewStateStore, moved: readonly { from: string; to: string }[]): void {
  for (const live of liveEditorsOf(store)) {
    const pair = moved.find((item) => item.from === live.tabId)
    if (pair === undefined) continue
    live.tabId = pair.to
    store.set(pair.to, live.editor.saveViewState())
  }
}

type ReadState = FileReadResult | ImageReadResult

const MARKDOWN = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i

const formatBytes = (size: number): string =>
  size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`

export function FileView({
  root,
  rel,
  tabId,
  groupId,
  viewStates,
  markdownModes,
  watched,
  onActivate,
  onOpenFile,
}: {
  root: string
  rel: string
  tabId: string
  groupId: string
  viewStates: ViewStateStore
  markdownModes: MarkdownModeStore
  /** main 감시가 마지막으로 민 상태(없으면 아직 못 받음). */
  watched: { exists: boolean; stamp: string | null } | null
  /** 본문을 누르면 이 영역이 활성이 된다(터미널 본문과 같다). */
  onActivate: () => void
  /** Markdown 미리보기 안 상대 링크 — worktree 안 파일을 미리보기 탭으로. */
  onOpenFile: (rel: string) => void
}): React.JSX.Element {
  const image = imageMimeOf(rel) !== null
  const markdown = MARKDOWN.test(rel)
  // 읽기 결과 + 요청할 때 문서의 저장 세대(`saveGen`) — 저장 전·중에 찍은 결과를 가린다.
  const [readEntry, setReadEntry] = useState<{ result: ReadState; gen: number } | null>(null)
  const read = readEntry?.result ?? null
  const [version, setVersion] = useState(0)
  const mountedRef = useRef<MountedEditor | null>(null)
  const [mode, setModeState] = useState<'source' | 'preview'>(() => markdownModes.get(tabId) ?? 'source')
  const setMode = (next: 'source' | 'preview'): void => {
    markdownModes.set(tabId, next)
    setModeState(next)
  }

  // 읽기 — 처음 마운트 + 감시 stamp 가 마지막으로 읽은 것과 다를 때(version). 다시 읽는 동안 옛 내용을 그대로 둔다(깜빡임 없음).
  const key = docKey(root, rel)
  useEffect(() => {
    let cancelled = false
    const gen = getDoc(key)?.saveGen ?? 0
    const request = image ? window.corral.readImage({ root, rel }) : window.corral.readFile({ root, rel })
    void request.then((result) => {
      if (!cancelled) setReadEntry({ result, gen })
    })
    return () => {
      cancelled = true
    }
  }, [root, rel, image, version, key])

  const readStamp = read !== null && read.ok ? read.stamp : null
  // 문서(편집 중인 모델)는 저장소에 있다 — 수정 여부·외부 상태·저장 중이 바뀌면 다시 그린다.
  const docsVer = useSyncExternalStore(subscribeDocs, docsVersion)
  const doc = getDoc(key)
  // 감시 push — 문서(또는 마지막 읽기)와 다른 디스크 상태면 다시 읽는다. 무엇을 할지는 읽은 결과로 아래에서 정한다. 저장 중이면 끝난 뒤 다시 본다(docsVer).
  useEffect(() => {
    if (watched === null || !watched.exists || watched.stamp === null) return
    const current = getDoc(key)
    if (current?.saving === true) return
    if (watched.stamp === readStamp || watched.stamp === current?.stamp) return
    if (current === undefined && readStamp === null) return
    setVersion((value) => value + 1)
  }, [watched, readStamp, key, docsVer])
  // 읽은 결과를 문서에 반영한다(TextBody 가 마운트돼 있든 아니든 — 미리보기 중에도, R1-E).
  useEffect(() => {
    const current = getDoc(key)
    if (current === undefined || readEntry === null || current.saving) return
    const result = readEntry.result
    if (!result.ok || result.kind === 'image') return
    const same = result.kind === 'text' && readMatchesDoc(current, result)
    // 저장 전·중에 요청한 읽기(자기 저장의 중간 상태일 수 있다) — 판단하지 않고, 문서와 다르면 다시 읽는다.
    if (readEntry.gen !== current.saveGen) {
      if (!same) setVersion((value) => value + 1)
      return
    }
    if (same) return
    // 수정 중 외부 변경 — 덮지 않고 배너(E4ⓑ). 같은 디스크 상태로 이미 띄웠거나 「내 변경 유지」 를 골랐으면 다시 띄우지 않는다. 텍스트가 아니게 바뀐 것도 같다.
    if (current.dirty || result.kind !== 'text') {
      if (!current.dirty) return
      const shown = current.external.kind === 'none' ? null : current.external.diskStamp
      if (shown !== result.stamp) setExternal(current, { kind: 'changed', diskStamp: result.stamp, deleted: false })
      return
    }
    // 수정 없음 — 같은 모델에 디스크 내용(과 읽기 전용 까닭)을 넣는다. 편집기가 붙어 있으면 스크롤·선택을 지킨다(F2 E5ⓐ).
    const mounted = mountedRef.current
    const state = mounted?.editor.saveViewState() ?? null
    reloadDoc(current, diskStateOf(result))
    if (mounted !== null) {
      if (state !== null) mounted.editor.restoreViewState(state)
      mounted.host.dataset.editorUpdated = String(Date.now())
    }
  }, [readEntry, key, docsVer])
  // 지워졌다 같은 경로에 다시 생겼는데 처음 읽기가 실패해 있던 경우(복원 때 없던 파일 등) — 다시 읽는다.
  const readFailed = read !== null && !read.ok
  useEffect(() => {
    if (readFailed && watched !== null && watched.exists) setVersion((value) => value + 1)
  }, [readFailed, watched])

  const textRead = read !== null && read.ok && read.kind === 'text' ? read : null
  // 문서가 있으면 편집기는 문서로 그린다 — 읽기가 아직이거나 실패해도(삭제됨 — R1-D), 수정 중인데 디스크가 텍스트가 아니게 바뀌었어도. 수정 없는 문서인데 디스크가 바이너리·상한 초과가 됐으면 그 안내를 보인다.
  const docBody = doc !== undefined && (read === null || !read.ok || read.kind === 'text' || doc.dirty)
  const editable = docBody || textRead !== null
  const large = doc !== undefined ? doc.large : read !== null && read.ok && read.size > LARGE_FILE_BYTES
  const deleted = doc !== undefined && (watched?.exists === false || (read !== null && !read.ok && read.code === 'not_found'))

  let body: React.JSX.Element
  const readOnly = doc?.readOnly ?? (textRead === null ? null : readOnlyReasonOf(textRead))
  if (editable)
    // 미리보기는 편집 중인 내용을 그린다(문서가 있으면 모델 값 — 저장 전 변경·디스크 반영도 보인다).
    body =
      markdown && mode === 'preview' ? (
        <MarkdownPreview source={doc?.model.getValue() ?? textRead?.text ?? ''} root={root} rel={rel} onOpenFile={onOpenFile} />
      ) : (
        <TextBody initial={textRead} root={root} rel={rel} tabId={tabId} large={large} readOnly={readOnly} frozen={editingFrozen()} viewStates={viewStates} mountedRef={mountedRef} />
      )
  else if (read === null) body = <div className="file-view-notice" data-file-notice="loading" />
  else if (!read.ok)
    body = (
      <div className="file-view-notice" data-file-notice={read.code}>
        {read.code === 'not_found' ? '파일이 없습니다.' : `파일을 열 수 없습니다 (${read.code}).`}
      </div>
    )
  else if (read.kind === 'binary')
    body = (
      <div className="file-view-notice" data-file-notice="binary">
        이 파일은 바이너리이거나 지원하지 않는 텍스트 인코딩이라 편집기에 표시하지 않습니다. ({formatBytes(read.size)})
      </div>
    )
  else if (read.kind === 'too_large')
    body = (
      <div className="file-view-notice" data-file-notice="too_large">
        파일이 너무 커서 표시하지 않습니다. ({formatBytes(read.size)} — 상한 {formatBytes(read.limit)})
      </div>
    )
  else if (read.kind === 'image') body = <ImageBody key={read.stamp} bytes={read.bytes} mime={read.mime} size={read.size} />
  else body = <div className="file-view-notice" data-file-notice="loading" />

  return (
    <div className="file-group" data-file-group={groupId} data-file-view={rel} data-file-dirty={doc?.dirty === true ? 'true' : 'false'} onMouseDown={() => onActivate()}>
      {markdown && editable ? (
        <div className="file-view-toolbar">
          <button
            type="button"
            className="file-view-toolbar-button"
            data-markdown-toggle={mode === 'source' ? 'preview' : 'source'}
            title={mode === 'source' ? '미리보기 열기' : '원문 보기'}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setMode(mode === 'source' ? 'preview' : 'source')}
          >
            {mode === 'source' ? '미리보기' : '원문'}
          </button>
        </div>
      ) : null}
      {large && editable ? (
        <div className="file-view-banner" data-file-notice="large">
          대용량 파일({formatBytes(read !== null && read.ok ? read.size : 0)}) — 구문 강조·접기를 끄고 일반 텍스트로 표시합니다. 편집하지 않습니다(읽기 전용).
        </div>
      ) : null}
      {deleted ? (
        <div className="file-view-banner" data-file-notice="deleted">
          디스크에서 삭제된 파일입니다 — 편집 내용은 그대로 있습니다. 저장하면 같은 경로에 다시 만들지 묻습니다.
        </div>
      ) : null}
      {editable && readOnly !== null && readOnly !== 'large' ? (
        <div className="file-view-banner" data-file-notice={`readonly-${readOnly}`}>
          {READ_ONLY_NOTICE[readOnly]}
        </div>
      ) : null}
      {doc !== undefined && doc.external.kind === 'changed' ? <ExternalBanner doc={doc} /> : null}
      {body}
    </div>
  )
}

/**
 * 수정 중 외부 변경 배너(E4ⓑ — Orca 「디스크에서 바뀜」 류). 「디스크 내용으로 되돌리기」 = 디스크를 다시 읽어 **실행 취소할 수 있는 편집**으로 넣는다(⌘Z 가 내 변경을 되살린다).
 * 「내 변경 유지」 = 배너만 닫는다 — 저장할 때 저장 시점 충돌 검사가 「덮어쓰기 / 취소」 를 묻는다(E4ⓔ, 조용히 덮는 길 없음). Compare(diff)는 넣지 않는다(572 D5).
 */
function ExternalBanner({ doc }: { doc: FileDoc }): React.JSX.Element {
  const revert = async (): Promise<void> => {
    const result = await window.corral.readFile({ root: doc.root, rel: doc.rel })
    if (!result.ok || result.kind !== 'text' || !result.utf8) {
      toast(`'${doc.rel}' 의 디스크 내용을 읽지 못했습니다 (${result.ok ? result.kind : result.code})`)
      return
    }
    revertDoc(doc, diskStateOf(result))
  }
  const diskStamp = doc.external.kind === 'changed' ? doc.external.diskStamp : null
  return (
    <div className="file-view-banner file-view-conflict" data-file-notice="external-change" onMouseDown={(event) => event.stopPropagation()}>
      <span className="file-view-conflict-text">디스크의 파일이 바뀌었습니다. 저장하면 디스크의 새 내용을 덮어씁니다(저장할 때 다시 묻습니다).</span>
      <button type="button" className="file-view-toolbar-button" data-external-action="revert" onClick={() => void revert()}>
        디스크 내용으로 되돌리기
      </button>
      <button type="button" className="file-view-toolbar-button" data-external-action="keep" onClick={() => setExternal(doc, { kind: 'kept', diskStamp })}>
        내 변경 유지
      </button>
    </div>
  )
}

/**
 * 텍스트 — 편집기(뷰)는 이 컴포넌트 동안만, 모델은 문서 저장소에(E1ⓔ). 문서가 있으면 그 모델에 붙고, 없으면 `initial`(이번 읽기)로 만들어 맡긴다.
 * 디스크 반영(다시 읽은 내용·배너)은 FileView 가 한다 — 여기는 편집기를 `mountedRef` 에 걸어 두어 반영 때 스크롤·선택을 지키게 할 뿐이다(수정 r1 R1-E).
 * `readOnly` 가 바뀌면(R1-F — 다시 읽은 메타데이터) 기존 편집기 옵션에 바로 반영한다. `large` 가 바뀌면 편집기를 새로 만든다(대용량 옵션은 만들 때 정한다).
 */
function TextBody({
  initial,
  root,
  rel,
  tabId,
  large,
  readOnly,
  frozen,
  viewStates,
  mountedRef,
}: {
  initial: TextRead | null
  root: string
  rel: string
  tabId: string
  large: boolean
  readOnly: ReadOnlyReason | null
  /** 종료 승인 뒤(R3-C) — 까닭과 무관하게 읽기 전용. */
  frozen: boolean
  viewStates: ViewStateStore
  mountedRef: React.MutableRefObject<MountedEditor | null>
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const initialRef = useRef(initial)
  initialRef.current = initial
  // 지금 탭 id — 탐색기 이름 변경·이동(LIFE-592 E4)으로 탭 id 가 바뀌면 편집기를 새로 붙이는데, 떠나는 편집기의 view state 는 **새 id** 로 맡겨야 새 편집기가 되살린다.
  const tabIdRef = useRef(tabId)
  tabIdRef.current = tabId
  const key = docKey(root, rel)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    let disposed = false
    // 이 편집기가 붙은 문서 — 정리 때 키(이름 변경으로 바뀌었을 수 있다)로 다시 찾지 않는다.
    let attached: FileDoc | null = null
    let live: LiveEditor | null = null
    void import('../editor/monaco.js').then(async (module) => {
      // 문서가 있으면 그 모델(문서가 든 것 — URI 는 경로와 무관, LIFE-592)에 붙는다. 없으면 이 읽기로 만들어 맡긴다 — 언어 등록(비동기) 사이 다른 마운트가 먼저 맡겼으면 그것을 쓴다.
      let doc = getDoc(key)
      let model = doc === undefined ? null : module.liveModel(doc.model)
      if (doc !== undefined && model === null) {
        disposeDoc(key)
        doc = undefined
      }
      // 언어는 지금 경로로 고른다 — 이름 변경으로 확장자가 바뀐 문서의 모델(재사용)도 같은 규칙(수정 r1 R1-F).
      const language = large ? 'plaintext' : await module.languageFor(rel)
      if (disposed) return
      if (doc === undefined || model === null) {
        doc = getDoc(key)
        model = doc === undefined ? null : module.liveModel(doc.model)
        if (doc === undefined || model === null) {
          const first = initialRef.current
          if (first === null) return
          model = module.createModel({ text: first.text, language, key })
          doc = adoptDoc({ root, rel, model, ...diskStateOf(first) })
        }
      }
      module.setModelLanguage(model, language)
      if (disposed) return
      const editor = module.createEditor({ host, large, readOnly: doc.readOnly !== null || editingFrozen() })
      editor.setModel(model)
      const saved = viewStates.get(tabId)
      if (saved !== undefined && saved !== null) editor.restoreViewState(saved)
      const owner = doc
      attached = doc
      editor.onDidCompositionStart(() => setComposing(owner, true))
      editor.onDidCompositionEnd(() => setComposing(owner, false))
      live = { tabId, editor }
      liveEditorsOf(viewStates).add(live)
      editorRef.current = editor
      mountedRef.current = { editor, host }
      host.dataset.editorReady = model.getLanguageId()
    })
    return () => {
      disposed = true
      const editor = editorRef.current
      if (live !== null) liveEditorsOf(viewStates).delete(live)
      if (editor !== null) {
        // 떠나는 편집기의 view state 는 **지금 탭 id** 로 — 탐색기 이름 변경·이동이 탭 id 를 바꿨으면 `retargetLiveEditors` 가 옮겨 둔 새 id(R1-E).
        viewStates.set(live?.tabId ?? tabIdRef.current, editor.saveViewState())
        // 조합 중에 떠나면 조합이 끝난 것으로 친다 — 기다리던 저장이 묶이지 않게.
        if (attached !== null && attached.composing) setComposing(attached, false)
        editor.dispose()
      }
      editorRef.current = null
      if (mountedRef.current?.host === host) mountedRef.current = null
      delete host.dataset.editorReady
    }
  }, [key, root, rel, tabId, large, viewStates, mountedRef])

  // 읽기 전용 까닭이 바뀌었다(다시 읽은 디스크 메타데이터) — 편집기 옵션에 반영(작아져 편집 가능해지는 쪽도).
  useEffect(() => {
    const locked = readOnly !== null || frozen
    editorRef.current?.updateOptions({ readOnly: locked, domReadOnly: locked })
  }, [readOnly, frozen])

  return <div className="file-editor-host" data-file-editor={tabId} ref={hostRef} />
}

/** 이미지 — 가운데, 창보다 크면 맞춰 줄인다(VS Code 이미지 미리보기 기본 「맞춤」). 아래에 크기(가로×세로·바이트). */
function ImageBody({ bytes, mime, size }: { bytes: Uint8Array; mime: string; size: number }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [drawn, setDrawn] = useState<{ width: number; height: number } | 'failed' | null>(null)
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    let cancelled = false
    void import('../editor/image.js').then(async (module) => {
      const result = await module.drawImage({ bytes, mime })
      if (cancelled) return
      host.replaceChildren()
      if (result === null) {
        setDrawn('failed')
        return
      }
      result.element.classList.add('file-image')
      host.append(result.element)
      host.dataset.imageReady = mime
      setDrawn({ width: result.width, height: result.height })
    })
    return () => {
      cancelled = true
    }
  }, [bytes, mime])
  return (
    <div className="file-image-view">
      <div className="file-image-stage" ref={hostRef} data-file-image={mime} />
      <div className="file-image-info">
        {drawn === 'failed' ? '이미지를 표시할 수 없습니다.' : drawn === null ? '' : `${Math.round(drawn.width)}×${Math.round(drawn.height)} · ${formatBytes(size)}`}
      </div>
    </div>
  )
}

/**
 * Markdown 미리보기 — 정화한 HTML 을 붙이고(`renderMarkdown`), 이미지·링크를 손으로 처리한다:
 * 이미지 = worktree 안 상대 경로만 main 에서 바이트로 받아 그린다(원격·밖은 alt 글 + 사유). 링크 = 같은 문서 조각은 스크롤, 상대 경로는 파일 탭, http(s) 는 외부(main).
 */
function MarkdownPreview({ source, root, rel, onOpenFile }: { source: string; root: string; rel: string; onOpenFile: (rel: string) => void }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const openRef = useRef(onOpenFile)
  openRef.current = onOpenFile

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    let cancelled = false
    void Promise.all([import('../editor/markdown.js'), import('../editor/image.js')]).then(async ([markdown, image]) => {
      if (cancelled) return
      // 외부 변경으로 다시 그릴 때 스크롤 자리를 지킨다(E5ⓐ).
      const scrollTop = host.scrollTop
      host.innerHTML = markdown.renderMarkdown(source)
      host.scrollTop = scrollTop
      for (const heading of host.querySelectorAll('h1, h2, h3, h4, h5, h6')) heading.id = markdown.slugOf(heading.textContent ?? '')
      host.dataset.markdownReady = 'true'
      for (const img of host.querySelectorAll('img[data-md-src]')) {
        const target = markdown.resolveMarkdownTarget({ fileRel: rel, target: img.getAttribute('data-md-src') ?? '', image: true })
        const alt = img.getAttribute('alt') ?? ''
        const placeholder = (reason: string): void => {
          const span = document.createElement('span')
          span.className = 'md-image-refused'
          span.dataset.mdImageRefused = reason
          span.textContent = alt.length > 0 ? `[이미지: ${alt}]` : '[이미지]'
          span.title = reason === 'remote' ? '원격 이미지는 표시하지 않습니다' : '이 이미지는 표시할 수 없습니다'
          img.replaceWith(span)
        }
        if (target.kind !== 'file' || imageMimeOf(target.rel) === null) {
          placeholder(target.kind === 'refused' ? target.reason : 'not_image')
          continue
        }
        const result = await window.corral.readImage({ root, rel: target.rel })
        if (cancelled) return
        if (!result.ok || result.kind !== 'image') {
          placeholder(result.ok ? 'too_large' : result.code)
          continue
        }
        const drawn = await image.drawImage({ bytes: result.bytes, mime: result.mime })
        if (cancelled) return
        if (drawn === null) {
          placeholder('decode')
          continue
        }
        drawn.element.classList.add('md-image')
        drawn.element.dataset.mdImage = target.rel
        if (alt.length > 0) drawn.element.setAttribute('aria-label', alt)
        img.replaceWith(drawn.element)
      }
    })
    return () => {
      cancelled = true
    }
  }, [source, root, rel])

  const onClick = (event: React.MouseEvent): void => {
    const anchor = event.target instanceof Element ? event.target.closest('[data-md-href]') : null
    // 미리보기 안 어떤 클릭도 창을 옮기지 않는다 — 링크 기본 동작을 늘 막고 손으로 처리한다.
    event.preventDefault()
    if (anchor === null) return
    void import('../editor/markdown.js').then((markdown) => {
      const target = markdown.resolveMarkdownTarget({ fileRel: rel, target: anchor.getAttribute('data-md-href') ?? '', image: false })
      if (target.kind === 'fragment') hostRef.current?.querySelector(`[id="${CSS.escape(target.fragment)}"]`)?.scrollIntoView({ block: 'start' })
      else if (target.kind === 'external') window.open(target.url, '_blank')
      else if (target.kind === 'file') openRef.current(target.rel)
    })
  }

  return <div className="file-markdown-preview" data-markdown-preview={rel} ref={hostRef} onClick={onClick} />
}
