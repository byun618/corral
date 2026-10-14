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
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { imageMimeOf, LARGE_FILE_BYTES, type FileReadResult, type ImageReadResult } from '../../../shared/file-view.js'
import { adoptDoc, disposeDoc, docKey, docsVersion, getDoc, reloadDoc, revertDoc, setComposing, setExternal, subscribeDocs, type FileDoc, type ReadOnlyReason } from '../file-docs.js'
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

const READ_ONLY_NOTICE: Record<ReadOnlyReason, string> = {
  encoding: 'UTF-8 로 읽을 수 없는 바이트가 있어 읽기 전용으로 엽니다 — 저장하면 그 바이트가 깨지므로 편집하지 않습니다.',
  hardlink: '다른 위치와 하드링크로 연결된 파일이라 읽기 전용으로 엽니다.',
  large: '20 MB 를 넘는 파일은 편집하지 않습니다(읽기 전용).',
}

/** 탭 id 별 Monaco view state — App 이 worktree 마다 하나 들고 있다(렌더 대상이 아니다). */
export type ViewStateStore = Map<string, ViewState>
/** 탭 id 별 Markdown 보기(원문/미리보기) — 탭을 오가도 유지(E4ⓓ). */
export type MarkdownModeStore = Map<string, 'source' | 'preview'>

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
  const [read, setRead] = useState<ReadState | null>(null)
  const [version, setVersion] = useState(0)
  const [mode, setModeState] = useState<'source' | 'preview'>(() => markdownModes.get(tabId) ?? 'source')
  const setMode = (next: 'source' | 'preview'): void => {
    markdownModes.set(tabId, next)
    setModeState(next)
  }

  // 읽기 — 처음 마운트 + 감시 stamp 가 마지막으로 읽은 것과 다를 때(version). 다시 읽는 동안 옛 내용을 그대로 둔다(깜빡임 없음).
  useEffect(() => {
    let cancelled = false
    const request = image ? window.corral.readImage({ root, rel }) : window.corral.readFile({ root, rel })
    void request.then((result) => {
      if (!cancelled) setRead(result)
    })
    return () => {
      cancelled = true
    }
  }, [root, rel, image, version])

  const readStamp = read !== null && read.ok ? read.stamp : null
  // 문서(편집 중인 모델)는 저장소에 있다 — 수정 여부·외부 상태·저장 중이 바뀌면 다시 그린다.
  const docsVer = useSyncExternalStore(subscribeDocs, docsVersion)
  const key = docKey(root, rel)
  const doc = getDoc(key)
  useEffect(() => {
    if (watched === null) return
    const current = getDoc(key)
    if (current === undefined) {
      if (!watched.exists || watched.stamp === null || readStamp === null || watched.stamp === readStamp) return
      setVersion((value) => value + 1)
      return
    }
    // 저장 중에 온 push 는 자기 저장의 중간 상태일 수 있다 — 적어 두고 그 값으로는 움직이지 않는다(E2ⓒ). 저장이 끝나면 최종 stamp 가 문서와 같다.
    if (current.saving) {
      if (watched.stamp !== null) current.ignoredStamps.add(watched.stamp)
      return
    }
    if (!watched.exists || watched.stamp === null || watched.stamp === current.stamp || current.ignoredStamps.has(watched.stamp)) return
    if (!current.dirty) {
      setVersion((value) => value + 1)
      return
    }
    // 수정 중 외부 변경 — 덮지 않고 배너(E4ⓑ). 같은 디스크 상태로 이미 띄웠거나 「내 변경 유지」 를 골랐으면 다시 띄우지 않는다.
    const shown = current.external.kind === 'none' ? null : current.external.diskStamp
    if (shown !== watched.stamp) setExternal(current, { kind: 'changed', diskStamp: watched.stamp, deleted: false })
  }, [watched, readStamp, key, docsVer])
  // 지워졌다 같은 경로에 다시 생겼는데 처음 읽기가 실패해 있던 경우(복원 때 없던 파일 등) — 다시 읽는다.
  const readFailed = read !== null && !read.ok
  useEffect(() => {
    if (readFailed && watched !== null && watched.exists) setVersion((value) => value + 1)
  }, [readFailed, watched])

  const text = read !== null && read.ok && read.kind === 'text' ? read.text : null
  const large = read !== null && read.ok && read.size > LARGE_FILE_BYTES

  let body: React.JSX.Element
  if (read === null) body = <div className="file-view-notice" data-file-notice="loading" />
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
  // 미리보기는 편집 중인 내용을 그린다(문서가 있으면 모델 값 — 저장 전 변경도 보인다).
  else if (markdown && mode === 'preview') body = <MarkdownPreview source={doc?.model.getValue() ?? read.text} root={root} rel={rel} onOpenFile={onOpenFile} />
  else body = <TextBody read={read} root={root} rel={rel} tabId={tabId} large={large} viewStates={viewStates} />
  const readOnly = doc?.readOnly ?? (read !== null && read.ok && read.kind === 'text' ? readOnlyReasonOf(read) : null)

  return (
    <div className="file-group" data-file-group={groupId} data-file-view={rel} data-file-dirty={doc?.dirty === true ? 'true' : 'false'} onMouseDown={() => onActivate()}>
      {markdown && text !== null ? (
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
      {large && text !== null ? (
        <div className="file-view-banner" data-file-notice="large">
          대용량 파일({formatBytes(read !== null && read.ok ? read.size : 0)}) — 구문 강조·접기를 끄고 일반 텍스트로 표시합니다. 편집하지 않습니다(읽기 전용).
        </div>
      ) : null}
      {text !== null && readOnly !== null && readOnly !== 'large' ? (
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
    revertDoc(doc, { text: result.text, bom: result.bom, stamp: result.stamp })
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
 * 텍스트 — 편집기(뷰)는 이 컴포넌트 동안만, 모델은 문서 저장소에(E1ⓔ). 처음 열면 이 읽기로 모델을 만들어 맡기고, 이미 있으면 그 모델에 붙는다.
 * 새로 읽은 내용(감시 push → 다시 읽기)은 문서가 수정 없을 때만 같은 모델에 넣는다(스크롤·선택 유지 — F2 E5ⓐ). 수정 중이면 배너로 넘긴다.
 */
function TextBody({ read, root, rel, tabId, large, viewStates }: { read: TextRead; root: string; rel: string; tabId: string; large: boolean; viewStates: ViewStateStore }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const readRef = useRef(read)
  readRef.current = read
  const key = docKey(root, rel)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    let disposed = false
    void import('../editor/monaco.js').then(async (module) => {
      // 문서가 있으면 그 모델(URI = 문서 키)에 붙는다. 없으면 이 읽기로 만들어 맡긴다 — 언어 등록(비동기) 사이 다른 마운트가 먼저 맡겼으면 그것을 쓴다.
      let doc = getDoc(key)
      let model = module.modelOf(key)
      if (doc !== undefined && model === null) {
        disposeDoc(key)
        doc = undefined
      }
      if (doc === undefined || model === null) {
        const language = large ? 'plaintext' : await module.languageFor(rel)
        if (disposed) return
        doc = getDoc(key)
        model = module.modelOf(key)
        if (doc === undefined || model === null) {
          const first = readRef.current
          model = module.createModel({ text: first.text, language, key })
          doc = adoptDoc({ root, rel, model, text: first.text, bom: first.bom, stamp: first.stamp, readOnly: readOnlyReasonOf(first) })
        }
      }
      if (disposed) return
      const editor = module.createEditor({ host, large, readOnly: doc.readOnly !== null })
      editor.setModel(model)
      const saved = viewStates.get(tabId)
      if (saved !== undefined && saved !== null) editor.restoreViewState(saved)
      const owner = doc
      editor.onDidCompositionStart(() => setComposing(owner, true))
      editor.onDidCompositionEnd(() => setComposing(owner, false))
      editorRef.current = editor
      host.dataset.editorReady = model.getLanguageId()
    })
    return () => {
      disposed = true
      const editor = editorRef.current
      if (editor !== null) {
        viewStates.set(tabId, editor.saveViewState())
        // 조합 중에 떠나면 조합이 끝난 것으로 친다 — 기다리던 저장이 묶이지 않게.
        const doc = getDoc(key)
        if (doc !== undefined && doc.composing) setComposing(doc, false)
        editor.dispose()
      }
      editorRef.current = null
      delete host.dataset.editorReady
    }
  }, [key, root, rel, tabId, large, viewStates])

  // 다시 읽은 결과 — 문서가 기대는 stamp 와 다를 때만. 수정 없으면 같은 모델에 넣고(스크롤 유지), 수정 중이면 배너(덮지 않는다 — E4ⓑ).
  useEffect(() => {
    const doc = getDoc(key)
    if (doc === undefined || doc.saving || read.stamp === doc.stamp || doc.ignoredStamps.has(read.stamp)) return
    // 수정 중이거나, 편집 가능한 문서인데 디스크가 UTF-8 로 안 읽히게 바뀌었으면(넣으면 저장이 바이트를 깨뜨린다) 덮지 않고 배너.
    if (doc.dirty || (!read.utf8 && doc.readOnly === null)) {
      const shown = doc.external.kind === 'none' ? null : doc.external.diskStamp
      if (shown !== read.stamp) setExternal(doc, { kind: 'changed', diskStamp: read.stamp, deleted: false })
      return
    }
    const editor = editorRef.current
    const state = editor?.saveViewState() ?? null
    reloadDoc(doc, { text: read.text, bom: read.bom, stamp: read.stamp })
    if (editor !== null && state !== null) editor.restoreViewState(state)
    const host = hostRef.current
    if (host !== null) host.dataset.editorUpdated = String(Date.now())
  }, [read, key])

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
