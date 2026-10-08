// herdr 미설치 카드의 안내 한 줄 (LIFE-555 A9 → LIFE-556 B10) — 카드를 실제로 그려 문구를 본다.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BackendCard, BUNDLED_MISSING_HINT, DEV_MISSING_HINT } from './BackendCard.js'

const render = (bundled: boolean, searched: string[]): string =>
  renderToStaticMarkup(createElement(BackendCard, { status: { kind: 'missing', searched, bundled }, onStart: () => undefined }))

describe('BackendCard missing (LIFE-556 B10)', () => {
  it('설치본(동봉 바이너리 없음)은 재설치를 안내하고 brew 를 말하지 않는다', () => {
    const html = render(true, ['/Applications/corral.app/Contents/Resources/backend/herdr'])
    expect(html).toContain('앱에 들어 있는 herdr 를 찾지 못했습니다')
    expect(html).toContain('Contents/Resources/backend/herdr')
    expect(html).toContain('data-backend-install="bundled"')
    expect(html).toContain(BUNDLED_MISSING_HINT)
    expect(html).not.toMatch(/brew/)
  })
  it('개발 실행은 PATH·CORRAL_HERDR_BIN 을 안내하고 brew install 을 권하지 않는다', () => {
    const html = render(false, ['/opt/homebrew/bin/herdr'])
    expect(html).toContain('herdr 를 찾지 못했습니다')
    expect(html).toContain('data-backend-install="dev"')
    expect(html).toContain(DEV_MISSING_HINT)
    expect(html).not.toMatch(/brew install/)
  })
})
