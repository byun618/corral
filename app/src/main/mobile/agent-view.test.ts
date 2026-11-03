// Claude agent view 판별 (LIFE-770) — `view-*`·`narrow-*`·`manual-*`·`normal-*` 는 실제 pane 화면(2.1.296, ANSI 유지, 다른 세션 제목·대화를 가림)이다. 「합성」 이라 적은 시험만 그 표본을 고쳐 쓴다.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentViewShown, draftState } from './keys.js'

const FIXTURES = path.join(__dirname, '..', 'fixtures')
const sample = (name: string): string => fs.readFileSync(path.join(FIXTURES, 'agent-view', `${name}.ansi`), 'utf8')
const shown = (screen: string): boolean => agentViewShown({ kind: 'claude', screen })
const draft = (screen: string): string => draftState({ kind: 'claude', screen })

describe('C1 실표본 = agent view', () => {
  it.each([
    ['ⓐ 기본', 'view-default'],
    ['ⓑ ↓ 다른 행', 'view-down'],
    ['ⓒ ? 안내', 'view-help'],
    ['ⓓ Space 패널', 'view-peek'],
    ['ⓓ Space 패널에 글', 'view-peek-typed'],
    ['ⓔ 글을 친 상자', 'view-typed'],
    ['ⓔ ↓ 뒤 글을 친 상자', 'view-down-typed'],
    ['ⓕ 40열 기본(안내 잘림)', 'narrow-view-default'],
    ['ⓕ 40열 ↓(안내 잘림)', 'narrow-view-down'],
    ['ⓕ 40열 글(안내 잘림)', 'narrow-view-typed'],
    ['ⓕ 40열 ? 안내(한 줄씩)', 'narrow-view-help'],
    ['ⓕ 40열 패널(안내 꺾임)', 'narrow-view-peek'],
    ['권한 표지 없는 기본', 'manual-view-default'],
    ['권한 표지 없는 글', 'manual-view-typed'],
    ['권한 표지 없는 40열 기본', 'manual-narrow-view-default'],
    ['권한 표지 없는 40열 ↓', 'manual-narrow-view-down'],
    ['권한 표지 없는 40열 글', 'manual-narrow-view-typed'],
  ])('%s', (_label, name) => {
    expect(shown(sample(name))).toBe(true)
  })
})

describe('C2 합성 — 표본의 스타일·문구를 고친 화면', () => {
  const GRAY = '\x1b[38;2;153;153;153m'
  const PLACEHOLDER = 'describe a task for a new session'
  const FOOTER = 'enter to return · space to reply · ctrl+x to delete · ? for shortcuts'
  const swap = (input: { screen: string; from: string; to: string }): string => {
    expect(input.screen).toContain(input.from)
    return input.screen.replace(input.from, input.to)
  }
  const base = sample('view-default')
  const dimmed = (word: string): string => swap({ screen: base, from: `${GRAY}❯ ${PLACEHOLDER}`, to: `\x1b[2m❯ ${word}` })
  const reworded = swap({ screen: base, from: `${GRAY}❯ ${PLACEHOLDER}`, to: `${GRAY}❯ start something new` })

  it('합성 ⓐ 자리표시만 흐림 → agent view (draftState 만이면 빈 입력으로 읽어 넣는다)', () => {
    const screen = dimmed(PLACEHOLDER)
    expect(draft(screen)).toBe('empty')
    expect(shown(screen)).toBe(true)
  })
  it('합성 ⓑ 자리표시 글자만 바꿈(색 그대로) → 넣지 않음', () => {
    expect(shown(reworded)).toBe(true)
  })
  it('합성 ⓒ 자리표시 글자를 바꾸고 흐림, 하단 안내 그대로 → agent view', () => {
    const screen = dimmed('start something new')
    expect(draft(screen)).toBe('empty')
    expect(shown(screen)).toBe(true)
  })
  it('합성 ⓓ 자리표시 글자·하단 안내 둘 다 바꾸고 흐림 → 못 잡는다(한계 고정 — SURFACE.md)', () => {
    const screen = swap({ screen: dimmed('start something new'), from: FOOTER, to: 'tab to answer · ? for help' })
    expect(shown(screen)).toBe(false)
    expect(draft(screen)).toBe('empty')
  })
  it('합성: 하단 안내만 바꾸고 자리표시가 흐림 → 자리표시로 잡는다(표지 둘은 따로 논다)', () => {
    const screen = swap({ screen: dimmed(PLACEHOLDER), from: FOOTER, to: 'tab to answer · ? for help' })
    expect(shown(screen)).toBe(true)
  })
  it('합성: 하단 안내만 바꾸고 자리표시 색 그대로 → 판별은 못 하고 초안으로 막힌다', () => {
    const screen = swap({ screen: base, from: FOOTER, to: 'tab to answer · ? for help' })
    expect(shown(screen)).toBe(false)
    expect(draft(screen)).toBe('draft')
  })
  it('합성: 패널 안내가 바뀌면 판별은 못 하고 입력 줄 못 찾음으로 막힌다', () => {
    const screen = swap({ screen: sample('view-peek'), from: 'enter to open · space to close · ctrl+x to delete', to: 'tab to answer' })
    expect(shown(screen)).toBe(false)
    expect(draft(screen)).toBe('unknown')
  })
})

describe('C3 오탐 없음', () => {
  const read = (name: string): string => fs.readFileSync(path.join(FIXTURES, 'continued-in', name), 'utf8')
  it.each([
    ['ⓐ 빈 입력', read('screen-plain-empty.ansi')],
    ['ⓐ 권한 표지 없는 빈 입력', sample('manual-normal-empty')],
    ['ⓑ Try 자리표시', sample('normal-try-placeholder')],
    ['ⓒ 이름 붙은 상자', read('screen-named-empty.ansi')],
    ['ⓒ 이름 붙은 상자(복귀 직후)', sample('normal-named-empty')],
    ['ⓒ 이름 붙은 상자 40열', sample('narrow-normal-empty')],
    ['ⓓ 대화 출력에 표지 글 인용', sample('normal-quoted')],
  ])('%s = empty', (_label, screen) => {
    expect(shown(screen)).toBe(false)
    expect(draft(screen)).toBe('empty')
  })
  it.each([
    ['ⓔ 일반 프롬프트에 자리표시 글을 직접 친 화면', sample('normal-typed-placeholder')],
    ['ⓔ 40열', sample('narrow-normal-typed-placeholder')],
  ])('%s = draft', (_label, screen) => {
    expect(shown(screen)).toBe(false)
    expect(draft(screen)).toBe('draft')
  })
  it('합성: 일반 프롬프트 상자에 하단 안내 글을 직접 쳐도 상자 안 글은 안내로 세지 않는다', () => {
    const screen = sample('normal-typed-placeholder').replace('describe a task for a new session', '· space to reply · enter to return')
    expect(shown(screen)).toBe(false)
    expect(draft(screen)).toBe('draft')
  })
  it('ⓕ Codex·Grok 은 판별하지 않는다 — 같은 화면도 false, draftState 판정 그대로', () => {
    for (const kind of ['codex', 'grok'] as const) {
      expect(agentViewShown({ kind, screen: sample('view-default') })).toBe(false)
      expect(draftState({ kind, screen: sample('view-default') })).toBe('unknown')
    }
  })
  it('ⓕ 기존 실표본 전부(Claude·Codex·Grok 화면, 질문·검토·권한 포함) — 어느 provider 로 읽어도 agent view 가 아니다', () => {
    const roots = [path.join(__dirname, 'fixtures', 'agent-tui-screens'), path.join(FIXTURES, 'continued-in')]
    const files = roots.flatMap((root) => fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)))
    expect(files.length).toBeGreaterThan(20)
    for (const file of files) {
      const screen = fs.readFileSync(file, 'utf8')
      for (const kind of ['claude', 'codex', 'grok'] as const) expect(agentViewShown({ kind, screen }), `${kind} ${file}`).toBe(false)
    }
  })
})
