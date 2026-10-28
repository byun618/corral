// LIFE-590 E4ⓓ — Markdown 링크/이미지 대상 판정(단위) + 악성 fixture 양성 대조(정화 **전** marked 출력에 위험이 실제로 들어 있다).
// **정화 자체는 여기서 판정하지 않는다** — happy-dom 에서 DOMPurify 가 `<script>` 를 남기고 `<h1>` 을 지우는 것을 확인했다(2026-10-13, 이 작업 원자료
// `raw/claude/happy-dom-dompurify.txt`): 시험 환경의 DOM 이 틀리면 통과·실패 둘 다 뜻이 없다. 정화 판정은 실제 Chromium — 격리 앱에서 악성 fixture 를 미리보기로 열고 DOM 을
// 검사하는 LIFE-590 관문 `md-sanitize.mjs`(E4ⓓ).
import { Marked } from 'marked'
import { describe, expect, it } from 'vitest'
import { resolveMarkdownTarget, slugOf } from './markdown.js'

const EVIL = [
  '# 제목',
  '<script>window.__pwned = 1</script>',
  '<img src="x.png" onerror="window.__pwned = 2">',
  '[누르기](javascript:window.__pwned=3)',
  '<a href="javascript:alert(1)" onclick="window.__pwned=4">a</a>',
  '<iframe src="https://example.invalid"></iframe>',
  '<form action="https://example.invalid"><input name="q"></form>',
  '<svg><script>window.__pwned=5</script></svg>',
  '<div style="background:url(https://example.invalid/t.png)">s</div>',
  '![원격](https://example.invalid/r.png) ![로컬](./img/a.png)',
  '[외부](https://example.com) [상대](../docs/b.md#sec)',
].join('\n\n')

describe('E4ⓓ Markdown 악성 fixture 양성 대조', () => {
  it('양성 대조 — 정화 전 marked 출력에는 script·onerror·javascript:·iframe 이 있다', () => {
    const raw = String(new Marked({ gfm: true, async: false }).parse(EVIL))
    for (const needle of ['<script>', 'onerror=', 'javascript:', '<iframe', '<form', 'style=']) expect(raw).toContain(needle)
  })

})

describe('E4ⓓ 링크·이미지 대상', () => {
  const at = (target: string, image = false) => resolveMarkdownTarget({ fileRel: 'docs/guide/readme.md', target, image })
  it('상대 경로는 파일 폴더 기준, / 로 시작하면 루트 기준, 조각·쿼리는 뗀다', () => {
    expect(at('./img/a.png', true)).toEqual({ kind: 'file', rel: 'docs/guide/img/a.png', fragment: null })
    expect(at('../b.md#sec')).toEqual({ kind: 'file', rel: 'docs/b.md', fragment: 'sec' })
    expect(at('/src/x.ts?raw')).toEqual({ kind: 'file', rel: 'src/x.ts', fragment: null })
    expect(at('my%20file.md')).toEqual({ kind: 'file', rel: 'docs/guide/my file.md', fragment: null })
  })
  it('루트 밖 `..` 탈출은 거절', () => {
    expect(at('../../../etc/passwd')).toEqual({ kind: 'refused', reason: 'outside' })
  })
  it('http(s) — 링크는 외부, 이미지는 원격 거절 · 그 밖 스킴 거절', () => {
    expect(at('https://example.com/x')).toEqual({ kind: 'external', url: 'https://example.com/x' })
    expect(at('https://example.com/x.png', true)).toEqual({ kind: 'refused', reason: 'remote' })
    expect(at('//cdn.example.com/x.png', true)).toEqual({ kind: 'refused', reason: 'remote' })
    for (const target of ['file:///etc/passwd', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'mailto:a@b.c']) expect(at(target).kind).toBe('refused')
  })
  it('#조각은 같은 문서', () => {
    expect(at('#설치-방법')).toEqual({ kind: 'fragment', fragment: '설치-방법' })
    expect(slugOf('설치 방법!')).toBe('설치-방법')
  })
})
