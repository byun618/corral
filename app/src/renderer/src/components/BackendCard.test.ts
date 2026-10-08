// herdr 미설치 카드의 안내 한 줄 (LIFE-555 A9 → LIFE-556 B10) — 카드를 실제로 그려 문구를 본다.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BackendCard, BUNDLED_MISSING_HINT, DEV_GUARD_BUILD_COMMAND, DEV_MISSING_HINT, DEV_STALE_HINT } from './BackendCard.js'

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

describe('BackendCard 레포 guard 안내 (LIFE-561 C3·C8ⓑ)', () => {
  it('개발 실행 미설치 카드가 빌드 명령 문자열을 안내한다', () => {
    const html = render(false, ['레포 guard /r/.git/corral-herdr-dev/k/herdr-0.9.0/target/debug/herdr', '/opt/homebrew/bin/herdr'])
    expect(DEV_GUARD_BUILD_COMMAND).toBe('npm --prefix app run herdr:guard')
    expect(html).toContain(DEV_GUARD_BUILD_COMMAND)
    expect(html).not.toMatch(/brew install/)
  })
  it('낡음 카드는 어긋난 이유 한 줄·경로·재빌드 명령을 보인다', () => {
    const html = renderToStaticMarkup(
      createElement(BackendCard, { status: { kind: 'stale', path: '/r/herdr', reason: '영수증의 패치 sha256 이 source.json 과 다르다' }, onStart: () => undefined }),
    )
    expect(html).toContain('data-backend-card="stale"')
    expect(html).toContain('영수증의 패치 sha256 이 source.json 과 다르다')
    expect(html).toContain('/r/herdr')
    expect(html).toContain(DEV_STALE_HINT)
    expect(html).toContain(DEV_GUARD_BUILD_COMMAND)
    expect(html).not.toMatch(/brew/)
    expect(html).not.toMatch(/data-backend-start/)
  })
})
