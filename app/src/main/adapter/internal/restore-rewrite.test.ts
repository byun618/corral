// herdr 재시작 재개 참조 고쳐 쓰기 (LIFE-772 C1·C2ⓓ) — 전부 「합성」: 손으로 지은 session.json·기록 파일로 판별·고쳐 쓰기 규칙만 증명한다.
// 실제 herdr 가 고친 파일로 `claude --resume <X>` 를 치고 Claude Code 가 그 대화를 연다는 근거는 끝-끝 회차(C4)뿐이다.
// session.json 모양은 herdr 0.9.0 이 실제로 쓴 파일(코디 probe1 08), 기록 줄 모양은 LIFE-766 fixture 와 같다(값은 지어냈다).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRef } from '../../../shared/types.js'
import { clearTranscriptCache } from '../../transcript.js'
import { CONTINUED_CHAIN_MAX, CONTINUED_TAIL_BYTES, clearContinuedMemo, followContinued } from '../../transcript-continued.js'
import { planRestoreRewrite, rewriteBeforeSpawn, rewriteRestoreRefs, type RestoreRewrite } from './restore-rewrite.js'
import { countRestoreTargets } from './server.js'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const D = '00000000-0000-4000-8000-00000000000d'
const LOST = '00000000-0000-4000-8000-0000000000ff'

const row = (value: unknown): string => `${JSON.stringify(value)}\n`
const fork = (to: string, from: string): string => row({ type: 'continued-in', timestamp: '2026-01-01T00:00:00.000Z', sessionId: from, continuedInSessionId: to })
const human = (text: string, sessionId: string): string => row({ type: 'user', sessionId, uuid: `u-${text}`, parentUuid: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: text } })
const reply = (text: string, sessionId: string): string => row({ type: 'assistant', sessionId, uuid: `a-${text}`, parentUuid: null, timestamp: '2026-01-01T00:00:02.000Z', message: { id: `m-${text}`, role: 'assistant', model: 'x', content: [{ type: 'text', text }] } })
const meta = (sessionId: string): string => row({ type: 'cost-state', sessionId, totalCostUSD: 0 })
const talk = (id: string): string => human(`q-${id}`, id) + reply(`r-${id}`, id)

type Ref = { source: string; agent: string; kind: 'id' | 'path'; value: string } | null

/** herdr 0.9.0 현재 형식 — 들여쓰기 2칸·키 순서는 probe1 08-session.json 그대로. pane 마다 참조 하나. */
function sessionJson(refs: Ref[]): string {
  const panes: Record<string, unknown> = {}
  refs.forEach((ref, index) => {
    panes[String(index + 1)] = { cwd: '/tmp/w', agent_name: `p${index + 1}`, managed_agent_kind: ref?.agent ?? null, agent_session: ref }
  })
  return `${JSON.stringify(
    {
      version: 3,
      workspaces: [{ id: 'w1', custom_name: null, identity_cwd: '/tmp/w', public_pane_numbers: { '1': 1 }, next_public_pane_number: 2, public_tab_numbers: [1], next_public_tab_number: 2, tabs: [{ custom_name: null, layout: { Pane: 1 }, panes, zoomed: false, focused: 1, root_pane: 1 }], active_tab: 0 }],
      active: 0,
      selected: 0,
      sidebar_width: null,
      sidebar_section_split: null,
      collapsed_space_keys: [],
    },
    null,
    2,
  )}\n`
}
const claude = (value: string): Ref => ({ source: 'herdr:claude', agent: 'claude', kind: 'id', value })

let home = ''
let realHome: string | undefined
let projects = ''
let sessionDir = ''
const fileOf = (id: string): string => path.join(projects, `${id}.jsonl`)
const sessionFile = (): string => path.join(sessionDir, 'session.json')
const writeSession = (text: string): void => fs.writeFileSync(sessionFile(), text)
const readSession = (): string => fs.readFileSync(sessionFile(), 'utf8')
const leftovers = (): string[] => fs.readdirSync(sessionDir).filter((name) => name !== 'session.json')

/** 766 판별(표시 쪽 `empty: 'stay'`)이 그 참조에서 고르는 세션 id — 고쳐 쓰기가 같은 답을 내야 한다(C1ⓒ). */
function displayed(id: string): string {
  const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr:claude', id }
  const file = fileOf(id)
  if (!fs.existsSync(file)) return id
  return followContinued({ session: ref, file, empty: 'stay' }).sessionId ?? id
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'l772-'))
  realHome = process.env['HOME']
  process.env['HOME'] = home
  projects = path.join(home, '.claude', 'projects', 'proj')
  fs.mkdirSync(projects, { recursive: true })
  sessionDir = path.join(home, 'herdr', 'sessions', 'default')
  fs.mkdirSync(sessionDir, { recursive: true })
  clearTranscriptCache()
  clearContinuedMemo()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (realHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = realHome
  fs.chmodSync(sessionDir, 0o755)
  fs.rmSync(home, { recursive: true, force: true })
  clearTranscriptCache()
  clearContinuedMemo()
})

describe('C1 합성 — 경우별 (수정 전 동작 표 K0~K9)', () => {
  it('K0 합성: 전환 없는 참조 → unchanged · 파일 바이트 무변경', () => {
    fs.writeFileSync(fileOf(A), talk(A))
    const before = sessionJson([claude(A)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir })).toEqual({ kind: 'unchanged', refs: 1 })
    expect(readSession()).toBe(before)
    expect(leftovers()).toEqual([])
  })

  it('K1 합성: 전환 뒤 대화가 있는 대상 → value 만 X 로 · 나머지 바이트 동일 · 계수 같음(C2ⓓ)', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A) + meta(A))
    fs.writeFileSync(fileOf(B), meta(B) + talk(B))
    const before = sessionJson([claude(A)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir })).toEqual({ kind: 'rewritten', refs: 1, moved: 1 })
    const after = readSession()
    // ⓐ 바이트 보존 — 차이는 value 문자열뿐(키 순서·공백·다른 필드 동일).
    expect(after).toBe(before.replace(`"${A}"`, `"${B}"`))
    expect(after.length).toBe(before.length)
    expect(JSON.parse(after).workspaces[0].tabs[0].panes['1'].agent_session.value).toBe(B)
    expect(countRestoreTargets(after)).toEqual(countRestoreTargets(before))
    expect(leftovers()).toEqual([])
  })

  it('K3 합성: 이미 갈라진 기록(continued-in 뒤 옛 id 사람 줄) → 고쳐 쓰지 않는다', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A) + human('갈라짐', A) + reply('갈라짐', A))
    fs.writeFileSync(fileOf(B), talk(B))
    const before = sessionJson([claude(A)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir })).toEqual({ kind: 'unchanged', refs: 1 })
    expect(readSession()).toBe(before)
  })

  it('K4ⓐ 합성: continued-in 뒤 읽지 못하는 줄(모름) → 무변경', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A) + '{"type":"user","sess\n')
    fs.writeFileSync(fileOf(B), talk(B))
    const before = sessionJson([claude(A)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir }).kind).toBe('unchanged')
    expect(readSession()).toBe(before)
  })

  it('K4ⓑ 합성: continued-in 이 판별 창 밖으로 밀려남 → 무변경', () => {
    const padding = row({ type: 'cost-state', sessionId: A, pad: 'x'.repeat(4096) })
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A) + padding.repeat(Math.ceil(CONTINUED_TAIL_BYTES / padding.length) + 2))
    fs.writeFileSync(fileOf(B), talk(B))
    const before = sessionJson([claude(A)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir }).kind).toBe('unchanged')
    expect(readSession()).toBe(before)
  })

  it('K4ⓒ 합성: 대상 파일 없음 → 무변경', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(LOST, A))
    const before = sessionJson([claude(A)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir }).kind).toBe('unchanged')
    expect(readSession()).toBe(before)
  })

  it('K4ⓓ 합성: 대상에 대화 없음(전환 직후 메타 줄뿐) → 무변경', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), meta(B) + row({ type: 'mode', sessionId: B }))
    const before = sessionJson([claude(A)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir }).kind).toBe('unchanged')
    expect(readSession()).toBe(before)
  })

  it('K4 합성: 참조의 기록 파일 자체를 못 찾음 → 무변경', () => {
    const before = sessionJson([claude(A)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir }).kind).toBe('unchanged')
    expect(readSession()).toBe(before)
  })

  it('K5 합성: 연쇄 A→B→C → C', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B) + fork(C, B))
    fs.writeFileSync(fileOf(C), talk(C))
    const before = sessionJson([claude(A)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir })).toEqual({ kind: 'rewritten', refs: 1, moved: 1 })
    expect(readSession()).toBe(before.replace(`"${A}"`, `"${C}"`))
  })

  it('K5 합성: 연쇄 중간 대상에 대화 없음 → 그 앞(B)에 머문다 — 766 stay 와 같다', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B) + fork(C, B))
    fs.writeFileSync(fileOf(C), meta(C))
    writeSession(sessionJson([claude(A)]))
    rewriteRestoreRefs({ sessionDir })
    expect(JSON.parse(readSession()).workspaces[0].tabs[0].panes['1'].agent_session.value).toBe(B)
  })

  it('K5 합성: 연쇄가 상한을 넘으면 766 과 같이 상한까지 간 곳으로', () => {
    const ids = Array.from({ length: CONTINUED_CHAIN_MAX + 3 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
    ids.forEach((id, index) => fs.writeFileSync(fileOf(id), talk(id) + (ids[index + 1] === undefined ? '' : fork(ids[index + 1]!, id))))
    writeSession(sessionJson([claude(ids[0]!)]))
    rewriteRestoreRefs({ sessionDir })
    const value: string = JSON.parse(readSession()).workspaces[0].tabs[0].panes['1'].agent_session.value
    expect(value).toBe(ids[CONTINUED_CHAIN_MAX])
    expect(value).toBe(displayed(ids[0]!))
  })

  it('K6 합성: claude 아닌 참조·경로 참조는 그대로, claude 만 바뀐다', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B))
    const others: Ref[] = [
      { source: 'herdr:codex', agent: 'codex', kind: 'id', value: C },
      { source: 'herdr:grok', agent: 'grok', kind: 'id', value: D },
      { source: 'herdr:claude', agent: 'claude', kind: 'path', value: '/tmp/x.jsonl' },
      null,
    ]
    const before = sessionJson([...others, claude(A)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir })).toEqual({ kind: 'rewritten', refs: 1, moved: 1 })
    expect(readSession()).toBe(before.replace(`"${A}"`, `"${B}"`))
  })

  it('K6 합성: claude 아닌 참조만 있으면 기록 파일도 찾지 않는다', () => {
    const locate = vi.fn(() => null)
    writeSession(sessionJson([{ source: 'herdr:codex', agent: 'codex', kind: 'id', value: A }]))
    expect(rewriteRestoreRefs({ sessionDir, locate })).toEqual({ kind: 'unchanged', refs: 0 })
    expect(locate).not.toHaveBeenCalled()
  })

  it.each([
    ['JSON 아님', '{"version":3,'],
    ['workspaces 없음', '{"version":3}\n'],
    ['구조 모름', '{"workspaces":[{"id":"w1"}]}\n'],
    ['pane 이 객체 아님', '{"workspaces":[{"identity_cwd":"/","tabs":[{"panes":{"1":3}}]}]}\n'],
  ])('K7 합성: %s → skipped · 바이트 무변경', (_name, text) => {
    writeSession(text)
    expect(rewriteRestoreRefs({ sessionDir }).kind).toBe('skipped')
    expect(readSession()).toBe(text)
    expect(leftovers()).toEqual([])
  })

  it('K7 합성: session.json 없음 → skipped · 아무 파일도 만들지 않는다', () => {
    expect(rewriteRestoreRefs({ sessionDir }).kind).toBe('skipped')
    expect(fs.readdirSync(sessionDir)).toEqual([])
  })

  it('K7 합성: session.json 이 심볼릭 링크 → skipped (rename 이 링크를 파일로 바꾸지 않게)', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B))
    const real = path.join(home, 'real-session.json')
    fs.writeFileSync(real, sessionJson([claude(A)]))
    fs.symlinkSync(real, sessionFile())
    expect(rewriteRestoreRefs({ sessionDir }).kind).toBe('skipped')
    expect(fs.lstatSync(sessionFile()).isSymbolicLink()).toBe(true)
  })

  it('K7 합성: 구형 형식(layout + workspace.panes)도 같은 판별로 고친다', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B))
    const before = `${JSON.stringify({ workspaces: [{ id: 'w1', layout: { Pane: 1 }, panes: { '1': { cwd: '/', agent_session: claude(A) } } }] }, null, 2)}\n`
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir }).kind).toBe('rewritten')
    expect(readSession()).toBe(before.replace(`"${A}"`, `"${B}"`))
  })

  it('K9 합성: 디렉터리에 쓸 수 없음 → failed · 원본 그대로 · 임시 파일 없음', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B))
    const before = sessionJson([claude(A)])
    writeSession(before)
    fs.chmodSync(sessionDir, 0o555)
    const result = rewriteRestoreRefs({ sessionDir })
    fs.chmodSync(sessionDir, 0o755)
    expect(result).toEqual({ kind: 'failed', reason: 'EACCES' })
    expect(readSession()).toBe(before)
    expect(leftovers()).toEqual([])
  })

  it('ⓑ 합성: 같은 디렉터리 임시 파일 → rename · rename 이 실패하면 원본 그대로·임시 파일 지움', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B))
    const before = sessionJson([claude(A)])
    writeSession(before)
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('boom'), { code: 'EIO' })
    })
    expect(rewriteRestoreRefs({ sessionDir })).toEqual({ kind: 'failed', reason: 'EIO' })
    expect(rename).toHaveBeenCalledTimes(1)
    const [from, to] = rename.mock.calls[0]!
    expect(path.dirname(String(from))).toBe(sessionDir)
    expect(to).toBe(sessionFile())
    expect(readSession()).toBe(before)
    expect(leftovers()).toEqual([])
  })

  it('ⓑ 합성: 원본 권한을 그대로 옮긴다', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B))
    writeSession(sessionJson([claude(A)]))
    fs.chmodSync(sessionFile(), 0o600)
    rewriteRestoreRefs({ sessionDir })
    expect(fs.statSync(sessionFile()).mode & 0o777).toBe(0o600)
  })

  it('쓰기 창 합성: 읽은 뒤 다른 손이 session.json 을 바꾸면 rename 하지 않는다(그 쓰기를 덮지 않는다)', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B))
    writeSession(sessionJson([claude(A)]))
    const theirs = sessionJson([claude(A), claude(C)])
    const locate = (ref: AgentSessionRef): string | null => {
      writeSession(theirs) // 판별 도중 herdr 가 떠서 파일을 새로 썼다
      return ref.kind === 'id' ? fileOf(ref.id) : null
    }
    expect(rewriteRestoreRefs({ sessionDir, locate })).toEqual({ kind: 'skipped', reason: '읽은 뒤 session.json 이 바뀌었다' })
    expect(readSession()).toBe(theirs)
    expect(leftovers()).toEqual([])
  })

  it('ⓐ 합성: 참조 값이 참조 밖(다른 필드)에도 있으면 바이트 치환을 하지 않는다', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B))
    const before = sessionJson([claude(A)]).replace('"custom_name": null', `"custom_name": "${A}"`)
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir })).toEqual({ kind: 'skipped', reason: '참조 값이 참조 밖에도 있다' })
    expect(readSession()).toBe(before)
  })

  it('K10 합성: 두 pane 이 같은 옛 id → 둘 다 X (herdr dedupe 는 이미 같은 키라 바뀌지 않는다)', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B))
    const before = sessionJson([claude(A), claude(A)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir })).toEqual({ kind: 'rewritten', refs: 2, moved: 1 })
    expect(readSession()).toBe(before.replaceAll(`"${A}"`, `"${B}"`))
  })

  it('K10 합성: 옛 id pane 과 이미 X 인 pane 이 같은 X 로 모이면 옛 pane 은 그대로 — herdr dedupe 로 한 pane 이 재개를 잃지 않게(consumers.md 12)', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(B), talk(B))
    const before = sessionJson([claude(A), claude(B)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir })).toEqual({ kind: 'unchanged', refs: 2 })
    expect(readSession()).toBe(before)
  })

  it('K10 합성: 서로 다른 옛 id 둘이 같은 X 로 가면 앞 것만 옮긴다', () => {
    fs.writeFileSync(fileOf(A), talk(A) + fork(B, A))
    fs.writeFileSync(fileOf(C), talk(C) + fork(B, C))
    fs.writeFileSync(fileOf(B), talk(B))
    const before = sessionJson([claude(A), claude(C)])
    writeSession(before)
    expect(rewriteRestoreRefs({ sessionDir })).toEqual({ kind: 'rewritten', refs: 2, moved: 1 })
    expect(readSession()).toBe(before.replace(`"${A}"`, `"${B}"`))
  })
})

describe('C1ⓒ 합성 — 766 followContinued(stay) 와 같은 답', () => {
  const cases: Array<[string, () => void]> = [
    ['전환 없음', () => fs.writeFileSync(fileOf(A), talk(A))],
    ['전환 · 대화 있음', () => { fs.writeFileSync(fileOf(A), talk(A) + fork(B, A)); fs.writeFileSync(fileOf(B), talk(B)) }],
    ['되살아남', () => { fs.writeFileSync(fileOf(A), talk(A) + fork(B, A) + talk(A)); fs.writeFileSync(fileOf(B), talk(B)) }],
    ['모름', () => { fs.writeFileSync(fileOf(A), talk(A) + fork(B, A) + '{"x\n'); fs.writeFileSync(fileOf(B), talk(B)) }],
    ['대상 없음', () => fs.writeFileSync(fileOf(A), talk(A) + fork(LOST, A))],
    ['대상 빈', () => { fs.writeFileSync(fileOf(A), talk(A) + fork(B, A)); fs.writeFileSync(fileOf(B), meta(B)) }],
    ['연쇄', () => { fs.writeFileSync(fileOf(A), fork(B, A)); fs.writeFileSync(fileOf(B), talk(B) + fork(C, B)); fs.writeFileSync(fileOf(C), talk(C)) }],
    ['순환', () => { fs.writeFileSync(fileOf(A), talk(A) + fork(B, A)); fs.writeFileSync(fileOf(B), talk(B) + fork(A, B)) }],
  ]
  it.each(cases)('%s', (_name, setup) => {
    setup()
    writeSession(sessionJson([claude(A)]))
    const expected = displayed(A)
    clearContinuedMemo()
    rewriteRestoreRefs({ sessionDir })
    expect(JSON.parse(readSession()).workspaces[0].tabs[0].panes['1'].agent_session.value).toBe(expected)
  })
})

describe('planRestoreRewrite 합성 (순수)', () => {
  it('follow 가 같은 id·id 모양이 아닌 값을 주면 바꾸지 않는다', () => {
    const text = sessionJson([claude(A)])
    expect(planRestoreRewrite({ text, follow: () => A })).toEqual({ kind: 'same', refs: 1 })
    expect(planRestoreRewrite({ text, follow: () => '../x' })).toEqual({ kind: 'same', refs: 1 })
  })
  it('같은 옛 id 는 한 번만 판별한다', () => {
    const follow = vi.fn(() => B)
    planRestoreRewrite({ text: sessionJson([claude(A), claude(A)]), follow })
    expect(follow).toHaveBeenCalledTimes(1)
  })
})

describe('rewriteBeforeSpawn (C2 — 바인딩 경계·로그)', () => {
  const done: RestoreRewrite = { kind: 'unchanged', refs: 0 }
  it('바인딩 세션이면 고쳐 쓰기를 부르지 않는다', () => {
    const rewrite = vi.fn(() => done)
    const log = vi.fn()
    rewriteBeforeSpawn({ bound: 'l772', sessionDir: '/d', rewrite, log })
    expect(rewrite).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
  it('세션 디렉터리를 모르면 부르지 않고 로그 한 줄', () => {
    const rewrite = vi.fn(() => done)
    const log = vi.fn()
    rewriteBeforeSpawn({ bound: null, sessionDir: null, rewrite, log })
    expect(rewrite).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
  })
  it('그 외엔 그 디렉터리로 한 번 부르고 결과를 로그 한 줄로', () => {
    const rewrite = vi.fn((): RestoreRewrite => ({ kind: 'rewritten', refs: 2, moved: 1 }))
    const log = vi.fn()
    rewriteBeforeSpawn({ bound: null, sessionDir: '/d', rewrite, log })
    expect(rewrite).toHaveBeenCalledExactlyOnceWith('/d')
    expect(log).toHaveBeenCalledExactlyOnceWith('herdr.restore_rewrite', { kind: 'rewritten', refs: 2, moved: 1 })
  })
})
