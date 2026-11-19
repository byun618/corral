// LIFE-808 C1·C2·C3·C6·C7·C8·C11·C18·C19 — 세션 히스토리 스캐너. 기록은 전부 손으로 만든 fixture 다(실제 대화를 레포에 넣지 않는다).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filterRows, resumeCommandText, type SessionHistoryListResult, type SessionHistoryRow } from '../shared/session-history.js'
import { RESUME_PENDING_MS, SCAN_HEAD_BYTES, SCAN_TAIL_BYTES, SessionHistory, historyRoots, parseCodexSession, preferRecord, resumeSession, revealSession, type OpenPane, type ResumeContext } from './session-history.js'

// --- fixture ------------------------------------------------------------------------------------------

const ID = {
  custom: '11111111-1111-4111-8111-111111111111',
  aiTail: '22222222-2222-4222-8222-222222222222',
  plain: '33333333-3333-4333-8333-333333333333',
  desktop: '44444444-4444-4444-8444-444444444444',
  sdk: '55555555-5555-4555-8555-555555555555',
  broken: '66666666-6666-4666-8666-666666666666',
  zero: '77777777-7777-4777-8777-777777777777',
  meta: '88888888-8888-4888-8888-888888888888',
  long: '99999999-9999-4999-8999-999999999999',
  codexNamed: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  codexPlain: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  codexExec: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  codexNoMeta: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  codexEmpty: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
} as const

let base = ''
let claudeDir = ''
let codexDir = ''
let work = ''

const jsonl = (records: unknown[]): string => records.map((record) => JSON.stringify(record)).join('\n') + '\n'

type ClaudeTurn = { prompt: string; reply: string }
function claudeSession(input: { id: string; entrypoint?: string | null; cwd: string; branch?: string; turns: ClaudeTurn[]; head?: unknown[]; tail?: unknown[]; pad?: number }): string {
  const records: unknown[] = [{ type: 'last-prompt', sessionId: input.id, leafUuid: 'x' }, ...(input.head ?? [])]
  let parent: string | null = null
  const at = (n: number): string => new Date(Date.UTC(2026, 10, 19, 1, 0, n)).toISOString()
  const ep = input.entrypoint === null ? {} : { entrypoint: input.entrypoint ?? 'cli' }
  input.turns.forEach((turn, index) => {
    const userUuid = `u${index}`
    records.push({ type: 'user', sessionId: input.id, uuid: userUuid, parentUuid: parent, cwd: input.cwd, gitBranch: input.branch ?? 'main', timestamp: at(index * 2), ...ep, message: { role: 'user', content: turn.prompt } })
    if (index === 0 && input.pad !== undefined) records.push({ type: 'attachment', sessionId: input.id, uuid: 'pad', parentUuid: userUuid, attachment: 'x'.repeat(input.pad) })
    const replyUuid = `a${index}`
    records.push({ type: 'assistant', sessionId: input.id, uuid: replyUuid, parentUuid: userUuid, cwd: input.cwd, timestamp: at(index * 2 + 1), ...ep, message: { id: `m${index}`, role: 'assistant', model: 'claude-fixture-1', content: [{ type: 'text', text: turn.reply }] } })
    parent = replyUuid
  })
  records.push(...(input.tail ?? []))
  return jsonl(records)
}

function codexSession(input: { id: string; originator: string; cwd: string; prompts: string[]; model?: string }): string {
  const records: unknown[] = [
    { timestamp: '2026-11-19T02:00:00.000Z', type: 'session_meta', payload: { id: input.id, cwd: input.cwd, originator: input.originator, git: { commit_hash: 'abc', repository_url: 'https://example.invalid/r.git' }, base_instructions: { text: 'fixture' } } },
  ]
  input.prompts.forEach((prompt, index) => {
    const at = `2026-11-19T02:0${index + 1}:00.000Z`
    records.push({ timestamp: at, type: 'turn_context', payload: { cwd: input.cwd, model: input.model ?? 'gpt-fixture' } })
    records.push({ timestamp: at, type: 'event_msg', payload: { type: 'task_started' } })
    records.push({ timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: prompt } })
    records.push({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `codex reply ${index}` }] } })
  })
  return jsonl(records)
}

const claudeFile = (folder: string, id: string): string => path.join(claudeDir, 'projects', folder, `${id}.jsonl`)
const codexFile = (id: string): string => path.join(codexDir, 'sessions', '2026', '11', '19', `rollout-2026-11-19T02-00-00-${id}.jsonl`)
function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const LONG_PROMPT = 'L'.repeat(1000) + ' 가나다 ' + 'M'.repeat(1995)

function seed(): void {
  const repo = path.join(work, 'repo')
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
  const proj = '-w-repo'
  put(claudeFile(proj, ID.custom), claudeSession({ id: ID.custom, cwd: repo, turns: [{ prompt: 'custom first prompt', reply: 'ok' }], tail: [
    { type: 'ai-title', sessionId: ID.custom, aiTitle: 'AI 제목' },
    { type: 'custom-title', sessionId: ID.custom, customTitle: '옛 사용자 제목' },
    { type: 'custom-title', sessionId: ID.custom, customTitle: '사용자 제목' },
  ] }))
  // ai-title 이 앞 창 밖·꼬리 창 안에만 있다 — 가운데를 1MB 로 채운다.
  put(claudeFile(proj, ID.aiTail), claudeSession({ id: ID.aiTail, cwd: path.join(repo, 'sub'), branch: 'feat/x', turns: [{ prompt: 'tail title first prompt', reply: 'r0' }, { prompt: 'second prompt', reply: 'r1' }], pad: 1024 * 1024, tail: [
    { type: 'ai-title', sessionId: ID.aiTail, aiTitle: '꼬리 AI 제목' },
  ] }))
  put(claudeFile(proj, ID.plain), claudeSession({ id: ID.plain, cwd: path.join(work, 'gone', 'wt'), turns: [{ prompt: 'please fix the flaky login test. then report', reply: 'done' }] }))
  put(claudeFile('-w-desk', ID.desktop), claudeSession({ id: ID.desktop, entrypoint: 'claude-desktop', cwd: '/nonexistent/desk', turns: [{ prompt: 'desktop prompt', reply: 'ok' }] }))
  put(claudeFile(proj, ID.sdk), claudeSession({ id: ID.sdk, entrypoint: 'sdk-cli', cwd: repo, turns: [{ prompt: 'sdk prompt', reply: 'ok' }] }))
  put(path.join(claudeDir, 'projects', proj, ID.custom, 'subagents', 'agent-1.jsonl'), claudeSession({ id: ID.custom, cwd: repo, turns: [{ prompt: 'subagent prompt', reply: 'ok' }] }))
  put(claudeFile(proj, ID.broken), '{not json\n' + claudeSession({ id: ID.broken, cwd: repo, turns: [{ prompt: 'broken file prompt', reply: 'ok' }] }) + '{"type":"user", trailing garbage\n')
  put(claudeFile(proj, ID.zero), '')
  // R1-3 — 파일 이름이 UUID 꼴이 아닌 기록(사용자 기록에 실재하는 `<uuid>.orphaned-<n>` 꼴) — 대화형 내용이어도 제외.
  put(path.join(claudeDir, 'projects', proj, `${ID.custom}.orphaned-1.jsonl`), claudeSession({ id: ID.custom, cwd: repo, turns: [{ prompt: 'orphaned prompt', reply: 'ok' }] }))
  put(claudeFile(proj, ID.meta), jsonl([{ type: 'last-prompt', sessionId: ID.meta }, { type: 'mode', sessionId: ID.meta, mode: 'normal' }, { type: 'permission-mode', sessionId: ID.meta, permissionMode: 'default' }]))
  put(codexFile(ID.codexNamed), codexSession({ id: ID.codexNamed, originator: 'codex-tui', cwd: repo, prompts: ['codex named prompt', 'codex second'] }))
  put(codexFile(ID.codexPlain), codexSession({ id: ID.codexPlain, originator: 'codex-tui', cwd: '/nonexistent/codex', prompts: ['refactor the parser module'] }))
  put(codexFile(ID.codexExec), codexSession({ id: ID.codexExec, originator: 'codex_exec', cwd: repo, prompts: ['exec prompt'] }))
  put(codexFile(ID.codexNoMeta), jsonl([{ type: 'turn_context', payload: { cwd: repo, model: 'gpt-fixture' } }, { type: 'event_msg', payload: { type: 'user_message', message: 'x' } }]))
  put(codexFile(ID.codexEmpty), codexSession({ id: ID.codexEmpty, originator: 'codex-tui', cwd: repo, prompts: [] }))
  put(path.join(codexDir, 'session_index.jsonl'), jsonl([
    { id: ID.codexNamed, thread_name: '옛 이름', updated_at: '2026-11-19T02:00:00Z' },
    { id: ID.codexNamed, thread_name: 'Codex 스레드 이름', updated_at: '2026-11-19T02:05:00Z' },
  ]))
}

const newHistory = (codexResumesWithoutCwd = true): SessionHistory => new SessionHistory({ roots: () => ({ claudeDir, codexDir }), codexResumesWithoutCwd })
const rowsOf = (result: SessionHistoryListResult): SessionHistoryRow[] => (result.kind === 'ok' ? result.rows : [])
const ids = (result: SessionHistoryListResult): string[] => rowsOf(result).map((row) => row.id).sort()
const rowOf = (result: SessionHistoryListResult, id: string): SessionHistoryRow | undefined => rowsOf(result).find((row) => row.id === id)

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l808-')))
  claudeDir = path.join(base, 'claude')
  codexDir = path.join(base, 'codex')
  work = path.join(base, 'work')
  seed()
})
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

// --- C1 -------------------------------------------------------------------------------------------------

describe('C1 스캔 대상·제외', () => {
  it('R2-8 Codex session_meta.payload.id 가 UUID 꼴이 아니면 제외 — UUID 면 행', () => {
    const meta = (id: string): string => `${JSON.stringify({ type: 'session_meta', payload: { id, originator: 'codex-tui', cwd: '/w' } })}\n`
    const parse = (id: string): string => parseCodexSession({ fileId: null, file: '/h/r.jsonl', windows: { head: meta(id), tail: '', tailPartial: false, headCut: null }, mtimeMs: 1 }).kind
    expect([parse('not-a-uuid'), parse('../x'), parse(ID.codexNamed)]).toEqual(['excluded', 'excluded', 'row'])
  })
  it('대화형만 — sdk-cli·codex_exec·subagent 0건, 깨진 줄 섞인 파일은 행, 빈 파일·첫 줄이 session_meta 아닌 파일은 「읽기 실패」 로 센다', async () => {
    const result = await newHistory().list({ providers: ['claude', 'codex'] })
    expect(result.kind).toBe('ok')
    expect(rowsOf(result)).toHaveLength(9)
    expect(result.kind === 'ok' ? result.unreadable : -1).toBe(2)
    expect(ids(result)).toEqual([ID.custom, ID.aiTail, ID.plain, ID.desktop, ID.broken, ID.meta, ID.codexNamed, ID.codexPlain, ID.codexEmpty].sort())
    expect(ids(result)).not.toContain(ID.sdk)
    expect(ids(result)).not.toContain(ID.codexExec)
    expect(rowsOf(result).filter((row) => row.file.includes('subagents'))).toHaveLength(0)
    expect(rowsOf(result).filter((row) => row.file.includes('.orphaned-'))).toHaveLength(0)
  })
  it('CLAUDE_CONFIG_DIR·CODEX_HOME 를 존중한다', () => {
    expect(historyRoots({ env: { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' }, home: '/h' })).toEqual({ claudeDir: '/c', codexDir: '/x' })
    expect(historyRoots({ env: {}, home: '/h' })).toEqual({ claudeDir: '/h/.claude', codexDir: '/h/.codex' })
  })
  it('기록 디렉터리가 없으면 오류가 아니라 0건', async () => {
    const empty = new SessionHistory({ roots: () => ({ claudeDir: path.join(base, 'none-c'), codexDir: path.join(base, 'none-x') }), codexResumesWithoutCwd: true })
    expect(await empty.list({ providers: ['claude', 'codex'] })).toEqual({ kind: 'ok', rows: [], unreadable: 0, realpaths: {} })
  })
  it('읽을 수 없는 projects 디렉터리는 던지지 않고 오류 값', async () => {
    const projects = path.join(claudeDir, 'projects')
    fs.chmodSync(projects, 0o000)
    try {
      const result = await newHistory().list({ providers: ['claude'] })
      expect(result.kind).toBe('error')
    } finally {
      fs.chmodSync(projects, 0o755)
    }
  })
  it('잘못된 입력은 오류 값', async () => {
    expect((await newHistory().list({ providers: ['grok'] })).kind).toBe('error')
    expect((await newHistory().list(null)).kind).toBe('error')
  })
})

// --- C2 -------------------------------------------------------------------------------------------------

describe('C2 행 필드', () => {
  it('Claude 각 fixture 의 기대 필드', async () => {
    const result = await newHistory().list({ providers: ['claude', 'codex'] })
    const repo = path.join(work, 'repo')
    expect(rowOf(result, ID.custom)).toMatchObject({ provider: 'claude', title: '사용자 제목', cwd: repo, cwdKey: repo, cwdExists: true, branch: 'main', model: 'claude-fixture-1', firstPrompt: 'custom first prompt', lastPrompt: 'custom first prompt', empty: false, lastActivityAt: Date.UTC(2026, 10, 19, 1, 0, 1), file: claudeFile('-w-repo', ID.custom) })
    expect(rowOf(result, ID.aiTail)).toMatchObject({ title: '꼬리 AI 제목', cwd: path.join(repo, 'sub'), branch: 'feat/x', firstPrompt: 'tail title first prompt', lastPrompt: 'second prompt', model: 'claude-fixture-1' })
    expect(rowOf(result, ID.plain)).toMatchObject({ title: 'Fix the flaky login test', cwd: path.join(work, 'gone', 'wt'), cwdExists: false, cwdKey: path.join(work, 'gone', 'wt') })
    expect(rowOf(result, ID.desktop)).toMatchObject({ title: 'Desktop prompt', cwd: '/nonexistent/desk', cwdExists: false })
    expect(rowOf(result, ID.broken)).toMatchObject({ title: 'Broken file prompt', empty: false })
    expect(rowOf(result, ID.meta)).toMatchObject({ title: null, cwd: null, cwdKey: null, cwdExists: false, branch: null, model: null, firstPrompt: null, lastPrompt: null, empty: true })
  })
  it('ai-title 은 앞 창 밖·꼬리 창 안에만 있다(fixture 전제 확인) — 그래도 제목이 된다', () => {
    const text = fs.readFileSync(claudeFile('-w-repo', ID.aiTail), 'utf8')
    const at = Buffer.byteLength(text.slice(0, text.indexOf('"ai-title"')))
    expect(at).toBeGreaterThan(SCAN_HEAD_BYTES)
    expect(Buffer.byteLength(text) - at).toBeLessThan(SCAN_TAIL_BYTES)
  })
  it('Codex 각 fixture 의 기대 필드 — 브랜치는 지어내지 않는다, 이름은 session_index 의 마지막 행', async () => {
    const result = await newHistory().list({ providers: ['codex'] })
    const repo = path.join(work, 'repo')
    expect(rowOf(result, ID.codexNamed)).toMatchObject({ provider: 'codex', title: 'Codex 스레드 이름', cwd: repo, cwdExists: true, branch: null, model: 'gpt-fixture', firstPrompt: 'codex named prompt', lastPrompt: 'codex second', empty: false, lastActivityAt: Date.parse('2026-11-19T02:02:00.000Z') })
    expect(rowOf(result, ID.codexPlain)).toMatchObject({ title: 'Refactor the parser module', cwd: '/nonexistent/codex', cwdExists: false, branch: null })
    expect(rowOf(result, ID.codexEmpty)).toMatchObject({ title: null, firstPrompt: null, empty: true, lastActivityAt: Date.parse('2026-11-19T02:00:00.000Z') })
  })
  it('최근 활동순', async () => {
    const result = await newHistory().list({ providers: ['claude', 'codex'] })
    const times = rowsOf(result).map((row) => row.lastActivityAt)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })
})

// --- C3 -------------------------------------------------------------------------------------------------

type Snapshot = { path: string; size: number; mtimeMs: number; sha256: string | null }
function snapshot(root: string): Snapshot[] {
  const out: Snapshot[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const stat = fs.statSync(full)
      out.push({ path: path.relative(root, full), size: stat.size, mtimeMs: stat.mtimeMs, sha256: entry.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') : null })
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(root)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

describe('R1-8 등록 경로 realpath', () => {
  it('목록 결과에 등록 레포 root·worktree 의 realpath 를 싣는다 — 심링크 경로는 실제 경로로, 없는 경로는 빠진다', async () => {
    const link = path.join(base, 'link')
    fs.symlinkSync(work, link)
    const result = await newHistory().list({ providers: ['codex'] }, { repos: [{ root: link, worktrees: [link, path.join(link, 'repo'), path.join(link, 'gone')] }], home: base })
    expect(result.kind === 'ok' ? result.realpaths : null).toEqual({ [link]: work, [path.join(link, 'repo')]: path.join(work, 'repo') })
  })
})

describe('R4-1 같은 세션 id 가 여러 파일이면 행 하나', () => {
  it('두 프로젝트 폴더에 같은 id — 활동이 늦은 쪽(같으면 mtime) 하나만 · 나머지는 제외(읽기 실패 아님) · findRow·상세 파일 = 남긴 행 · 목록 순서와 일치', async () => {
    const before = await newHistory().list({ providers: ['claude'] })
    // plain: 다른 폴더의 사본이 활동이 더 늦다(턴 3개 — 마지막 시각이 뒤) → 사본이 남는다
    const newer = claudeFile('-w-other', ID.plain)
    put(newer, claudeSession({ id: ID.plain, cwd: path.join(work, 'gone', 'wt'), turns: [{ prompt: 'a', reply: 'b' }, { prompt: 'c', reply: 'd' }, { prompt: 'e', reply: 'f' }] }))
    // desktop: 같은 내용의 사본(활동 시각 같음) — mtime 이 더 오래돼 원본이 남는다
    const older = claudeFile('-w-old', ID.desktop)
    put(older, claudeSession({ id: ID.desktop, entrypoint: 'claude-desktop', cwd: '/nonexistent/desk', turns: [{ prompt: 'desktop prompt', reply: 'ok' }] }))
    fs.utimesSync(older, new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2020, 0, 1)))
    const history = newHistory()
    const result = await history.list({ providers: ['claude'] })
    const keys = rowsOf(result).map((row) => `${row.provider}:${row.id}`)
    expect(keys).toHaveLength(rowsOf(before).length)
    expect(new Set(keys).size).toBe(keys.length)
    expect(result.kind === 'ok' && before.kind === 'ok' ? [result.unreadable, before.unreadable] : null).toEqual([1, 1])
    expect(history.stats.duplicates).toBe(2)
    const plain = rowOf(result, ID.plain)
    expect(plain?.file).toBe(newer)
    expect(history.findRow({ provider: 'claude', id: ID.plain })?.file).toBe(newer)
    expect(rowOf(result, ID.desktop)?.file).toBe(claudeFile('-w-desk', ID.desktop))
    expect(history.findRow({ provider: 'claude', id: ID.desktop })?.file).toBe(claudeFile('-w-desk', ID.desktop))
    const detail = await history.detail({ provider: 'claude', id: ID.plain }, { repos: [], home: base })
    expect(detail.kind === 'ok' ? [detail.detail.file, detail.detail.messageCount] : null).toEqual([newer, 6])
    // 목록 순서: 활동순 정렬을 그대로 지킨다
    const at = rowsOf(result).map((row) => row.lastActivityAt)
    expect(at).toEqual([...at].sort((x, y) => y - x))
  })
})

describe('R5-1·R5-2 남길 기록 고르기 — 단계마다 따로 가린다', () => {
  // 단계마다 정답 위치를 뒤집은 두 쌍(`-a-` 폴더가 정답 · `-z-` 폴더가 정답) — `readdir` 순서가 어떻든 한 쌍은 정답이 먼저 본 파일이 아니다.
  const uid = (n: number): string => `e${n}e${n}e${n}e${n}-0000-4000-8000-00000000000${n}`
  const old = new Date(Date.UTC(2020, 0, 1))
  const newer = new Date(Date.UTC(2021, 0, 1))
  type Copy = { turns: number; pad?: number; mtime: Date }
  function plant(input: { id: string; answer: Copy; other: Copy; answerDir: string; otherDir: string }): string {
    const write = (dir: string, copy: Copy): string => {
      const file = claudeFile(dir, input.id)
      const turns = Array.from({ length: copy.turns }, (_, n) => ({ prompt: `p${n}`, reply: `r${n}` }))
      put(file, claudeSession({ id: input.id, cwd: work, turns, ...(copy.pad === undefined ? {} : { pad: copy.pad }) }))
      fs.utimesSync(file, copy.mtime, copy.mtime)
      return file
    }
    write(input.otherDir, input.other)
    return write(input.answerDir, input.answer)
  }
  it('① 활동이 늦으면 mtime 이 오래돼도 · ② 활동 같으면 mtime 이 늦은 쪽(크기가 작아도) · ③ 활동·mtime 같으면 크기가 큰 쪽', async () => {
    const stages: { name: string; answer: Copy; other: Copy }[] = [
      { name: 'activity', answer: { turns: 3, mtime: old }, other: { turns: 1, mtime: newer } },
      { name: 'mtime', answer: { turns: 1, mtime: newer }, other: { turns: 1, pad: 4096, mtime: old } },
      { name: 'size', answer: { turns: 1, pad: 4096, mtime: old }, other: { turns: 1, mtime: old } },
    ]
    const expected: Record<string, string> = {}
    stages.forEach((stage, index) => {
      const late = uid(index * 2 + 1)
      const early = uid(index * 2 + 2)
      expected[`${stage.name}:z`] = plant({ id: late, answer: stage.answer, other: stage.other, answerDir: `-z-${stage.name}`, otherDir: `-a-${stage.name}` })
      expected[`${stage.name}:a`] = plant({ id: early, answer: stage.answer, other: stage.other, answerDir: `-a-${stage.name}`, otherDir: `-z-${stage.name}` })
    })
    const history = newHistory()
    const result = await history.list({ providers: ['claude'] })
    const got: Record<string, string> = {}
    stages.forEach((stage, index) => {
      got[`${stage.name}:z`] = history.findRow({ provider: 'claude', id: uid(index * 2 + 1) })?.file ?? ''
      got[`${stage.name}:a`] = history.findRow({ provider: 'claude', id: uid(index * 2 + 2) })?.file ?? ''
    })
    expect(got).toEqual(expected)
    expect(rowsOf(result).filter((row) => row.id.startsWith('e'))).toHaveLength(6)
  })
  it('R5-2 활동·mtime·크기가 모두 같으면 경로가 앞선 쪽 — 비교 순서(인자 순서)와 무관', async () => {
    const at = { row: { lastActivityAt: 5, file: '/p/-a-x/s.jsonl' }, mtimeMs: 7, size: 9 }
    const zt = { row: { lastActivityAt: 5, file: '/p/-z-x/s.jsonl' }, mtimeMs: 7, size: 9 }
    expect([preferRecord({ candidate: at, current: zt }), preferRecord({ candidate: zt, current: at })]).toEqual([true, false])
    const id = uid(7)
    const same = claudeSession({ id, cwd: work, turns: [{ prompt: 'p', reply: 'r' }] })
    for (const dir of ['-z-tie', '-a-tie']) {
      put(claudeFile(dir, id), same)
      fs.utimesSync(claudeFile(dir, id), old, old)
    }
    const history = newHistory()
    await history.list({ providers: ['claude'] })
    expect(history.findRow({ provider: 'claude', id })?.file).toBe(claudeFile('-a-tie', id))
  })
})

describe('R3-4 provider 별 행 — 겹친 스캔이 끝난 순서와 무관', () => {
  it('[claude,codex] 스캔이 먼저 끝나고 [claude] 스캔이 뒤에 끝나도 Codex 행을 찾는다 · 각 스캔은 자기 provider 만 갈아 끼운다', async () => {
    // 행은 스캔이 **끝날 때** 갈아 끼운다 — 그래서 겹침의 결과는 끝난 순서로 정해진다. 그 순서를 결정적으로 재현한다:
    // 렌더러가 마지막으로 요청한 [claude,codex] 가 먼저 끝나고, 앞서 요청한 [claude] 가 뒤에 끝난다.
    const history = newHistory()
    await history.list({ providers: ['claude', 'codex'] })
    await history.list({ providers: ['claude'] })
    expect(history.findRow({ provider: 'codex', id: ID.codexNamed })?.id).toBe(ID.codexNamed)
    expect(history.findRow({ provider: 'claude', id: ID.custom })?.id).toBe(ID.custom)
  })
})

describe('C3 읽기 전용', () => {
  it('스캔·상세·재개 계획 조립 전후 fixture HOME 의 (경로·크기·mtime·sha256) 목록이 같다', async () => {
    const before = { claude: snapshot(claudeDir), codex: snapshot(codexDir) }
    const history = newHistory()
    await history.list({ providers: ['claude', 'codex'] })
    for (const id of [ID.custom, ID.aiTail, ID.plain, ID.codexNamed, ID.codexPlain]) {
      const provider = id.startsWith('a') || id.startsWith('b') ? 'codex' : 'claude'
      await history.detail({ provider, id }, { repos: [], home: base })
      await resumeSession({ provider, id, workspaceId: 'w1' }, { history, context: () => ({ repos: [], home: base }), openPanes: () => [], createRow: async () => ({ ok: true, paneId: 'p', tabId: 't', error: null }) })
    }
    await history.list({ providers: ['claude', 'codex'] })
    expect({ claude: snapshot(claudeDir), codex: snapshot(codexDir) }).toEqual(before)
  })
})

// --- C6 -------------------------------------------------------------------------------------------------

describe('C6 상세', () => {
  function seedLong(): void {
    put(claudeFile('-w-repo', ID.long), claudeSession({ id: ID.long, cwd: path.join(work, 'repo'), turns: [
      { prompt: LONG_PROMPT, reply: 'reply one' },
      { prompt: 'prompt two', reply: 'reply two' },
      { prompt: 'prompt three', reply: 'reply three' },
      { prompt: 'prompt four', reply: 'reply four' },
    ] }))
  }
  it('첫 프롬프트 전문(3,000자 왕복) · 메시지 수 = 사람 발화 + 응답 말풍선 · 최근 턴 6개', async () => {
    seedLong()
    const history = newHistory()
    await history.list({ providers: ['claude'] })
    const result = await history.detail({ provider: 'claude', id: ID.long }, { repos: [], home: base })
    if (result.kind !== 'ok') throw new Error(result.message)
    expect(LONG_PROMPT).toHaveLength(3000)
    expect(result.detail.firstPrompt).toBe(LONG_PROMPT)
    expect(result.detail.messageCount).toBe(8)
    expect(result.detail.recent.map((turn) => `${turn.role}:${turn.text}`)).toEqual([
      'prompt:prompt two', 'reply:reply two', 'prompt:prompt three', 'reply:reply three', 'prompt:prompt four', 'reply:reply four',
    ])
    expect(result.detail).toMatchObject({ id: ID.long, cwd: path.join(work, 'repo'), cwdExists: true, command: `cd ${path.join(work, 'repo')} && claude --resume ${ID.long}` })
  })
  it('Codex 상세 — 메시지 수 = 사람 발화 2 + 응답 2', async () => {
    const history = newHistory()
    await history.list({ providers: ['codex'] })
    const result = await history.detail({ provider: 'codex', id: ID.codexNamed }, { repos: [], home: base })
    if (result.kind !== 'ok') throw new Error(result.message)
    expect(result.detail).toMatchObject({ firstPrompt: 'codex named prompt', messageCount: 4 })
  })
  it('목록 스캔은 큰 파일을 끝까지 읽지 않는다 — 읽은 바이트 = 앞 창 + 뒤 창, 상세만 전체', async () => {
    const big = claudeFile('-w-repo', ID.aiTail)
    const size = fs.statSync(big).size
    for (const file of fs.readdirSync(path.dirname(big))) if (file !== path.basename(big) && file.endsWith('.jsonl')) fs.rmSync(path.join(path.dirname(big), file))
    fs.rmSync(path.join(claudeDir, 'projects', '-w-desk'), { recursive: true })
    const history = newHistory()
    await history.list({ providers: ['claude'] })
    expect(size).toBeGreaterThan(1024 * 1024)
    expect(history.stats.scanBytes).toBe(SCAN_HEAD_BYTES + SCAN_TAIL_BYTES)
    expect(history.stats.detailBytes).toBe(0)
    await history.detail({ provider: 'claude', id: ID.aiTail }, { repos: [], home: base })
    expect(history.stats.detailBytes).toBe(size)
  })
  it('목록에 없는 id·사라진 파일은 오류 값', async () => {
    const history = newHistory()
    await history.list({ providers: ['claude'] })
    expect(await history.detail({ provider: 'claude', id: '12345678-1234-4234-8234-123456789012' }, { repos: [], home: base })).toMatchObject({ kind: 'error' })
    fs.rmSync(claudeFile('-w-repo', ID.custom))
    expect(await history.detail({ provider: 'claude', id: ID.custom }, { repos: [], home: base })).toEqual({ kind: 'error', message: '기록 파일이 사라졌습니다' })
  })
})

// --- C7·C8 ----------------------------------------------------------------------------------------------

type Created = { workspaceId: string; kind: string; cwd: string; args: string[] }
function resumeDeps(input: { history: SessionHistory; context: ResumeContext; panes?: OpenPane[] }): { created: Created[]; deps: Parameters<typeof resumeSession>[1] } {
  const created: Created[] = []
  return {
    created,
    deps: {
      history: input.history,
      context: () => input.context,
      openPanes: () => input.panes ?? [],
      createRow: async (row) => {
        created.push(row)
        return { ok: true, paneId: 'w1:p9', tabId: 'w1:t9', error: null }
      },
    },
  }
}

describe('C7 재개 명령·cwd 정책', () => {
  it('원래 cwd 가 있으면 거기서 · argv 는 모델·effort 없이 · 인자 배열', async () => {
    const history = newHistory()
    await history.list({ providers: ['claude', 'codex'] })
    const { created, deps } = resumeDeps({ history, context: { repos: [], home: base } })
    expect(await resumeSession({ provider: 'claude', id: ID.custom, workspaceId: 'w1' }, deps)).toEqual({ kind: 'started', paneId: 'w1:p9', tabId: 'w1:t9', workspaceId: 'w1' })
    expect(await resumeSession({ provider: 'codex', id: ID.codexNamed, workspaceId: 'w1' }, deps)).toEqual({ kind: 'started', paneId: 'w1:p9', tabId: 'w1:t9', workspaceId: 'w1' })
    expect(created).toEqual([
      { workspaceId: 'w1', kind: 'claude', cwd: path.join(work, 'repo'), args: ['--resume', ID.custom] },
      { workspaceId: 'w1', kind: 'codex', cwd: path.join(work, 'repo'), args: ['resume', ID.codexNamed] },
    ])
  })
  it('원래 cwd 가 없으면 그 세션이 속한 등록 레포 root → 없으면 가장 가까운 존재하는 조상', async () => {
    const history = newHistory()
    const result = await history.list({ providers: ['claude', 'codex'] })
    const plain = rowOf(result, ID.plain)
    const desktop = rowOf(result, ID.desktop)
    if (plain === undefined || desktop === undefined) throw new Error('fixture')
    const repoRoot = path.join(work, 'repo')
    // 지운 worktree `<work>/gone/wt` 가 등록 레포 `<work>/gone` 의 연결 worktree 였다 — root 가 없으면 조상으로.
    expect(history.resumePlan({ row: plain, context: { repos: [{ root: path.join(work, 'gone'), worktrees: [path.join(work, 'gone', 'wt')] }], home: base } })).toEqual({ argv: ['claude', '--resume', ID.plain], cwd: work, fallback: true, disabled: null })
    expect(history.resumePlan({ row: plain, context: { repos: [{ root: repoRoot, worktrees: [path.join(work, 'gone', 'wt')] }], home: base } })).toEqual({ argv: ['claude', '--resume', ID.plain], cwd: repoRoot, fallback: true, disabled: null })
    expect(history.resumePlan({ row: plain, context: { repos: [], home: base } }).cwd).toBe(work)
    expect(history.resumePlan({ row: desktop, context: { repos: [], home: base } }).cwd).toBe('/')
  })
  it('R3-1 목록 뒤 원래 cwd 가 지워지면 재개·상세는 그 시점 디스크로 — fallback·대체 cwd, Codex 는 정책 false 면 비활성(프로세스 0)', async () => {
    const context = { repos: [{ root: work, worktrees: [work] }], home: base }
    const history = newHistory(false)
    await history.list({ providers: ['claude', 'codex'] })
    fs.rmSync(path.join(work, 'repo'), { recursive: true, force: true })
    const { created, deps } = resumeDeps({ history, context })
    expect(await resumeSession({ provider: 'claude', id: ID.custom, workspaceId: 'w1' }, deps)).toEqual({ kind: 'started', paneId: 'w1:p9', tabId: 'w1:t9', workspaceId: 'w1' })
    expect(await resumeSession({ provider: 'codex', id: ID.codexNamed, workspaceId: 'w1' }, deps)).toEqual({ kind: 'rejected', reason: 'Codex 의 다른 폴더 재개를 꺼 두었습니다 — 명령만 복사하세요' })
    expect(created).toEqual([{ workspaceId: 'w1', kind: 'claude', cwd: work, args: ['--resume', ID.custom] }])
    const detail = await history.detail({ provider: 'claude', id: ID.custom }, context)
    expect(detail.kind === 'ok' ? { resume: detail.detail.resume, command: detail.detail.command } : null).toEqual({
      resume: { argv: ['claude', '--resume', ID.custom], cwd: work, fallback: true, disabled: null },
      command: `cd ${work} && claude --resume ${ID.custom}`,
    })
  })
  it('R2-6 등록 root 가 심링크 경로여도 realpath 로 비교한다 — 지운 worktree 세션은 그 등록 root 에서', async () => {
    const history = newHistory()
    const result = await history.list({ providers: ['claude'] })
    const plain = rowOf(result, ID.plain)
    if (plain === undefined) throw new Error('fixture')
    fs.mkdirSync(path.join(base, 'r26-real'))
    const real = fs.realpathSync(path.join(base, 'r26-real'))
    const link = path.join(base, 'r26-link')
    fs.symlinkSync(real, link)
    const gone = path.join(real, '.claude', 'worktrees', 'x')
    const row = { ...plain, cwd: gone, cwdKey: gone, cwdExists: false }
    expect(history.resumePlan({ row, context: { repos: [{ root: link, worktrees: [link] }], home: base } }).cwd).toBe(link)
  })
  it('Codex 가 원래 cwd 없이 재개되지 않는 정책이면 그 세션은 재개 비활성 + 사유, 프로세스 0', async () => {
    const history = newHistory(false)
    await history.list({ providers: ['codex'] })
    const { created, deps } = resumeDeps({ history, context: { repos: [], home: base } })
    const result = await resumeSession({ provider: 'codex', id: ID.codexPlain, workspaceId: 'w1' }, deps)
    expect(result).toEqual({ kind: 'rejected', reason: 'Codex 의 다른 폴더 재개를 꺼 두었습니다 — 명령만 복사하세요' })
    expect(created).toHaveLength(0)
    const detail = await history.detail({ provider: 'codex', id: ID.codexPlain }, { repos: [], home: base })
    expect(detail.kind === 'ok' ? detail.detail.resume.disabled : null).toBe('Codex 의 다른 폴더 재개를 꺼 두었습니다 — 명령만 복사하세요')
  })
  it('세션 id 는 UUID 꼴만 — 그 밖의 값은 거절, 프로세스 0', async () => {
    const history = newHistory()
    await history.list({ providers: ['claude', 'codex'] })
    const { created, deps } = resumeDeps({ history, context: { repos: [], home: base } })
    for (const id of ['../../etc/passwd', `${ID.custom}; rm -rf /`, '--help', '', 'not-a-uuid', 42]) {
      expect(await resumeSession({ provider: 'claude', id, workspaceId: 'w1' }, deps)).toEqual({ kind: 'rejected', reason: '잘못된 세션 식별자' })
    }
    expect(await resumeSession({ provider: 'grok', id: ID.custom, workspaceId: 'w1' }, deps)).toEqual({ kind: 'rejected', reason: '잘못된 세션 식별자' })
    expect(await resumeSession({ provider: 'claude', id: '12345678-1234-4234-8234-123456789012', workspaceId: 'w1' }, deps)).toEqual({ kind: 'rejected', reason: '목록에 없는 세션입니다 — 새로고침하세요' })
    expect(created).toHaveLength(0)
  })
  it('명령 글은 실제 재개 cwd 를 앞에 붙인다 — 따옴표가 필요한 경로는 감싼다', () => {
    expect(resumeCommandText({ argv: ['claude', '--resume', ID.custom], cwd: '/a/b' })).toBe(`cd /a/b && claude --resume ${ID.custom}`)
    expect(resumeCommandText({ argv: ['codex', 'resume', ID.codexNamed], cwd: "/a b/it's" })).toBe(`cd '/a b/it'\\''s' && codex resume ${ID.codexNamed}`)
  })
})

describe('C8 이미 열린 세션 (main 가드)', () => {
  it('R2-3 진행 표지는 재개가 만든 pane 에 묶인다 — 나타남 → 열림(세션 참조가 다른 id 여도 중복 0) · 사라짐·에이전트 끝남 → 바로 재개', async () => {
    const history = newHistory()
    await history.list({ providers: ['claude'] })
    let panes: OpenPane[] = []
    const { created, deps } = resumeDeps({ history, context: { repos: [], home: base } })
    deps.openPanes = () => panes
    deps.now = () => 1_000
    const input = { provider: 'claude', id: ID.custom, workspaceId: 'w1' }
    const seen: string[] = []
    const step = async (): Promise<void> => {
      const result = await resumeSession(input, deps)
      seen.push(`${result.kind}${result.kind === 'open' ? `@${result.paneId}` : ''}:${created.length}`)
    }
    await step()
    await step() // pane 이 아직 상태에 없다 — 진행 중
    panes = [{ paneId: 'w1:p9', agent: 'claude', sessionId: '99999999-9999-4999-8999-999999999999' }]
    await step() // 만든 pane 이 에이전트로 보인다 — 세션 참조가 다른 id 여도 열림
    panes = []
    await step() // 그 pane 이 사라졌다 — 시간 경과 없이 바로 재개
    panes = [{ paneId: 'w1:p9', agent: 'claude', sessionId: null }]
    await step()
    panes = [{ paneId: 'w1:p9', agent: null, sessionId: null }]
    await step() // 감지됐던 에이전트가 끝났다 — 바로 재개
    expect(seen).toEqual(['started:1', 'pending:1', 'open@w1:p9:1', 'started:2', 'open@w1:p9:2', 'started:3'])
  })
  it('열림 3칸 — agent null(에이전트 끝남) → 재개 · 다른 provider → 재개 · 같은 provider → 열림(새 프로세스 0)', async () => {
    const cases: [OpenPane, string][] = [
      [{ paneId: 'w2:p1', agent: null, sessionId: ID.custom }, 'started'],
      [{ paneId: 'w2:p1', agent: 'codex', sessionId: ID.custom }, 'started'],
      [{ paneId: 'w2:p1', agent: 'claude', sessionId: ID.custom }, 'open'],
    ]
    const seen: string[] = []
    for (const [pane] of cases) {
      const history = newHistory()
      await history.list({ providers: ['claude'] })
      const { created, deps } = resumeDeps({ history, context: { repos: [], home: base }, panes: [pane] })
      const result = await resumeSession({ provider: 'claude', id: ID.custom, workspaceId: 'w1' }, deps)
      seen.push(`${result.kind}:${created.length}`)
    }
    expect(seen).toEqual(['started:1', 'started:1', 'open:0'])
    expect(cases.map(([, kind]) => kind)).toEqual(['started', 'started', 'open'])
  })
  it('R1-2 진행 중 재개 — 동시 2회 → createRow 1 · 두 번째는 pending · 제한 시간 뒤엔 다시 재개 · 기동 실패면 바로 풀린다', async () => {
    const history = newHistory()
    await history.list({ providers: ['claude'] })
    let clock = 1_000
    let release: () => void = () => undefined
    const created: string[] = []
    let fail = false
    const deps: Parameters<typeof resumeSession>[1] = {
      history, context: () => ({ repos: [], home: base }), openPanes: () => [], now: () => clock,
      createRow: (row) => {
        created.push(row.cwd)
        if (fail) return Promise.resolve({ ok: false, paneId: null, tabId: null, error: 'agent_pane_busy' })
        return new Promise((resolve) => { release = () => resolve({ ok: true, paneId: 'w1:p9', tabId: 'w1:t9', error: null }) })
      },
    }
    const input = { provider: 'claude', id: ID.custom, workspaceId: 'w1' }
    const first = resumeSession(input, deps)
    const second = await resumeSession(input, deps)
    release()
    expect([await first, second]).toEqual([{ kind: 'started', paneId: 'w1:p9', tabId: 'w1:t9', workspaceId: 'w1' }, { kind: 'pending' }])
    expect(created).toHaveLength(1)
    // 기동 뒤에도 pane 이 보일 때까지는 pending
    expect(await resumeSession(input, deps)).toEqual({ kind: 'pending' })
    expect(created).toHaveLength(1)
    // 제한 시간이 지나면 다시 재개할 수 있다 — 이번엔 기동 실패 → 표지가 바로 풀려 다음 요청이 또 기동한다
    clock += RESUME_PENDING_MS
    fail = true
    expect((await resumeSession(input, deps)).kind).toBe('error')
    expect((await resumeSession(input, deps)).kind).toBe('error')
    expect(created).toHaveLength(3)
  })
  it('R1-2 진행 중이어도 그 세션의 pane 이 에이전트로 보이면 open 으로 답하고 표지를 지운다', async () => {
    const history = newHistory()
    await history.list({ providers: ['claude'] })
    let panes: OpenPane[] = []
    const { created, deps } = resumeDeps({ history, context: { repos: [], home: base } })
    deps.openPanes = () => panes
    expect((await resumeSession({ provider: 'claude', id: ID.custom, workspaceId: 'w1' }, deps)).kind).toBe('started')
    panes = [{ paneId: 'w1:p9', agent: 'claude', sessionId: ID.custom }]
    expect(await resumeSession({ provider: 'claude', id: ID.custom, workspaceId: 'w1' }, deps)).toEqual({ kind: 'open', paneId: 'w1:p9' })
    panes = []
    expect((await resumeSession({ provider: 'claude', id: ID.custom, workspaceId: 'w1' }, deps)).kind).toBe('started')
    expect(created).toHaveLength(2)
  })
})

// --- C11 ------------------------------------------------------------------------------------------------

describe('C11 캐시', () => {
  it('mtime·size 가 같은 파일은 다시 파싱하지 않는다 — 바뀐 파일만 다시', async () => {
    const history = newHistory()
    await history.list({ providers: ['claude', 'codex'] })
    // claude 파일 8(subagent 제외) + codex 파일 5
    expect(history.stats.parsed).toBe(13)
    const bytes = history.stats.scanBytes
    await history.list({ providers: ['claude', 'codex'] })
    expect(history.stats.parsed).toBe(13)
    expect(history.stats.scanBytes).toBe(bytes)
    fs.appendFileSync(claudeFile('-w-repo', ID.custom), JSON.stringify({ type: 'custom-title', sessionId: ID.custom, customTitle: '바뀐 제목' }) + '\n')
    const result = await history.list({ providers: ['claude', 'codex'] })
    expect(history.stats.parsed).toBe(14)
    expect(rowOf(result, ID.custom)?.title).toBe('바뀐 제목')
  })
})

// --- C18 ------------------------------------------------------------------------------------------------

describe('C18 에이전트 필터 — 끈 provider 는 훑지 않는다', () => {
  it('켬/끔 조합 4가지 기대 건수 · 끈 쪽 파싱 0', async () => {
    const cases: [('claude' | 'codex')[], number, number][] = [
      [['claude', 'codex'], 9, 13],
      [['claude'], 6, 8],
      [['codex'], 3, 5],
      [[], 0, 0],
    ]
    for (const [providers, rows, parsed] of cases) {
      const history = newHistory()
      const result = await history.list({ providers })
      expect([providers.join('+'), rowsOf(result).length, history.stats.parsed]).toEqual([providers.join('+'), rows, parsed])
    }
  })
})

// --- C19 ------------------------------------------------------------------------------------------------

describe('C19 Finder 에서 보기 — 식별자로만', () => {
  it('스캔 결과의 파일을 연다 · 목록에 없는 id·`..` 섞인 값은 거절(열기 0) · 사라진 파일은 오류 글', async () => {
    const history = newHistory()
    await history.list({ providers: ['claude', 'codex'] })
    const shown: string[] = []
    const deps = { history, show: (file: string) => { shown.push(file) } }
    expect(await revealSession({ provider: 'claude', id: ID.custom }, deps)).toEqual({ kind: 'ok' })
    expect(shown).toEqual([claudeFile('-w-repo', ID.custom)])
    expect(await revealSession({ provider: 'claude', id: '12345678-1234-4234-8234-123456789012' }, deps)).toEqual({ kind: 'rejected', reason: '목록에 없는 세션입니다' })
    expect(await revealSession({ provider: 'claude', id: `../${ID.custom}` }, deps)).toEqual({ kind: 'rejected', reason: '잘못된 세션 식별자' })
    expect(await revealSession({ provider: 'claude', id: ID.custom, file: '/etc/passwd' }, deps)).toEqual({ kind: 'ok' })
    expect(shown).toEqual([claudeFile('-w-repo', ID.custom), claudeFile('-w-repo', ID.custom)])
    fs.rmSync(claudeFile('-w-repo', ID.custom))
    expect(await revealSession({ provider: 'claude', id: ID.custom }, deps)).toEqual({ kind: 'error', message: '기록 파일이 사라졌습니다' })
    expect(shown).toHaveLength(2)
  })
})

// --- C17 ------------------------------------------------------------------------------------------------

describe('C17 빈 세션 숨기기 — 메타 줄만 있는 Claude · 턴 없는 Codex 는 빈 세션', () => {
  it('켬 7 · 끔 9 — 에이전트 필터와 겹친다', async () => {
    const result = await newHistory().list({ providers: ['claude', 'codex'] })
    const rows = rowsOf(result)
    expect(rows.filter((row) => row.empty).map((row) => row.id).sort()).toEqual([ID.meta, ID.codexEmpty].sort())
    expect(filterRows({ rows, agents: { claude: true, codex: true }, hideEmpty: true })).toHaveLength(7)
    expect(filterRows({ rows, agents: { claude: true, codex: true }, hideEmpty: false })).toHaveLength(9)
    expect(filterRows({ rows, agents: { claude: true, codex: false }, hideEmpty: true })).toHaveLength(5)
    expect(filterRows({ rows, agents: { claude: false, codex: true }, hideEmpty: false })).toHaveLength(3)
  })
  it('앞 창에서 잘린 거대 사람 줄(64KB 넘는 이미지 붙여넣기 꼴)도 「앞 창에 사람 프롬프트」 — 같은 꼴의 도구 결과 줄은 아니다', async () => {
    const human = '13131313-1313-4313-8313-131313131313'
    const tool = '14141414-1414-4414-8414-141414141414'
    const giant = (id: string, block: unknown): string => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: [block] }, uuid: 'g', sessionId: id, cwd: work, entrypoint: 'cli', timestamp: '2026-11-19T01:00:00.000Z' })
    const filler = (id: string): string => jsonl(Array.from({ length: 300 }, () => ({ type: 'mode', sessionId: id, mode: 'y'.repeat(400) })))
    put(claudeFile('-w-repo', human), jsonl([{ type: 'last-prompt', sessionId: human }]) + giant(human, { type: 'image', source: { type: 'base64', data: 'A'.repeat(200 * 1024) } }) + '\n' + filler(human))
    put(claudeFile('-w-repo', tool), jsonl([{ type: 'last-prompt', sessionId: tool }]) + giant(tool, { tool_use_id: 't1', type: 'tool_result', content: 'B'.repeat(200 * 1024) }) + '\n' + filler(tool))
    const result = await newHistory().list({ providers: ['claude'] })
    expect([rowOf(result, human)?.empty, rowOf(result, tool)?.empty]).toEqual([false, true])
    expect(rowOf(result, human)).toMatchObject({ firstPrompt: null, title: null })
  })
  it('앞 창에 사람 프롬프트가 있으면 빈 세션이 아니다 — 꼬리가 메타 줄뿐이어도', async () => {
    const id = '12121212-1212-4212-8212-121212121212'
    put(claudeFile('-w-repo', id), claudeSession({ id, cwd: work, turns: [{ prompt: 'only prompt', reply: 'ok' }], tail: Array.from({ length: 400 }, () => ({ type: 'mode', sessionId: id, mode: 'x'.repeat(400) })) }))
    const row = rowOf(await newHistory().list({ providers: ['claude'] }), id)
    expect(fs.statSync(claudeFile('-w-repo', id)).size).toBeGreaterThan(SCAN_HEAD_BYTES + SCAN_TAIL_BYTES)
    expect(row).toMatchObject({ empty: false, firstPrompt: 'only prompt', lastPrompt: 'only prompt' })
  })
})
