// 아바타 로고 시험 (LIFE-594 K3ⓐ) — 칸 38·34·32·22 → 로고 20·18·16·13, grok 만 radius 3, 종류 모름은 `·` 글리프, 상태 배지는 그대로.
// 수정 r3(K3ⓐ 정정 2026-10-12): 에이전트 답 머리(칸 22)는 배지를 그리지 않는다 — `dot` 을 넘기지 않으면 배지 없음.
// RN 을 DOM 가짜로 바꿔 `Image` 에 간 속성만 본다 — 실제 그림(밀도 선택·계단)은 네이티브 관문(K5) 몫이다.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentKind } from '../src/core/list'
import { Avatar } from '../src/ui/StatusGlyph'

const KINDS: AgentKind[] = ['claude', 'codex', 'grok']
type Box = { width?: number; height?: number; borderRadius?: number }
type Place = { position?: string; right?: number; bottom?: number; width?: number; height?: number }
vi.mock('react-native', () => ({
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  // 배지 = 절대 배치 View — 자리·크기를 속성으로 낸다.
  View: ({ children, style }: { children: ReactNode; style?: Place }) =>
    style?.position === 'absolute' ? <div data-badge={`${style.right},${style.bottom},${style.width},${style.height}`}>{children}</div> : <div>{children}</div>,
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

describe('상태 배지 — 답 머리만 없음 (수정 r3)', () => {
  const BADGE = 'data-badge="-6,-6,21,21"'

  it('dot 을 넘기면 우하단 배지(right -6 · bottom -6 · 21×21) 하나 — 목록 38·워커 32·대화 머리 34', () => {
    for (const size of [38, 32, 34]) {
      const html = renderToStaticMarkup(<Avatar kind="claude" dot="done" size={size} />)
      expect(html.split('data-badge=').length - 1).toBe(1)
      expect(html).toContain(BADGE)
      expect(html).toContain('✓')
    }
  })

  it('dot 을 넘기지 않으면 배지 없음, 로고 13 그대로 · 종류 모름은 `·` 그대로', () => {
    const html = renderToStaticMarkup(<Avatar kind="claude" size={22} />)
    expect(html).not.toContain('data-badge')
    expect(html).toContain('data-w="13"')
    const unknown = renderToStaticMarkup(<Avatar kind={null} size={22} />)
    expect(unknown).not.toContain('data-badge')
    expect(unknown).toContain('<span>·</span>')
  })

  it('자리별 호출 — 답 머리(Conversation)만 dot 없이, 목록·대화 머리는 dot 을 넘긴다', () => {
    const avatars = (file: string) => readFileSync(path.join(__dirname, file), 'utf8').match(/<Avatar [^>]*\/>/g) ?? []
    expect(avatars('../src/ui/Conversation.tsx')).toEqual(['<Avatar kind={kind} size={22} />'])
    expect(avatars('../src/ui/ChannelList.tsx')).toEqual(['<Avatar kind={channel.kind} dot={row.dot} closed={row.closed} size={avatar} />'])
    expect(avatars('../app/channel/[id].tsx')).toEqual(["<Avatar kind={channel.kind} dot={status?.dot ?? 'unverifiable'} closed={closed} size={34} />"])
  })
})
