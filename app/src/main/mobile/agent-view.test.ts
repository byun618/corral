// Claude agent view 판별 (LIFE-770) — fixtures/agent-view/ 는 실제 pane 화면(2.1.296, ANSI 유지, 다른 세션 제목·대화를 가림)이다. `view-slash`·`view-at` 만 색 없는 pane 이라 글자 근거로만 쓴다. 「합성」 이라 적은 시험만 그 표본을 고쳐 쓴다.
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
    ['그룹 헤더 행 enter to collapse', 'view-header'],
    ['접힌 그룹 헤더 행 enter to expand', 'view-header-collapsed'],
    ['claude agents 직접 기동 첫 화면', 'direct-first'],
    ['삭제 확인 ctrl+x to confirm', 'view-delete-confirm'],
    ['40열 헤더 enter to coll…', 'width40-header'],
    ['40열 접힌 헤더 enter to expa…', 'width40-header-collapsed'],
    ['40열 직접 기동 enter to col…', 'width40-direct'],
    ['38열 기본 enter to re…', 'width38-view-default'],
    ['38열 ↓ enter to op…', 'width38-view-down'],
    ['38열 글 enter to cr…', 'width38-view-typed'],
    ['38열 헤더 enter to co…', 'width38-header'],
    ['32열 패널(안내 꺾임)', 'width32-view-peek'],
    ['28열 패널(안내가 낱말 사이로 꺾임)', 'width28-view-peek'],
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

describe('좁은 폭 — 안내를 못 읽고 자리표시가 꺾인 실표본(색 유지)', () => {
  const GRAY = '\x1b[38;2;153;153;153m'
  const dim = (screen: string): string => {
    expect(screen).toContain(GRAY)
    const start = `\x1b[0m${GRAY}`
    const end = '\x1b[0m'
    return screen.split('\r\n').map((line) => (line.startsWith(start) && line.endsWith(end) && /^(?:❯ )?[a-z ]+$/.test(line.slice(start.length, -end.length)) ? line.replace(GRAY, '\x1b[2m') : line)).join('\r\n')
  }
  it.each([
    ['36열 enter to …(한 줄)', 'width36-view-default'],
    ['32열 enter…(두 줄)', 'width32-view-default'],
    ['28열 e…(두 줄)', 'width28-view-default'],
    ['32열 헤더(두 줄)', 'width32-header'],
    ['32열 직접 기동(두 줄)', 'width32-direct'],
  ])('%s — 지금 색은 판별 못 하고 mac_draft 로 막힌다, 합성 흐림은 agent view', (_label, name) => {
    const screen = sample(name)
    expect(shown(screen)).toBe(false)
    expect(draft(screen)).toBe('draft')
    expect(draft(dim(screen))).toBe('empty')
    expect(shown(dim(screen))).toBe(true)
  })
  it('32열 글을 친 상자 — 판별 못 하고 mac_draft', () => {
    expect(shown(sample('width32-view-typed'))).toBe(false)
    expect(draft(sample('width32-view-typed'))).toBe('draft')
  })
  it.each(['width32-normal-typed-placeholder', 'width28-normal-typed-placeholder'])('%s — 일반 프롬프트에 친 글이 꺾여도 진하니 mac_draft', (name) => {
    expect(shown(sample(name))).toBe(false)
    expect(draft(sample(name))).toBe('draft')
  })
  it.each(['width32-normal-empty', 'width28-normal-empty'])('%s — 일반 빈 입력은 empty', (name) => {
    expect(shown(sample(name))).toBe(false)
    expect(draft(sample(name))).toBe('empty')
  })
  it('합성: 꺾인 자리표시 글자가 바뀌고 흐림 + 안내 잘림 → 못 잡는다(한계 고정 — SURFACE.md)', () => {
    const screen = dim(sample('width32-view-default')).replace('describe a task for a new', 'start something new for').replace('session', 'today')
    expect(shown(screen)).toBe(false)
    expect(draft(screen)).toBe('empty')
  })
})

describe('못 알아보는 agent view 화면 — 결과를 고정한다(SURFACE.md 표)', () => {
  it.each([
    ['/ 입력', 'view-slash', 'draft'],
    ['@ 입력', 'view-at', 'draft'],
    ['찾기', 'view-find', 'unknown'],
    ['simple view', 'simple-view', 'unknown'],
  ])('%s', (_label, name, state) => {
    expect(shown(sample(name))).toBe(false)
    expect(draft(sample(name))).toBe(state)
  })
})

describe('안내 줄 — 합성(실표본 한 줄을 고침)', () => {
  const FOOTER = 'enter to return · space to reply · ctrl+x to delete · ? for shortcuts'
  const withFooter = (line: string): string => {
    const screen = sample('view-default')
    expect(screen).toContain(FOOTER)
    return screen.replace(`\x1b[38;2;255;107;128m⏵⏵ bypass permissions\x1b[0m\x1b[38;2;153;153;153m · ${FOOTER}`, line)
  }
  const normal = (below: string): string => `${sample('normal-try-placeholder').trimEnd().split('\r\n').slice(0, -1).join('\r\n')}\r\n${below}`
  it.each([
    ['접힌 행 enter to show all(소스만, 표본 없음)', '⏵⏵ bypass permissions · enter to show all · ? for shortcuts'],
    ['전체 동사가 줄 끝', '⏵⏵ bypass permissions · enter to open'],
    ['전체 동사 뒤 ·…', '⏵⏵ bypass permissions · enter to return ·…'],
    ['전체 동사 뒤 …', '⏵⏵ bypass permissions · enter to return…'],
    ['전체 동사 뒤 공백 …', '⏵⏵ bypass permissions · enter to create …'],
    ['한 글자만 남은 동사', '⏵⏵ bypass permissions · enter to e…'],
  ])('%s → agent view', (_label, line) => {
    expect(shown(withFooter(line))).toBe(true)
  })
  it.each([
    ['전체 동사 뒤에 글', '⏵⏵ bypass permissions · enter to open the file'],
    ['잘린 꼴이 줄 끝이 아님', '⏵⏵ bypass permissions · enter to r… · ? for shortcuts'],
    ['다른 동사의 잘린 꼴', '⏵⏵ bypass permissions · enter to view…'],
    ['동사 없는 잘림', '⏵⏵ bypass permissions · enter to …'],
    ['enter… 로 잘림', '⏵⏵ bypass permissions · enter…'],
    ['대문자 안내', 'Enter to use · esc to cancel'],
    ['칸 앞이 · 가 아님', 'press enter to open'],
  ])('%s → 안내가 아니다', (_label, line) => {
    expect(shown(withFooter(line))).toBe(false)
  })
  it.each([
    ['명령 메뉴 첫 행의 설명', '  /deploy     Press · enter to open'],
    ['명령 메뉴 첫 행의 설명 — space to reply', '  /chat       Open · space to reply'],
    ['메뉴 둘째 행의 설명', '  /build      Build it\r\n  deploy · enter to return'],
    ['일반 안내 아래 줄의 인용', '  ⏵⏵ bypass permissions on (shift+tab to cycle)\r\n  · enter to open'],
    ['enter to open the file', '  ? for shortcuts · enter to open the file'],
  ])('일반 프롬프트 %s → empty 그대로', (_label, below) => {
    const screen = normal(below)
    expect(shown(screen)).toBe(false)
    expect(draft(screen)).toBe('empty')
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
