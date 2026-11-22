// diff 메모 본문·대상 (LIFE-832 L1·L4ⓐ~ⓔ·L9) — shared 순수 함수. 목록 고정값(main/mobile/list-fixture)을 쓰려고 main 아래 둔다(shared 는 main 을 import 하지 않는다).
import { describe, expect, it } from 'vitest'
import { checkNoteTarget, clipLineText, defaultTarget, DIFF_NOTES_LEAD, formatNotesBody, wellFormed, LINE_TEXT_MAX, noteTargets, notesAllowed, readDiffNotesState, bodyTooLarge, type NoteForBody } from '../shared/diff-notes.js'
import { cleanBody, MAX_INPUT_BYTES } from '../shared/input-body.js'
import { fixturePane, fixtureWorktree } from './mobile/list-fixture.js'
import type { ScmDiffMode } from '../shared/scm.js'
import type { AgentSessionRef } from '../shared/types.js'

/** 본문의 글 칸을 되읽는다 — `"…"` 안의 `\\`·`\"`·`\n`·`\t` 이스케이프를 푼다. 왕복 시험용. */
function unquote(field: string): string {
  expect(field.startsWith('"') && field.endsWith('"')).toBe(true)
  return field.slice(1, -1).replace(/\\(\\|"|n|t)/g, (_match, char: string) => (char === 'n' ? '\n' : char === 't' ? '\t' : char))
}

/** 본문 → 메모 블록(머리 다음부터 빈 줄로 나뉜 네 줄). */
function blocks(body: string): { file: string; line: number; code: string; note: string }[] {
  return body
    .split('\n\n')
    .slice(1)
    .map((block) => {
      const [file, line, code, note] = block.split('\n')
      return { file: unquote((file ?? '').replace(/^File: /, '')), line: Number((line ?? '').replace(/^Line: /, '')), code: unquote((code ?? '').replace(/^Code: /, '')), note: unquote((note ?? '').replace(/^Note: /, '')) }
    })
}

describe('메모 모드 (L1 — sidesOf 오른쪽이 작업 파일인 넷만)', () => {
  it.each<[ScmDiffMode, boolean]>([
    ['wt', true],
    ['wtType', true],
    ['wtRename', true],
    ['base', true],
    ['idx', false],
    ['idxOnly', false],
    ['deleted', false],
    ['baseDeleted', false],
  ])('%s → %s', (mode, allowed) => {
    expect(notesAllowed(mode)).toBe(allowed)
  })
})

describe('본문 형식 (L9 · D9)', () => {
  const notes: NoteForBody[] = [
    { rel: 'src/z.ts', line: 1, lineText: 'z', body: 'z 메모' },
    { rel: 'src/a.ts', line: 20, lineText: 'a20', body: 'a 20' },
    { rel: 'src/a.ts', line: 3, lineText: 'a3', body: 'a 3' },
  ]
  it('결정적 — 같은 메모(순서만 다름) → 같은 바이트, 파일 경로 → 줄 순, 머리에 개수·비교 기준', () => {
    const one = formatNotesBody({ notes, against: ['base main(abc1234)', 'base main(abc1234)'] })
    const two = formatNotesBody({ notes: [...notes].reverse(), against: ['base main(abc1234)'] })
    expect(one).toBe(two)
    expect(one.split('\n')[0]).toBe('diff 리뷰 메모 3개 (비교 기준: base main(abc1234))')
    expect(blocks(one).map((block) => `${block.file}:${block.line}`)).toEqual(['src/a.ts:3', 'src/a.ts:20', 'src/z.ts:1'])
    expect(one).toBe(
      [
        'diff 리뷰 메모 3개 (비교 기준: base main(abc1234))',
        '',
        'File: "src/a.ts"\nLine: 3\nCode: "a3"\nNote: "a 3"',
        '',
        'File: "src/a.ts"\nLine: 20\nCode: "a20"\nNote: "a 20"',
        '',
        'File: "src/z.ts"\nLine: 1\nCode: "z"\nNote: "z 메모"',
      ].join('\n'),
    )
  })
  it('비교 기준이 여럿이면 정렬해 잇는다', () => {
    expect(formatNotesBody({ notes, against: ['인덱스', 'base main(abc1234)', '인덱스'] }).split('\n')[0]).toBe('diff 리뷰 메모 3개 (비교 기준: base main(abc1234), 인덱스)')
  })
  it('특수문자 왕복 — 따옴표·백슬래시·줄바꿈 여럿·한글·이모지·탭·$(…)·백틱은 그대로, 제어문자(ESC·bracketed paste 끝 표지)는 cleanBody 규칙대로 지워진다', () => {
    const nasty = '그 "따옴표" \\ 백슬래시\n\n두 줄 띄움\r\nCRLF 🙂 탭\t$(rm -rf ~) `id` \x1b[201~끝\x03\x7f\x9b'
    const body = formatNotesBody({ notes: [{ rel: '폴더 이름/한글 파일.ts', line: 7, lineText: '\tconst s = "x\\y" // \x1b[31m', body: nasty }], against: ['인덱스'] })
    const [block] = blocks(body)
    expect(block).toEqual({ file: '폴더 이름/한글 파일.ts', line: 7, code: cleanBody('\tconst s = "x\\y" // \x1b[31m'), note: cleanBody(nasty) })
    expect(block?.note).toContain('[201~끝')
    expect(block?.note).not.toContain('\x1b')
    // 본문 전체가 이미 정리된 글이다 — main 이 다시 정리해도 같다(확인 단계 글 = 넣는 글).
    expect(cleanBody(body)).toBe(body)
    // 글 칸 안 줄바꿈은 이스케이프 — 본문의 줄 수는 구조(머리 + 빈 줄 + 네 줄)뿐.
    expect(body.split('\n')).toHaveLength(6)
    // 탭도 이스케이프 — 본문에 탭이 남지 않는다(claude 기록이 붙여 넣은 탭을 공백으로 바꿔 대조가 깨진다 — 최종 관문 L9).
    expect(body).not.toContain('\t')
    expect(body).toContain('Code: "\\tconst s')
    expect(body).toContain('탭\\t$(rm')
  })
  it('메모 단 때 줄 내용은 상한에서 자른다', () => {
    const long = 'x'.repeat(LINE_TEXT_MAX + 50)
    expect(clipLineText(long)).toBe(`${'x'.repeat(LINE_TEXT_MAX)}…`)
    expect(blocks(formatNotesBody({ notes: [{ rel: 'a', line: 1, lineText: long, body: 'm' }], against: [] }))[0]?.code).toBe(clipLineText(long))
  })
  it('300자 경계의 비BMP·결합 문자 — 코드 포인트로 잘라 서로게이트를 가르지 않는다 · 본문 well-formed(리뷰 r1 A2)', () => {
    const emoji = `${'x'.repeat(LINE_TEXT_MAX - 1)}🙂🙂`
    expect(clipLineText(emoji)).toBe(`${'x'.repeat(LINE_TEXT_MAX - 1)}🙂…`)
    expect(wellFormed(clipLineText(emoji))).toBe(true)
    const combining = `${'e\u0301'.repeat(200)}`
    expect(wellFormed(clipLineText(combining))).toBe(true)
    const body = formatNotesBody({ notes: [{ rel: 'a', line: 1, lineText: emoji, body: '짝 없는 \uD83D 서로게이트' }], against: ['인덱스'] })
    expect(wellFormed(body)).toBe(true)
    expect(body).toContain('짝 없는 \uFFFD 서로게이트')
    expect(wellFormed('a\uDE00b')).toBe(false)
  })
  it('리드는 한 줄 · 정리 규칙 고정점', () => {
    expect(DIFF_NOTES_LEAD.includes('\n')).toBe(false)
    expect(cleanBody(DIFF_NOTES_LEAD)).toBe(DIFF_NOTES_LEAD)
  })
  it('상한 — 65536 바이트(UTF-8) 넘으면 막는다', () => {
    expect(bodyTooLarge('a'.repeat(MAX_INPUT_BYTES))).toBe(false)
    expect(bodyTooLarge('a'.repeat(MAX_INPUT_BYTES + 1))).toBe(true)
    expect(bodyTooLarge('가'.repeat(Math.floor(MAX_INPUT_BYTES / 3) + 1))).toBe(true)
  })
})

describe('대상 후보 (L4ⓐ~ⓔ)', () => {
  const session: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr', id: 's1' }
  it('ⓐ 에이전트 pane 0개(셸만·닫힌 workspace) → 후보 없음', () => {
    expect(noteTargets(fixtureWorktree({ path: '/w', branch: 'f', repoName: 'r', panes: [fixturePane('s1', null)] }))).toEqual([])
    expect(noteTargets(fixtureWorktree({ path: '/w', branch: 'f', repoName: 'r', panes: null }))).toEqual([])
  })
  it('ⓑ 1개 → 기본 선택', () => {
    const targets = noteTargets(fixtureWorktree({ path: '/w', branch: 'f', repoName: 'r', panes: [fixturePane('c1', 'claude', { agentSession: session }), fixturePane('s1', null)] }))
    expect(targets.map((target) => target.paneId)).toEqual(['c1'])
    expect(defaultTarget(targets)).toBe('c1')
  })
  it('ⓒ 2개(다른 탭) → 기본 선택 없음, 사용자가 고른다 · ⓓ 세션 없는 pane 은 보이되 고를 수 없음 + 사유', () => {
    const targets = noteTargets(
      fixtureWorktree({ path: '/w', branch: 'f', repoName: 'r', panes: [fixturePane('c1', 'claude', { agentSession: session }), fixturePane('c2', 'codex', { agentSession: { kind: 'id', agent: 'codex', source: 'herdr', id: 's2' } }), fixturePane('c3', 'claude', { agentSession: null })] }),
    )
    expect(targets.map((target) => [target.paneId, target.kind, target.selectable])).toEqual([
      ['c1', 'claude', true],
      ['c2', 'codex', true],
      ['c3', 'claude', false],
    ])
    expect(targets[2]?.reason).not.toBeNull()
    expect(defaultTarget(targets)).toBeNull()
    // 세션 없는 pane 하나 + 고를 수 있는 pane 하나 = 기본은 고를 수 있는 쪽.
    expect(defaultTarget(targets.filter((target) => target.paneId !== 'c2'))).toBe('c1')
  })
  it('ⓔ main workspace 의 에이전트 pane 은 linked worktree 후보에 없다 — 접수 재검사도 거절', () => {
    const main = fixtureWorktree({ path: '/r', branch: 'main', repoName: 'r', isLinked: false, panes: [fixturePane('m1', 'claude', { agentSession: session })] })
    const linked = fixtureWorktree({ path: '/r/wt', branch: 'f', repoName: 'r', parentPath: '/r', panes: [fixturePane('c1', 'claude', { agentSession: session })] })
    expect(noteTargets(linked).map((target) => target.paneId)).toEqual(['c1'])
    expect(checkNoteTarget({ worktrees: [main, linked], worktree: '/r/wt', paneId: 'm1' })).toEqual({ ok: false, reason: 'not_target' })
    expect(checkNoteTarget({ worktrees: [main, linked], worktree: '/r/wt', paneId: 'c1' })).toEqual({ ok: true, kind: 'claude' })
    expect(checkNoteTarget({ worktrees: [main, linked], worktree: '/x', paneId: 'c1' })).toEqual({ ok: false, reason: 'not_worktree' })
  })
  it('claude·codex·grok 말고는 후보가 아니다', () => {
    expect(noteTargets(fixtureWorktree({ path: '/w', branch: 'f', repoName: 'r', panes: [fixturePane('o1', 'opencode', { agentSession: session }), fixturePane('g1', 'grok', { agentSession: session })] })).map((target) => target.paneId)).toEqual(['g1'])
  })
})

describe('push 읽기', () => {
  it('모양이 맞을 때만', () => {
    expect(readDiffNotesState({ requestId: 'r1', state: 'delivered', wait: null, reason: null })).toEqual({ requestId: 'r1', state: 'delivered', wait: null, reason: null })
    expect(readDiffNotesState({ requestId: 'r1', state: 'stopped', wait: null, reason: null })).toBeNull()
    expect(readDiffNotesState({ requestId: 'r 1', state: 'queued', wait: 'turn', reason: null })).toBeNull()
    expect(readDiffNotesState({ requestId: 'r1', state: 'queued', wait: 'x', reason: null })).toBeNull()
    expect(readDiffNotesState(null)).toBeNull()
  })
})
