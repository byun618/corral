// 파일 탭 본문 (LIFE-590 E4) — 영역의 활성 탭이 파일 탭이면 터미널 자리에 선다. 내용은 main 읽기 전용 IPC(`readFile` — 가둠·상한·바이너리 판정)로만 받는다.
//
// 텍스트 = Monaco 읽기 전용(`editor/monaco.ts` — **이 컴포넌트가 처음 텍스트를 그릴 때 동적 import**, 그 전에는 편집기 코드가 로드되지 않는다 — E8ⓒ).
// 비활성 탭은 언마운트된다(터미널과 같은 구조) — 스크롤·선택 위치(Monaco view state)는 탭 id 별로 `viewStates` 에 맡겨 두고 다시 마운트할 때 되살린다(E3ⓕ).
// 바이너리·상한 초과·읽기 실패는 한 줄 안내(문구는 VS Code `binaryEditor.ts` 를 옮김). 이미지·Markdown 미리보기·외부 변경 반영은 첫 화면 확인 뒤(E10).
import { useEffect, useRef, useState } from 'react'
import type { FileReadResult } from '../../../shared/file-view.js'
import './file-view.css'

type MonacoModule = typeof import('../editor/monaco.js')
type Viewer = ReturnType<MonacoModule['createViewer']>
type ViewState = ReturnType<Viewer['saveViewState']>

/** 탭 id 별 Monaco view state — App 이 worktree 마다 하나 들고 있다(렌더 대상이 아니다). */
export type ViewStateStore = Map<string, ViewState>

const formatBytes = (size: number): string =>
  size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`

export function FileView({
  root,
  rel,
  tabId,
  groupId,
  viewStates,
  onActivate,
}: {
  root: string
  rel: string
  tabId: string
  groupId: string
  viewStates: ViewStateStore
  /** 본문을 누르면 이 영역이 활성이 된다(터미널 본문과 같다). */
  onActivate: () => void
}): React.JSX.Element {
  const [read, setRead] = useState<FileReadResult | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setRead(null)
    void window.corral.readFile({ root, rel }).then((result) => {
      if (!cancelled) setRead(result)
    })
    return () => {
      cancelled = true
    }
  }, [root, rel])

  const text = read !== null && read.ok && read.kind === 'text' ? read.text : null
  useEffect(() => {
    if (text === null) return
    const host = hostRef.current
    if (host === null) return
    let disposed = false
    let viewer: Viewer | null = null
    let model: ReturnType<MonacoModule['createModel']> | null = null
    void import('../editor/monaco.js').then(async (module) => {
      const language = await module.languageFor(rel)
      if (disposed) return
      viewer = module.createViewer(host)
      model = module.createModel({ text, language, tabId })
      viewer.setModel(model)
      const saved = viewStates.get(tabId)
      if (saved !== undefined && saved !== null) viewer.restoreViewState(saved)
      host.dataset.editorReady = language
    })
    return () => {
      disposed = true
      if (viewer !== null) {
        viewStates.set(tabId, viewer.saveViewState())
        viewer.dispose()
      }
      model?.dispose()
      delete host.dataset.editorReady
    }
  }, [text, rel, tabId, viewStates])

  return (
    <div
      className="file-group"
      data-file-group={groupId}
      data-file-view={rel}
      onMouseDown={() => onActivate()}
    >
      {read === null ? (
        <div className="file-view-notice" data-file-notice="loading" />
      ) : !read.ok ? (
        <div className="file-view-notice" data-file-notice={read.code}>
          {read.code === 'not_found' ? '파일이 없습니다.' : `파일을 열 수 없습니다 (${read.code}).`}
        </div>
      ) : read.kind === 'binary' ? (
        <div className="file-view-notice" data-file-notice="binary">
          이 파일은 바이너리이거나 지원하지 않는 텍스트 인코딩이라 편집기에 표시하지 않습니다. ({formatBytes(read.size)})
        </div>
      ) : read.kind === 'too_large' ? (
        <div className="file-view-notice" data-file-notice="too_large">
          파일이 너무 커서 표시하지 않습니다. ({formatBytes(read.size)} — 상한 {formatBytes(read.limit)})
        </div>
      ) : (
        <div className="file-editor-host" data-file-editor={tabId} ref={hostRef} />
      )}
    </div>
  )
}
