// LIFE-582 R1-A13 — 쓰기용 기록 해소는 유일한 후보만. 합성 HOME(실제 사용자 기록 무접촉). 표시용 첫 일치(`resolveTranscriptFile`)는 그대로다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionRef } from '../shared/types.js'
import { resolveTranscriptFile, resolveTranscriptUnique } from './transcript.js'

const home = process.env.HOME
const roots: string[] = []
afterEach(() => {
  process.env.HOME = home
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

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
