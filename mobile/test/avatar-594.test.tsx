// 아바타 로고 시험 (LIFE-594 K3ⓐ) — 칸 38·34·32·22 → 로고 20·18·16·13, grok 만 radius 3, 종류 모름은 `·` 글리프, 상태 배지는 그대로.
// RN 을 DOM 가짜로 바꿔 `Image` 에 간 속성만 본다 — 실제 그림(밀도 선택·계단)은 네이티브 관문(K5) 몫이다.
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentKind } from '../src/core/list'
import { Avatar } from '../src/ui/StatusGlyph'

const KINDS: AgentKind[] = ['claude', 'codex', 'grok']
type Box = { width?: number; height?: number; borderRadius?: number }
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Image: ({ source, style }: { source: string; style: Box }) => <img data-src={source} data-w={style.width} data-h={style.height} data-r={style.borderRadius} />,
  Animated: { View: () => <i data-spinner />, Value: class {}, loop: () => ({ start() {}, stop() {} }), timing: () => ({}) },
  Easing: { linear: () => 0 },
  Platform: { select: (value: { android: string }) => value.android },
}))

function render(kind: AgentKind | null, size: number): string {
  return renderToStaticMarkup(<Avatar kind={kind} dot="idle" size={size} />)
}

describe('Avatar 로고 (LIFE-594 §B)', () => {
  it.each([
    [38, 20],
    [34, 18],
    [32, 16],
    [22, 13],
  ])('칸 %i → 로고 %i', (size, logo) => {
    for (const kind of KINDS) {
      const html = render(kind, size)
      expect(html).toContain(`data-w="${logo}"`)
      expect(html).toContain(`data-h="${logo}"`)
      expect(html).toMatch(new RegExp(`data-src="[^"]*/assets/agents/${kind}\\.png"`))
    }
  })

  it('grok 만 radius 3, claude·codex 는 0', () => {
    expect(render('grok', 38)).toContain('data-r="3"')
    expect(render('claude', 38)).toContain('data-r="0"')
    expect(render('codex', 38)).toContain('data-r="0"')
  })

  it('종류 모름(null)은 이미지 없이 `·` 글리프', () => {
    const html = render(null, 38)
    expect(html).not.toContain('<img')
    expect(html).toContain('<span>·</span>')
  })

  it('옛 글리프(✳ ◆ ✦)가 남지 않는다', () => {
    for (const kind of KINDS) expect(render(kind, 38)).not.toMatch(/[✳◆✦]/)
  })
})
