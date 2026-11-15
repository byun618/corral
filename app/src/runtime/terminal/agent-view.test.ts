/**
 * LIFE-787 C1 — the agent-view judgment the runtime makes before it writes to a Claude pane.
 *
 * The screen half is LIFE-770's `agentViewShown` itself (one implementation, phone and CLI), run
 * over the same real 2.1.296 screens (`main/fixtures/`). The title half is new: its marks are the
 * agent view docs' wording (`claude agents`, `2 awaiting input · claude agents`) and the title the
 * coordinator measured on the real pane (`6 awaiting input · claude agents` → back to `L787-A`,
 * corral-specs LIFE-787 probe1 21-title). Each half refuses on its own.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentViewSeen, agentViewTitle } from './agent.js'

const FIXTURES = path.join(__dirname, '..', '..', 'main', 'fixtures')
const screen = (name: string): string => fs.readFileSync(path.join(FIXTURES, `${name}.ansi`), 'utf8')

/** Every fixture LIFE-770 asserts as agent view (`main/mobile/agent-view.test.ts` 「C1 실표본」). */
const VIEW = ['view-default', 'view-down', 'view-help', 'view-peek', 'view-peek-typed', 'view-typed', 'view-down-typed',
  'narrow-view-default', 'narrow-view-down', 'narrow-view-typed', 'narrow-view-help', 'narrow-view-peek',
  'manual-view-default', 'manual-view-typed', 'manual-narrow-view-default', 'manual-narrow-view-down', 'manual-narrow-view-typed',
  'view-header', 'view-header-collapsed', 'direct-first', 'view-delete-confirm', 'view-fold',
  'width44-view-fold', 'width43-view-fold', 'width41-view-fold', 'width38-view-fold', 'width37-view-fold',
  'width40-header', 'width40-header-collapsed', 'width40-direct', 'width38-view-default', 'width38-view-down', 'width38-view-typed',
  'width38-header', 'width32-view-peek', 'width28-view-peek'].map(name => `agent-view/${name}`)
/** Ordinary prompts (empty, typed, quoted text) and the question·permission·review screens of `continued-in/`. */
const NOT_VIEW = ['normal-named-empty', 'normal-quoted', 'normal-try-placeholder', 'normal-typed-placeholder', 'narrow-normal-empty',
  'narrow-normal-typed-placeholder', 'width28-normal-empty', 'width28-normal-typed-placeholder', 'width32-normal-empty',
  'width32-normal-typed-placeholder', 'manual-normal-empty'].map(name => `agent-view/${name}`)
  .concat(['screen-named-draft', 'screen-named-empty', 'screen-named-permission', 'screen-named-review', 'screen-named-tabs',
    'screen-named-tabs-2', 'screen-narrow-cut-empty', 'screen-narrow-cut-question', 'screen-narrow-empty', 'screen-narrow-question',
    'screen-narrow-review', 'screen-plain-empty', 'screen-question'].map(name => `continued-in/${name}`))

describe('C1ⓐ 실표본 화면', () => {
  it.each(VIEW)('%s → agent view (screen)', name => {
    expect(agentViewSeen({ kind: 'claude', screen: screen(name), title: null })).toEqual(['screen'])
  })
  it.each(NOT_VIEW)('%s → not agent view', name => {
    expect(agentViewSeen({ kind: 'claude', screen: screen(name), title: null })).toEqual([])
  })
})

describe('C1ⓑ 탭 제목', () => {
  it.each(['claude agents', '2 awaiting input · claude agents', '6 awaiting input · claude agents', '  6 awaiting input · claude agents  '])('%j → agent view', title => {
    expect(agentViewTitle(title)).toBe(true)
  })
  it.each([null, '', 'L787-A', '✳ L787-A', '✳ Claude Code', 'claude', 'claude agents list', 'my claude agents', '6 awaiting input'])('%j → not', title => {
    expect(agentViewTitle(title)).toBe(false)
  })
  it('합성: 제목만 맞고 화면은 일반 프롬프트 → title 하나로 거절', () => {
    expect(agentViewSeen({ kind: 'claude', screen: screen('agent-view/normal-named-empty'), title: '6 awaiting input · claude agents' })).toEqual(['title'])
  })
  it('합성: 화면만 맞고 제목은 세션 이름·없음 → screen 하나로 거절 (CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 의 꼴)', () => {
    expect(agentViewSeen({ kind: 'claude', screen: screen('agent-view/view-default'), title: 'L787-A' })).toEqual(['screen'])
    expect(agentViewSeen({ kind: 'claude', screen: screen('agent-view/view-default'), title: null })).toEqual(['screen'])
  })
  it('둘 다 맞으면 둘 다 적는다', () => {
    expect(agentViewSeen({ kind: 'claude', screen: screen('agent-view/view-default'), title: 'claude agents' })).toEqual(['screen', 'title'])
  })
})

describe('C1ⓒ claude 가 아닌 kind', () => {
  it.each(['codex', 'grok'] as const)('%s — 화면·제목이 agent view 여도 아니다', kind => {
    expect(agentViewSeen({ kind, screen: screen('agent-view/view-default'), title: '6 awaiting input · claude agents' })).toEqual([])
  })
})
