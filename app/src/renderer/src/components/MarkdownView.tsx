// 본문·코멘트 markdown 보기 (LIFE-602 C4·C10) — react-markdown 10 + remark-gfm 4.
//
// - **raw HTML 은 요소가 되지 않는다**: react-markdown 은 React 요소로 그리고, `rehype-raw` 를 넣지 않으면 본문의 HTML 은 글자로 보인다
//   (`dangerouslySetInnerHTML` 없음). CSP(`default-src 'self'`)는 그대로 — eval·인라인 스크립트가 필요 없다.
// - 링크: 누르면 늘 기본 동작(창 이동)을 막는다. 절대 http·https 만 `window.open` → main 의 새 창 거절 경로(허용 목록)로 외부 브라우저에.
//   그 밖 scheme·상대 주소는 열지 않는다. main 은 `will-navigate` 도 막아 이중으로 막는다.
// - 이미지: 불러오지 않는다(외부 이미지는 CSP 로도 막힌다) — 대체 글자만.
// - 작업 키 자동 링크: 출처가 준 `keyPattern` 으로만(출처 이름으로 분기하지 않는다). 링크·코드 안의 글은 건드리지 않는다.
// - 체크 칸: `onToggleCheck` 를 주면 누를 수 있다 — 그 항목의 **소스 줄 번호**를 넘긴다(원문의 그 칸만 바꾸는 일은 부르는 쪽이 `toggleCheckLine` 으로).
//   그 줄에서 칸 글자를 찾지 못하는 모양이면 칸은 비활성 + 이유다 — 눌렀는데 아무 일 없는 칸을 두지 않는다(R6-C).
import { createContext, useContext, useMemo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isRecord } from '../../../shared/json.js'
import { linkAction, toggleCheckLine } from '../markdown.js'

/** 체크 칸의 소스 위치 — 항목 시작 줄, 그리고 그 줄에서 칸 글자를 찾았는가(못 찾으면 칸은 비활성 + 이유, R6-C). */
type CheckAt = { line: number; mapped: boolean }
const CheckLine = createContext<CheckAt | null>(null)

const UNMAPPED = '이 체크 칸은 본문에서 위치를 찾지 못해 여기서 바꿀 수 없습니다 — 「편집」 에서 고치세요.'

/** 이 노드들 안의 글은 키 링크로 바꾸지 않는다. */
const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'html', 'definition'])

/** mdast 글 노드를 키 링크 노드로 나눈다 — `data.hName` 으로 `<a data-issue-key>` 가 된다. */
function splitKeys({ value, pattern }: { value: string; pattern: RegExp }): unknown[] {
  const parts: unknown[] = []
  let last = 0
  pattern.lastIndex = 0
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    if (match[0].length === 0) { pattern.lastIndex += 1; continue }
    if (match.index > last) parts.push({ type: 'text', value: value.slice(last, match.index) })
    parts.push({ type: 'issueKey', data: { hName: 'a', hProperties: { dataIssueKey: match[0].toUpperCase(), href: '#' }, hChildren: [{ type: 'text', value: match[0] }] } })
    last = match.index + match[0].length
  }
  if (last === 0) return [{ type: 'text', value }]
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
  return parts
}

function linkKeys({ node, pattern }: { node: unknown; pattern: RegExp }): void {
  if (!isRecord(node) || !Array.isArray(node.children) || (typeof node.type === 'string' && SKIP.has(node.type))) return
  const next: unknown[] = []
  for (const child of node.children) {
    if (isRecord(child) && child.type === 'text' && typeof child.value === 'string') next.push(...splitKeys({ value: child.value, pattern }))
    else {
      linkKeys({ node: child, pattern })
      next.push(child)
    }
  }
  node.children = next
}

/** remark 플러그인 — 키 모양이 없으면 아무것도 하지 않는다. */
function remarkKeyLinks(keyPattern: string | null) {
  return () => (tree: unknown): void => {
    if (keyPattern === null) return
    let pattern: RegExp
    try {
      // 대소문자 구분(R1-R) — 키 모양은 출처가 대문자로 준다. 대소문자를 무시하면 `utf-8`·`sha-256` 같은 낱말까지 키 링크가 된다.
      pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${keyPattern})(?![A-Za-z0-9_])`, 'g')
    } catch {
      return
    }
    linkKeys({ node: tree, pattern })
  }
}

function keyOf(node: unknown): string | null {
  if (!isRecord(node) || !isRecord(node.properties)) return null
  const key = node.properties.dataIssueKey
  return typeof key === 'string' ? key : null
}

function lineOf(node: unknown): number | null {
  if (!isRecord(node) || !isRecord(node.position) || !isRecord(node.position.start)) return null
  const line = node.position.start.line
  return typeof line === 'number' ? line : null
}

function classOf(node: unknown): string[] {
  if (!isRecord(node) || !isRecord(node.properties)) return []
  const value = node.properties.className
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

export function MarkdownView({ source, keyPattern, onOpenKey, onToggleCheck, onBlockedLink, className }: {
  source: string
  keyPattern: string | null
  onOpenKey: (key: string) => void
  /** 체크 칸 누름 — 소스 줄 번호(1부터)와 바꿀 값. 없으면 체크 칸은 읽기 전용. */
  onToggleCheck?: (input: { line: number; checked: boolean }) => void
  onBlockedLink?: (reason: string) => void
  className?: string
}): React.JSX.Element {
  const plugins = useMemo(() => [remarkGfm, remarkKeyLinks(keyPattern)], [keyPattern])
  const components = useMemo((): Components => ({
    a: ({ node, href, children }) => {
      const key = keyOf(node)
      if (key !== null) {
        return (
          <a className="md-key" data-issue-key={key} href="#" onClick={(event) => { event.preventDefault(); onOpenKey(key) }}>{children}</a>
        )
      }
      const action = linkAction(href)
      return (
        <a
          className="md-link"
          href={href}
          title={action.kind === 'external' ? action.url : action.reason}
          data-md-link={action.kind}
          onClick={(event) => {
            // 창 이동은 늘 막는다 — 열 수 있는 것만 새 창 경로(main 허용 목록)로.
            event.preventDefault()
            if (action.kind === 'external') window.open(action.url, '_blank', 'noopener')
            else onBlockedLink?.(action.reason)
          }}
        >
          {children}
        </a>
      )
    },
    img: ({ alt, src }) => <span className="md-img" title={src ?? ''}>[이미지{alt ? `: ${alt}` : ''}]</span>,
    li: ({ node, children }) => {
      const task = classOf(node).includes('task-list-item')
      const item = <li className={task ? 'md-task' : undefined}>{children}</li>
      const line = lineOf(node)
      return task ? <CheckLine.Provider value={line === null ? null : { line, mapped: toggleCheckLine({ source, line }) !== null }}>{item}</CheckLine.Provider> : item
    },
    input: ({ type, checked }) => (type === 'checkbox' ? <CheckBox checked={checked === true} onToggle={onToggleCheck} /> : null),
  }), [onOpenKey, onToggleCheck, onBlockedLink, source])
  return (
    <div className={`md-rendered${className === undefined ? '' : ` ${className}`}`} data-md-rendered="">
      <Markdown remarkPlugins={plugins} components={components}>{source}</Markdown>
    </div>
  )
}

function CheckBox({ checked, onToggle }: { checked: boolean; onToggle: ((input: { line: number; checked: boolean }) => void) | undefined }): React.JSX.Element {
  const at = useContext(CheckLine)
  const enabled = onToggle !== undefined && at !== null && at.mapped
  return (
    <input
      type="checkbox"
      className="md-check"
      data-md-check={at?.line ?? ''}
      checked={checked}
      disabled={!enabled}
      title={onToggle !== undefined && at !== null && !at.mapped ? UNMAPPED : undefined}
      onChange={() => { if (enabled) onToggle({ line: at.line, checked: !checked }) }}
      onClick={(event) => event.stopPropagation()}
    />
  )
}
