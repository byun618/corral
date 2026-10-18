// @vitest-environment happy-dom
// LIFE-636 E1ⓐⓒ·E1′·E8 — 상태바 틀(브랜치 라벨·git 배지 · 사용량 슬롯 · spacer · 세그먼트 슬롯), 지운 항목 0, 칩 상태 6종 × 렌더, 키보드·바깥 클릭·inert.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderUsage, UsageSnapshot } from '../../../shared/usage.js'
import { resetUsageStoreForTest } from '../usage-store.js'
import { StatusBar } from './StatusBar.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const NOW = Date.now()
const windows = (pct: number) => [{ label: '5h', windowMinutes: 300, usedPercent: 10, resetsAt: NOW + 3 * 3600_000 }, { label: '7d', windowMinutes: 10080, usedPercent: pct, resetsAt: NOW + 26 * 3600_000 }]
const entry = (id: string, usage: ProviderUsage) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), usage, refreshing: false })

let host: HTMLDivElement
let root: Root
let push: ((snapshot: UsageSnapshot) => void) | null = null
let refreshed: (string | null)[] = []

function install(snapshot: UsageSnapshot): void {
  resetUsageStoreForTest()
  refreshed = []
  Reflect.set(window, 'corral', {
    getUsage: async () => snapshot,
    refreshUsage: async (input: { id: string | null }) => { refreshed.push(input.id); return snapshot },
    onUsage: (listener: (next: UsageSnapshot) => void) => { push = listener; return () => { push = null } },
  })
}
type RenderProps = { inert?: boolean; memoryLabel?: string | null; activeWorktreeLabel?: string | null; dirtyTotal?: number; aheadTotal?: number; behindTotal?: number }
async function render(props: RenderProps = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(StatusBar, {
      inert: props.inert ?? false,
      activeWorktreeLabel: props.activeWorktreeLabel === undefined ? 'LIFE-636-statusbar-usage' : props.activeWorktreeLabel,
      dirtyTotal: props.dirtyTotal ?? 0,
      aheadTotal: props.aheadTotal ?? 0,
      behindTotal: props.behindTotal ?? 0,
      memoryLabel: props.memoryLabel === undefined ? '12.3 MB' : props.memoryLabel,
    }))
  })
}
const q = (selector: string) => host.querySelector(selector)
const chip = (id: string) => host.querySelector<HTMLButtonElement>(`[data-statusbar-usage-chip="${id}"]`)

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'corral')
  resetUsageStoreForTest()
})

describe('E1 상태바 틀', () => {
  it('ⓒ·E1′ⓐ 순서 = 브랜치 라벨 · ●↑↓ 배지 · 사용량 슬롯 · spacer · 세그먼트 슬롯, 세그먼트의 자식은 메모리 한 줄', async () => {
    install({ providers: [] })
    await render()
    const bar = q('[data-statusbar]')!
    expect([...bar.children].map((child) => child.className)).toEqual([
      'statusbar-repo', 'statusbar-badge tone-dirty', 'statusbar-badge tone-ahead', 'statusbar-badge tone-behind',
      'statusbar-usage', 'statusbar-spacer', 'statusbar-segments',
    ])
    expect(bar.children[4]!.hasAttribute('data-statusbar-usage')).toBe(true)
    expect(bar.children[6]!.hasAttribute('data-statusbar-segments')).toBe(true)
    const segments = q('[data-statusbar-segments]')!
    expect(segments.children).toHaveLength(1)
    expect(segments.textContent).toBe('12.3 MB')
  })
  it('ⓐ 지운 항목 0 — groups · panes · ⤢ · agents · xterm', async () => {
    install({ providers: [entry('claude', { status: 'ok', windows: windows(42), updatedAt: NOW })] })
    await render()
    const text = q('[data-statusbar]')!.textContent ?? ''
    for (const gone of ['groups', 'panes', '⤢', 'agents', 'xterm']) expect(text).not.toContain(gone)
    for (const selector of ['[data-statusbar-groups]', '[data-statusbar-panes]']) expect(q(selector)).toBeNull()
  })
  it('E1′ⓐ 브랜치 라벨 `corral / {worktree}`(title = 전체) · 배지 = 받은 합계 그대로', async () => {
    install({ providers: [] })
    await render({ activeWorktreeLabel: 'feature/very-long-branch', dirtyTotal: 7, aheadTotal: 2, behindTotal: 0 })
    const repo = q('.statusbar-repo')!
    expect(repo.textContent).toBe('corral / feature/very-long-branch')
    expect(repo.getAttribute('title')).toBe('corral / feature/very-long-branch')
    expect(q('.statusbar-badge.tone-dirty')!.textContent).toBe('●7')
    expect(q('.statusbar-badge.tone-ahead')!.textContent).toBe('↑2')
    expect(q('.statusbar-badge.tone-behind')!.textContent).toBe('↓0')
  })
  it('E1′ⓐ 활성 worktree 가 없으면 라벨은 `corral` 만(기준 9d7d4d3e9 와 같은 문구)', async () => {
    install({ providers: [] })
    await render({ activeWorktreeLabel: null })
    expect(q('.statusbar-repo')!.textContent).toBe('corral')
  })
  it('메모리 null 이면 세그먼트 슬롯은 비어 있다', async () => {
    install({ providers: [] })
    await render({ memoryLabel: null })
    expect(q('[data-statusbar-segments]')!.children).toHaveLength(0)
  })
  it('inert 는 .statusbar 전체에 — 세그먼트도 따른다(계약 8)', async () => {
    install({ providers: [] })
    await render({ inert: true })
    expect(q('[data-statusbar]')!.hasAttribute('inert')).toBe(true)
  })
})

describe('E8ⓑⓖ 칩 — 상태 6종 × 렌더, 순서', () => {
  it('loading ··· · ok % · stale %+⚠ · error ⚠+사유 · unavailable/disabled 칩 없음, 등록 순서 그대로', async () => {
    install({ providers: [
      entry('claude', { status: 'ok', windows: windows(42), updatedAt: NOW }),
      entry('codex', { status: 'stale', windows: windows(70), updatedAt: NOW - 60_000, error: { kind: 'rate_limited', message: '요청 제한 (HTTP 429)' } }),
      entry('grok', { status: 'error', error: { kind: 'expired', message: '로그인 만료 — grok 실행 시 갱신' }, checkedAt: NOW }),
      entry('extra', { status: 'loading' }),
      entry('gone', { status: 'unavailable', reason: '로그인 정보 없음' }),
      entry('off', { status: 'disabled' }),
    ] })
    await render()
    const chips = [...host.querySelectorAll<HTMLElement>('[data-statusbar-usage-chip]')]
    expect(chips.map((el) => [el.dataset.statusbarUsageChip, el.dataset.statusbarUsageStatus, el.textContent])).toEqual([
      ['claude', 'ok', '42%'],
      ['codex', 'stale', '70%⚠'],
      ['grok', 'error', '⚠만료'],
      ['extra', 'loading', 'E···'],
    ])
    expect(chip('codex')!.getAttribute('title')).toContain('요청 제한')
    expect(chip('grok')!.getAttribute('title')).toContain('grok 실행 시 갱신')
  })
  it('ⓐ 칩 숫자 = 가장 빡빡한 창 · ⓒ 색 단계 60/80', async () => {
    install({ providers: [
      entry('claude', { status: 'ok', windows: windows(59), updatedAt: NOW }),
      entry('codex', { status: 'ok', windows: windows(60), updatedAt: NOW }),
      entry('grok', { status: 'ok', windows: windows(80), updatedAt: NOW }),
    ] })
    await render()
    const tone = (id: string) => chip(id)!.querySelector('.statusbar-usage-value')!.className
    expect(chip('claude')!.textContent).toBe('59%')
    expect(tone('claude')).toContain('tone-normal')
    expect(tone('codex')).toContain('tone-caution')
    expect(tone('grok')).toContain('tone-warning')
  })
  it('30분 넘은 stale 은 화면에서도 error 로 — 푸시가 없어도 낡은 값을 들지 않는다', async () => {
    install({ providers: [entry('claude', { status: 'stale', windows: windows(42), updatedAt: NOW - 31 * 60_000, error: { kind: 'network', message: '네트워크 오류' } })] })
    await render()
    expect(chip('claude')!.dataset.statusbarUsageStatus).toBe('error')
  })
  it('푸시가 오면 바로 바뀐다(E9ⓒ — 끄면 칩이 사라진다)', async () => {
    install({ providers: [entry('claude', { status: 'ok', windows: windows(42), updatedAt: NOW })] })
    await render()
    expect(chip('claude')).not.toBeNull()
    await act(async () => { push?.({ providers: [entry('claude', { status: 'disabled' })] }) })
    expect(chip('claude')).toBeNull()
  })
})

describe('E8ⓓⓔ 팝오버 · 키보드', () => {
  async function open(): Promise<void> {
    install({ providers: [
      entry('claude', { status: 'ok', windows: [...windows(42), { label: 'Fable 7d', windowMinutes: 10080, usedPercent: 12, resetsAt: null }], updatedAt: NOW }),
      entry('codex', { status: 'error', error: { kind: 'expired', message: '로그인 만료 — codex 실행 시 갱신' }, checkedAt: NOW }),
    ] })
    await render()
    await act(async () => { chip('claude')!.click() })
  }
  it('칩은 포커스 가능한 button(Enter/Space = 네이티브 클릭) · 클릭 = 팝오버(창마다 라벨·막대·%·초기화까지, 갱신 시각, 새로고침)', async () => {
    await open()
    const button = chip('claude')!
    expect(button.tagName).toBe('BUTTON')
    expect(button.type).toBe('button')
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const pop = q('[data-statusbar-usage-popover="claude"]')!
    expect(pop.getAttribute('role')).toBe('dialog')
    expect([...pop.querySelectorAll<HTMLElement>('[data-statusbar-usage-window]')].map((el) => el.dataset.statusbarUsageWindow)).toEqual(['5h', '7d', 'Fable 7d'])
    expect(pop.querySelectorAll('[role="meter"]')).toHaveLength(3)
    expect(pop.textContent).toContain('42% 사용')
    expect(pop.textContent).toMatch(/초기화까지 1d 2h|초기화까지 1d 1h/)
    expect(pop.textContent).toContain('초기화 시각 모름')
    expect(pop.textContent).toMatch(/갱신 \d\d:\d\d/)
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-statusbar-usage-refresh]')!.click() })
    expect(refreshed).toEqual(['claude'])
  })
  it('오류 팝오버는 문구를 그대로', async () => {
    await open()
    await act(async () => { chip('codex')!.click() })
    expect(q('[data-statusbar-usage-popover="codex"]')!.textContent).toContain('로그인 만료 — codex 실행 시 갱신')
  })
  it('r1 R1-9 — 열면 포커스가 팝오버 안 새로고침 버튼으로', async () => {
    await open()
    expect(document.activeElement).toBe(host.querySelector('[data-statusbar-usage-refresh]'))
  })
  it('r2 R2-6 — 갱신 중에도 새로고침 버튼은 disabled 가 아니라 aria-disabled(포커스 유지), 클릭은 무시', async () => {
    install({ providers: [{ ...entry('claude', { status: 'ok', windows: windows(42), updatedAt: NOW }), refreshing: true }] })
    await render()
    await act(async () => { chip('claude')!.click() })
    const button = host.querySelector<HTMLButtonElement>('[data-statusbar-usage-refresh]')!
    expect(document.activeElement).toBe(button)
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { button.click() })
    expect(refreshed).toEqual([])
  })
  it('r2 R2-6 — 새로고침을 누른 뒤 갱신 중 푸시가 와도 포커스는 버튼에 남는다', async () => {
    await open()
    const button = host.querySelector<HTMLButtonElement>('[data-statusbar-usage-refresh]')!
    await act(async () => { button.click() })
    await act(async () => { push?.({ providers: [{ ...entry('claude', { status: 'ok', windows: windows(42), updatedAt: NOW }), refreshing: true }] }) })
    expect(document.activeElement).toBe(host.querySelector('[data-statusbar-usage-refresh]'))
  })
  it('r2 R2-7 — 열린 팝오버의 provider 가 사라지면 anchor 를 비운다: Esc 를 삼키지 않고, 돌아와도 팝오버가 혼자 뜨지 않는다', async () => {
    await open()
    await act(async () => { push?.({ providers: [entry('claude', { status: 'unavailable', reason: '로그인 정보 없음' })] }) })
    expect(q('[data-statusbar-usage-popover]')).toBeNull()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => { document.dispatchEvent(escape) })
    expect(escape.defaultPrevented).toBe(false)
    await act(async () => { push?.({ providers: [entry('claude', { status: 'ok', windows: windows(42), updatedAt: NOW })] }) })
    expect(q('[data-statusbar-usage-popover]')).toBeNull()
    expect(chip('claude')!.getAttribute('aria-expanded')).toBe('false')
  })
  it('r1 R1-4ⓒ — 라벨이 같은 창 둘이어도 둘 다 그린다(key 중복 없음)', async () => {
    install({ providers: [entry('claude', { status: 'ok', windows: [{ label: '7d', windowMinutes: 10080, usedPercent: 40, resetsAt: null }, { label: '7d', windowMinutes: 10080, usedPercent: 70, resetsAt: null }], updatedAt: NOW })] })
    await render()
    await act(async () => { chip('claude')!.click() })
    expect(q('[data-statusbar-usage-popover="claude"]')!.querySelectorAll('[data-statusbar-usage-window="7d"]')).toHaveLength(2)
  })
  it('Esc = 닫고 칩으로 포커스 복귀', async () => {
    await open()
    expect(document.activeElement).not.toBe(chip('claude'))
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(q('[data-statusbar-usage-popover]')).toBeNull()
    expect(document.activeElement).toBe(chip('claude'))
  })
  it('바깥 클릭 = 닫기 · 팝오버 안 클릭은 유지 · 같은 칩 다시 클릭 = 닫기', async () => {
    await open()
    await act(async () => { q('[data-statusbar-usage-popover]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(q('[data-statusbar-usage-popover]')).not.toBeNull()
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(q('[data-statusbar-usage-popover]')).toBeNull()
    await act(async () => { chip('claude')!.click() })
    await act(async () => { chip('claude')!.click() })
    expect(q('[data-statusbar-usage-popover]')).toBeNull()
  })
  it('팔레트·퀵오픈이 열려 inert 가 되면 팝오버를 닫는다', async () => {
    await open()
    await render({ inert: true })
    expect(q('[data-statusbar-usage-popover]')).toBeNull()
  })
})
