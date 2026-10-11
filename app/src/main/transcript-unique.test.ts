// LIFE-582 R1-A13 — 쓰기용 기록 해소는 유일한 후보만. 합성 HOME(실제 사용자 기록 무접촉). 표시용 첫 일치(`resolveTranscriptFile`)는 그대로다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRef } from '../shared/types.js'
import { resolveTranscriptFile, resolveTranscriptUnique } from './transcript.js'

const home = process.env.HOME
const roots: string[] = []
/** 시험이 막은 폴더 — 지우기 전에 권한을 되돌린다. */
const locked: string[] = []
afterEach(() => {
  process.env.HOME = home
  for (const dir of locked.splice(0)) fs.chmodSync(dir, 0o755)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function lock(dir: string): void {
  fs.chmodSync(dir, 0o000)
  locked.push(dir)
}

function fakeHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l582u-'))
  roots.push(root)
  process.env.HOME = root
  return root
}

const ref: AgentSessionRef = { agent: 'claude', kind: 'id', source: 'test', id: 'sess-0001' }
function claudeFile(root: string, project: string): string {
  const dir = path.join(root, '.claude', 'projects', project)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'sess-0001.jsonl')
  fs.writeFileSync(file, '{}\n')
  return file
}

describe('resolveTranscriptUnique', () => {
  it('후보 하나 = found · 둘 = ambiguous(표시용은 여전히 첫 일치)', () => {
    const root = fakeHome()
    const first = claudeFile(root, '-a')
    expect(resolveTranscriptUnique(ref)).toEqual({ kind: 'found', file: first })
    claudeFile(root, '-b')
    expect(resolveTranscriptUnique(ref)).toEqual({ kind: 'ambiguous', count: 2 })
    expect(resolveTranscriptFile(ref)).not.toBeNull()
  })
  it('훑기 성공 0건 = none · 폴더를 못 읽음 = error', () => {
    const root = fakeHome()
    expect(resolveTranscriptUnique(ref)).toEqual({ kind: 'error' })
    fs.mkdirSync(path.join(root, '.claude', 'projects'), { recursive: true })
    expect(resolveTranscriptUnique(ref)).toEqual({ kind: 'none' })
  })
})

describe('R2-A5 후보 탐색의 읽기 오류는 found·none 이 아니다', () => {
  it('Claude — 두 후보 중 하나의 폴더를 못 읽으면 found 가 아니라 error · 못 읽는 후보만 있으면 none 이 아니라 error', () => {
    const root = fakeHome()
    claudeFile(root, '-a')
    const second = claudeFile(root, '-b')
    lock(path.dirname(second))
    expect(resolveTranscriptUnique(ref)).toEqual({ kind: 'error' })
    fs.rmSync(path.join(root, '.claude', 'projects', '-a'), { recursive: true })
    expect(resolveTranscriptUnique(ref)).toEqual({ kind: 'error' })
  })
  it('Grok — 같은 규칙', () => {
    const root = fakeHome()
    const grokRef: AgentSessionRef = { agent: 'grok', kind: 'id', source: 'test', id: 'g-0001' }
    for (const cwd of ['a', 'b']) {
      const dir = path.join(root, '.grok', 'sessions', cwd, 'g-0001')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), '{}\n')
    }
    lock(path.join(root, '.grok', 'sessions', 'b'))
    expect(resolveTranscriptUnique(grokRef)).toEqual({ kind: 'error' })
  })
  it('Codex — 날짜 폴더 하나를 못 읽으면 error', () => {
    const root = fakeHome()
    const codexRef: AgentSessionRef = { agent: 'codex', kind: 'id', source: 'test', id: 'c-0001' }
    for (const day of ['01', '02']) {
      const dir = path.join(root, '.codex', 'sessions', '2026', '10', day)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `rollout-x-c-0001.jsonl`), '{}\n')
    }
    lock(path.join(root, '.codex', 'sessions', '2026', '10', '02'))
    expect(resolveTranscriptUnique(codexRef)).toEqual({ kind: 'error' })
  })
  it('경로 참조 — 못 읽는 경로는 none 이 아니라 error · 대조: 없는 경로는 none', () => {
    const root = fakeHome()
    const dir = path.join(root, 'records')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'r.jsonl'), '{}\n')
    const pathRef = (file: string): AgentSessionRef => ({ agent: 'claude', kind: 'path', source: 'test', path: file })
    expect(resolveTranscriptUnique(pathRef(path.join(dir, 'missing.jsonl')))).toEqual({ kind: 'none' })
    lock(dir)
    expect(resolveTranscriptUnique(pathRef(path.join(dir, 'r.jsonl')))).toEqual({ kind: 'error' })
  })
})
