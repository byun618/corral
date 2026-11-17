// 소스 제어 diff 탭 몸통 (LIFE-683 S5·S6) — 양쪽 읽기 전용. 왼쪽이 없으면(인덱스 추가·삭제) 단일 읽기 전용 편집기(VS Code `vscode.open`).
//
// · 읽기: 작업 파일 = 기존 파일 읽기 IPC(`readFile` — 가둠·상한·바이너리), HEAD·인덱스 = `scmRead`(main 이 고정 argv). 렌더러는 ref 를 고르지 않는다.
// · 갱신(S6): 그 루트의 git push 차례(`stamp`)가 바뀌면 양쪽을 다시 읽어, 내용이 달라진 모델만 바꾼다 — view state(스크롤)를 저장했다 되살린다.
//   대상이 변경 목록에서 사라져도 탭은 남고 같은 대상을 다시 읽는다. 양쪽이 같아지면 「변경 없음」 안내 띠.
// · Monaco 는 파일 탭과 같은 지연 로딩(`../editor/monaco.js` 동적 import)·같은 편집기 worker. 한쪽이라도 20 MB 를 넘으면 파일 탭과 같은 대용량 처리(fix r1 R1-10).
// · 감시(fix r1 R1-01 · S8 정정 r1): 영역에 보이는 diff 탭(`watch`)은 그 루트 허브 구독을 잡는다 — 패널이 닫혔거나 상세 보기여도 git push(= 갱신 신호)가 온다.
//   참조 셈(`explorer-watch-refs.ts`)이라 탐색기·소스 제어와 같은 루트면 한 벌이고, 탭이 안 보이면(탭 전환·닫음·작업 페이지·설정) 해제한다.
import { useEffect, useRef, useState } from 'react'
import { diffTitle, sidesOf, type ScmDiffTarget, type ScmSide } from '../../../shared/scm.js'
import { LARGE_FILE_BYTES } from '../../../shared/file-view.js'
import { acquireExplorerWatch } from '../explorer-watch-refs.js'
import { Codicon } from './ExplorerIcons.js'
import './scm.css'

type MonacoModule = typeof import('../editor/monaco.js')
type Model = ReturnType<MonacoModule['createModel']>

export type SideContent = { kind: 'text'; text: string; size: number } | { kind: 'missing' } | { kind: 'binary' } | { kind: 'too_large' } | { kind: 'error'; message: string }

const SIDE_LABEL: Readonly<Record<ScmSide, string>> = { head: 'HEAD', index: '인덱스', working: '작업 트리' }

/** 한 쪽 읽기 — 작업 파일은 `readFile`, 나머지는 `scmRead`. */
export async function readSide(input: { root: string; side: ScmSide; rel: string }): Promise<SideContent> {
  if (input.side === 'working') {
    const result = await window.corral.readFile({ root: input.root, rel: input.rel })
    if (!result.ok) return result.code === 'not_found' ? { kind: 'missing' } : { kind: 'error', message: result.error }
    return result.kind === 'text' ? { kind: 'text', text: result.text, size: result.size } : { kind: result.kind }
  }
  const result = await window.corral.scmRead({ root: input.root, rel: input.rel, side: input.side })
  if (!result.ok) return { kind: 'error', message: result.error }
  return result.kind === 'text' ? { kind: 'text', text: result.text, size: result.size } : { kind: result.kind }
}

/** 편집기 대신 보일 안내 — 둘 중 하나라도 글이 아니면(없음은 빈 글로 본다). 없으면 null. */
export function blockingNotice(sides: readonly SideContent[]): string | null {
  for (const side of sides) {
    if (side.kind === 'binary') return '바이너리 파일이라 내용을 표시하지 않습니다.'
    if (side.kind === 'too_large') return '파일이 너무 커서(50 MB 초과) 내용을 표시하지 않습니다.'
    if (side.kind === 'error') return `읽지 못했습니다 — ${side.message}`
  }
  return null
}

const textOf = (side: SideContent): string => (side.kind === 'text' ? side.text : '')

export function DiffView({
  root,
  target,
  stamp,
  watch,
  onOpenFile,
  groupId,
  onActivate,
}: {
  root: string
  target: ScmDiffTarget | null
  stamp: number
  watch: boolean
  onOpenFile: (rel: string) => void
  /** 이 diff 가 선 영역 — 본문 드롭 대상 표지(`data-diff-group`, LIFE-823 B5 — 탭 끌기 `DROP_BODY_SELECTOR`). */
  groupId?: string
  /** 본문을 누르면 이 영역을 활성으로 (LIFE-824 C8 — base 누락). */
  onActivate?: () => void
}): React.JSX.Element {
  useEffect(() => {
    if (!watch) return
    return acquireExplorerWatch(root)
  }, [watch, root])
  // 읽은 내용은 그 대상(`key`)과 같이 든다 — 대상이 바뀐 직후 옛 대상 내용으로 편집기 모양(diff/단일)을 정하지 않게(fix r1 R1-07 시험이 잡음).
  const [loaded, setLoaded] = useState<{ key: string; left: SideContent | null; right: SideContent } | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  /** 편집기가 붙은 차례 — 붙은 뒤 마지막 내용을 한 번 싣는다. */
  const [ready, setReady] = useState(0)
  const targetKey = target === null ? null : JSON.stringify(target)
  const contents = loaded !== null && loaded.key === targetKey ? loaded : null

  useEffect(() => {
    if (target === null || targetKey === null) return
    let cancelled = false
    const sides = sidesOf(target)
    void Promise.all([sides.left === null ? Promise.resolve(null) : readSide({ root, ...sides.left }), readSide({ root, ...sides.right })]).then(([left, right]) => {
      if (cancelled) return
      const next = { key: targetKey, left, right }
      setLoaded((previous) => (previous !== null && JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
    })
    return () => {
      cancelled = true
    }
    // targetKey 가 target 의 값 정체다 — target 객체는 렌더마다 새로 파싱된다.
  }, [root, targetKey, stamp])

  const single = contents !== null && contents.left === null
  const notice = contents === null ? null : blockingNotice(contents.left === null ? [contents.right] : [contents.left, contents.right])
  const editable = contents !== null && notice === null
  const large = contents !== null && [contents.left, contents.right].some((side) => side !== null && side.kind === 'text' && side.size > LARGE_FILE_BYTES)
  const editorRef = useRef<{ kind: 'diff' | 'single'; dispose: () => void; update: (input: { left: string; right: string }) => void } | null>(null)

  // 편집기 만들기 — 대상·모양(diff/단일)이 바뀔 때만. 내용 갱신은 아래 효과.
  useEffect(() => {
    const host = hostRef.current
    if (host === null || !editable || target === null) return
    let disposed = false
    const rel = target.rel
    void import('../editor/monaco.js').then(async (module) => {
      const language = large ? 'plaintext' : await module.languageFor(rel)
      if (disposed) return
      const model = (text: string, side: string): Model => module.createModel({ text, language, key: `diff:${side}\0${rel}` })
      const setText = (target: Model, text: string): void => {
        if (target.getValue() !== text) target.setValue(text)
      }
      if (single) {
        const editor = module.createEditor({ host, large, readOnly: true })
        const right = model('', 'right')
        editor.setModel(right)
        editorRef.current = {
          kind: 'single',
          update: ({ right: text }) => {
            const view = editor.saveViewState()
            setText(right, text)
            if (view !== null) editor.restoreViewState(view)
          },
          dispose: () => {
            editor.dispose()
            right.dispose()
          },
        }
      } else {
        const editor = module.createDiffEditor({ host, large })
        const original = model('', 'left')
        const modified = model('', 'right')
        editor.setModel({ original, modified })
        editorRef.current = {
          kind: 'diff',
          update: ({ left, right }) => {
            const view = editor.saveViewState()
            setText(original, left)
            setText(modified, right)
            if (view !== null) editor.restoreViewState(view)
          },
          dispose: () => {
            editor.dispose()
            original.dispose()
            modified.dispose()
          },
        }
      }
      host.dataset.editorReady = single ? 'single' : 'diff'
      setReady((value) => value + 1)
    })
    return () => {
      disposed = true
      editorRef.current?.dispose()
      editorRef.current = null
      delete host.dataset.editorReady
    }
  }, [targetKey, single, editable, large])

  useEffect(() => {
    if (contents === null || editorRef.current === null) return
    editorRef.current.update({ left: contents.left === null ? '' : textOf(contents.left), right: textOf(contents.right) })
  }, [contents, ready])

  // LIFE-824 — tabIndex -1: 키보드로 이 diff 탭에 오면(⌘⌥방향·⌃`·이전/다음 탭·탭 클릭) 포커스가 머물 자리. Tab 순회에는 들지 않는다.
  if (target === null) return <div className="scm-diff-message" data-diff-group={groupId} tabIndex={-1} onMouseDown={onActivate}>이 diff 탭의 대상을 읽지 못했습니다(손상된 탭).</div>
  const sides = sidesOf(target)
  const unchanged = contents !== null && notice === null && contents.left !== null && textOf(contents.left) === textOf(contents.right)
  const missing = contents !== null && contents.right.kind === 'missing'
  return (
    <div className="scm-diff" data-scm-diff={target.mode} data-scm-diff-rel={target.rel} data-diff-group={groupId} tabIndex={-1} onMouseDown={onActivate}>
      <div className="scm-diff-head">
        <span className="scm-diff-sides" title={diffTitle(target)}>
          {sides.left === null ? `${SIDE_LABEL[sides.right.side]} · ${target.rel}` : `${SIDE_LABEL[sides.left.side]}${sides.left.rel === sides.right.rel ? '' : ` ${sides.left.rel}`} ↔ ${SIDE_LABEL[sides.right.side]} · ${target.rel}`} · 읽기 전용
        </span>
        {target.mode === 'deleted' ? null : (
          <button type="button" className="scm-diff-open" data-scm-diff-open="" title="파일 열기" onClick={() => onOpenFile(target.rel)}>
            <Codicon name="go-to-file" />
            파일 열기
          </button>
        )}
      </div>
      {unchanged ? (
        <div className="scm-diff-notice" data-scm-diff-unchanged="">
          변경 없음 — 양쪽 내용이 같습니다.
        </div>
      ) : null}
      {missing && notice === null ? (
        <div className="scm-diff-notice" data-scm-diff-missing="">
          {SIDE_LABEL[sides.right.side]} 쪽에 이 파일이 없습니다.
        </div>
      ) : null}
      {notice !== null ? (
        <div className="scm-diff-message" data-scm-diff-blocked="">
          {notice}
        </div>
      ) : (
        <div className="scm-diff-host" ref={hostRef} data-scm-diff-host="" />
      )}
    </div>
  )
}
