// herdr 미설치 카드의 설치 안내 한 줄 (LIFE-555 A9) — 카드를 실제로 그려 문구를 본다.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BackendCard } from './BackendCard.js'

describe('BackendCard missing (LIFE-555 A9)', () => {
  it('찾아 본 위치 목록 뒤에 brew install herdr 안내를 보인다', () => {
    const html = renderToStaticMarkup(createElement(BackendCard, { status: { kind: 'missing', searched: ['/opt/homebrew/bin/herdr'] }, onStart: () => undefined }))
    expect(html).toContain('/opt/homebrew/bin/herdr')
    expect(html).toMatch(/data-backend-install[^>]*>설치: <code>brew install herdr<\/code>/)
  })
})
