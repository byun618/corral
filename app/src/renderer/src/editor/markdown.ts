// Markdown 미리보기 (LIFE-590 E4ⓓ) — VS Code 내장 미리보기와 같은 조합(marked → DOMPurify). 둘 다 Monaco 가 이미 끌고 오는 판(marked 14·DOMPurify 3)이다.
//
// 안전 규칙: ① DOMPurify 기본 프로필 — `<script>`·이벤트 핸들러(`on*`)·`javascript:` URL 이 빠진다. 폼·iframe·object·style 은 따로 막는다.
// ② **링크·이미지는 브라우저가 스스로 따라가지 못하게** `href`·`src` 를 `data-md-href`·`data-md-src` 로 옮기고, 그 밖의 리소스 참조(SVG 안 이미지·CSS `url()` 등)는
//    지운다 — `resource-guard.ts`(수정 r1 R1-A) — 클릭은 FileView 가 받아
//    worktree 안 상대 경로면 파일 탭으로, http(s) 면 main 의 외부 열기(`setWindowOpenHandler` — http·https 만)로 보낸다. 창이 이동하는 경로가 없다.
// ③ 이미지는 worktree 안 상대 경로만 — `resolveMarkdownTarget` 이 `..` 탈출·절대·원격을 거르고, 남은 것도 main 이 다시 가둔다(`readImage`).
//    원격 이미지는 띄우지 않는다(VS Code Strict 보안 수준은 https 를 띄운다 — **의도적 차이**, E9).
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import { installResourceGuard, RESOURCE_FORBID_TAGS } from './resource-guard.js'

const marked = new Marked({ gfm: true, breaks: false, async: false })

const FORBID_TAGS = [...RESOURCE_FORBID_TAGS, 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'frame', 'object', 'embed', 'meta', 'base', 'video', 'audio', 'source', 'track', 'picture']

/** Markdown 원문 → 정화한 HTML 글. 링크·이미지는 `data-md-*` 로만 남는다(위 ②). */
export function renderMarkdown(source: string): string {
  installResourceGuard()
  const html = marked.parse(source)
  return DOMPurify.sanitize(typeof html === 'string' ? html : '', { FORBID_TAGS, FORBID_ATTR: ['style'] })
}

export type MarkdownTarget =
  | { kind: 'file'; rel: string; fragment: string | null }
  | { kind: 'fragment'; fragment: string }
  | { kind: 'external'; url: string }
  | { kind: 'refused'; reason: 'remote' | 'outside' | 'scheme' | 'empty' }

/**
 * 미리보기 안 링크·이미지 대상 → 무엇으로 볼지. `fileRel` = 이 Markdown 파일의 worktree 상대 경로.
 * - `#조각` — 같은 문서 안. - `http:`·`https:` — 링크면 외부, 이미지면 거절(원격). - 그 밖의 스킴(`file:`·`javascript:`·`data:` …) — 거절.
 * - 상대 경로 — 이 파일 폴더 기준, `/` 로 시작하면 worktree 루트 기준(VS Code 와 같다). 정규화 뒤 루트 밖(`..`)이면 거절.
 */
export function resolveMarkdownTarget(input: { fileRel: string; target: string; image: boolean }): MarkdownTarget {
  const target = input.target.trim()
  if (target === '') return { kind: 'refused', reason: 'empty' }
  if (target.startsWith('#')) return { kind: 'fragment', fragment: target.slice(1) }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target)
  if (scheme !== null) {
    const name = (scheme[1] ?? '').toLowerCase()
    if (name === 'http' || name === 'https') return input.image ? { kind: 'refused', reason: 'remote' } : { kind: 'external', url: target }
    return { kind: 'refused', reason: 'scheme' }
  }
  if (target.startsWith('//')) return { kind: 'refused', reason: 'remote' }
  const hashAt = target.indexOf('#')
  const queryAt = target.indexOf('?')
  const cut = [hashAt, queryAt].filter((index) => index >= 0)
  const pathPart = cut.length === 0 ? target : target.slice(0, Math.min(...cut))
  const fragment = hashAt >= 0 ? target.slice(hashAt + 1) : null
  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    decoded = pathPart
  }
  const base = decoded.startsWith('/') ? [] : input.fileRel.split('/').slice(0, -1)
  const parts = [...base]
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return { kind: 'refused', reason: 'outside' }
      parts.pop()
      continue
    }
    parts.push(part)
  }
  if (parts.length === 0) return fragment === null ? { kind: 'refused', reason: 'empty' } : { kind: 'fragment', fragment }
  return { kind: 'file', rel: parts.join('/'), fragment }
}

/** 제목 글 → 조각 id(GitHub·VS Code 미리보기와 같은 규칙: 소문자, 글자·숫자·`-`·`_` 외 제거, 공백 → `-`). */
export function slugOf(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}
