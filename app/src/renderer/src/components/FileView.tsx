// 파일 탭 본문 (LIFE-590 E4·E5) — 영역의 활성 탭이 파일 탭이면 터미널 자리에 선다. 내용은 main 읽기 전용 IPC(`readFile`·`readImage` — 가둠·상한·바이너리 판정)로만 받는다.
//
// 텍스트 = Monaco 읽기 전용(`editor/monaco.ts` — **이 컴포넌트가 처음 텍스트를 그릴 때 동적 import**, 그 전에는 편집기 코드가 로드되지 않는다 — E8ⓒ).
// 비활성 탭은 언마운트된다(터미널과 같은 구조) — 스크롤·선택 위치(Monaco view state)는 탭 id 별로 `viewStates` 에 맡겨 두고 다시 마운트할 때 되살린다(E3ⓕ).
// 외부 변경(E5) — App 이 main 감시 push 의 `stamp` 를 내려준다. 마지막으로 읽은 `stamp` 와 다르면 다시 읽고, **같은 편집기·모델에 내용만 바꿔** 스크롤을 지킨다.
// 지워지면(`exists: false`) 마지막 내용을 그대로 둔다(VS Code 와 같다 — 탭에 「삭제됨」, MainTabBar). 같은 경로에 다시 생기면 새 stamp 로 다시 읽는다.
// 이미지(E4ⓔ) = 바이트 → 캔버스·정화한 인라인 SVG(`editor/image.ts`). Markdown(E4ⓓ) = 원문(Monaco)과 미리보기(`editor/markdown.ts`) 전환 — 기본은 원문(VS Code 와 같다).
// 바이너리·상한 초과·읽기 실패는 한 줄 안내(문구는 VS Code `binaryEditor.ts` 를 옮김).
import { useEffect, useRef, useState } from 'react'
import { imageMimeOf, LARGE_FILE_BYTES, type FileReadResult, type ImageReadResult } from '../../../shared/file-view.js'
import './file-view.css'

type MonacoModule = typeof import('../editor/monaco.js')
type Viewer = ReturnType<MonacoModule['createViewer']>
type Model = ReturnType<MonacoModule['createModel']>
type ViewState = ReturnType<Viewer['saveViewState']>

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
  useEffect(() => {
    if (watched === null || !watched.exists || watched.stamp === null || readStamp === null || watched.stamp === readStamp) return
    setVersion((value) => value + 1)
  }, [watched, readStamp])
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
  else if (markdown && mode === 'preview') body = <MarkdownPreview source={read.text} root={root} rel={rel} onOpenFile={onOpenFile} />
  else body = <TextBody text={read.text} rel={rel} tabId={tabId} large={large} viewStates={viewStates} />

  return (
    <div className="file-group" data-file-group={groupId} data-file-view={rel} onMouseDown={() => onActivate()}>
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
          대용량 파일({formatBytes(read !== null && read.ok ? read.size : 0)}) — 구문 강조·접기를 끄고 일반 텍스트로 표시합니다.
        </div>
      ) : null}
      {body}
    </div>
  )
}

/** 텍스트 — Monaco 하나를 이 탭 동안 유지하고, 다시 읽은 내용은 같은 모델에 넣는다(스크롤·선택 유지 — E5ⓐ). */
function TextBody({ text, rel, tabId, large, viewStates }: { text: string; rel: string; tabId: string; large: boolean; viewStates: ViewStateStore }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const modelRef = useRef<Model | null>(null)
  const textRef = useRef(text)
  textRef.current = text

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    let disposed = false
    void import('../editor/monaco.js').then(async (module) => {
      const language = large ? 'plaintext' : await module.languageFor(rel)
      if (disposed) return
      const viewer = module.createViewer({ host, large })
      const model = module.createModel({ text: textRef.current, language, tabId })
      viewer.setModel(model)
      const saved = viewStates.get(tabId)
      if (saved !== undefined && saved !== null) viewer.restoreViewState(saved)
      viewerRef.current = viewer
      modelRef.current = model
      host.dataset.editorReady = language
    })
    return () => {
      disposed = true
      const viewer = viewerRef.current
      if (viewer !== null) {
        viewStates.set(tabId, viewer.saveViewState())
        viewer.dispose()
      }
      modelRef.current?.dispose()
      viewerRef.current = null
      modelRef.current = null
      delete host.dataset.editorReady
    }
  }, [rel, tabId, large, viewStates])

  useEffect(() => {
    const viewer = viewerRef.current
    const model = modelRef.current
    if (viewer === null || model === null || model.getValue() === text) return
    const state = viewer.saveViewState()
    model.setValue(text)
    if (state !== null) viewer.restoreViewState(state)
    const host = hostRef.current
    if (host !== null) host.dataset.editorUpdated = String(Date.now())
  }, [text])

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
