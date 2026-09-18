import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_SESSION_DIGEST, type PaneRow, type WorkspaceRow } from '../shared/types.js'
vi.mock('./adapter/index.js', () => ({ readOpenWorkspaces: vi.fn() }))
import { attachDigests, collectSessionRefs } from './tree.js'
import { readSessionDigests } from './transcript.js'

function pane(id: string, sessionId: string | null): PaneRow {
  return { paneId: id, tabId: 't1', workspaceId: 'w1', title: id, agent: sessionId && 'claude',
    agentStatus: 'idle', cwd: null, focused: false, digest: EMPTY_SESSION_DIGEST,
    agentSession: sessionId ? { kind: 'id', agent: 'claude', source: 'herdr:claude', id: sessionId } : null }
}
function workspace(panes: PaneRow[]): WorkspaceRow {
  return { workspaceId: 'w1', label: 'repo', number: 1, focused: true, agentStatus: 'idle',
    tabs: [{ tabId: 't1', workspaceId: 'w1', label: '1', number: 1, order: 0, focused: true,
      agentStatus: 'idle', panes, digest: EMPTY_SESSION_DIGEST }] }
}

describe('pane digest attachment', () => {
  it('collects every pane reference and preserves first-session tab digest behavior', () => {
    const shell = pane('shell', null)
    const first = pane('p1', 'session-a')
    const second = pane('p2', 'session-b')
    const input = [workspace([shell, first, second])]
    expect([...collectSessionRefs(input)]).toEqual([
      ['shell', null], ['p1', first.agentSession], ['p2', second.agentSession],
    ])
    const a = { ...EMPTY_SESSION_DIGEST, providerTitle: 'A' }
    const b = { ...EMPTY_SESSION_DIGEST, providerTitle: 'B' }
    const result = attachDigests(input, new Map([['p1', a], ['p2', b]]))[0]!.tabs[0]!
    expect(result.digest).toBe(a)
    expect(result.panes.map((p) => p.digest)).toEqual([EMPTY_SESSION_DIGEST, a, b])
    expect(input[0]!.tabs[0]!.panes[1]!.digest).toBe(EMPTY_SESSION_DIGEST)
  })

  it('missing reads keep empty defaults; closing the first session promotes the next for the tab', () => {
    const remaining = pane('p2', 'session-b')
    const b = { ...EMPTY_SESSION_DIGEST, firstPrompt: 'B' }
    expect(attachDigests([workspace([remaining])], new Map([['p2', b]]))[0]!.tabs[0]!.digest).toBe(b)
    expect(attachDigests([workspace([remaining])], new Map())[0]!.tabs[0]!.panes[0]!.digest).toBe(EMPTY_SESSION_DIGEST)
  })
})

it('reads two different transcript files for two panes in one tab', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l387-pane-digests-'))
  try {
    const panes = ['a', 'b'].map((id, index) => {
      const file = path.join(dir, `${id}.jsonl`)
      const timestamp = new Date(100000 + index * 60000).toISOString()
      fs.writeFileSync(file, [
        { type: 'event_msg', timestamp, payload: { type: 'user_message', message: `prompt ${id}` } },
        { type: 'response_item', timestamp, payload: { role: 'assistant', content: [{ type: 'output_text', text: `answer ${id}` }] } },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n')
      const row = pane(id, null)
      row.agent = 'codex'
      row.agentSession = { kind: 'path', agent: 'codex', source: 'herdr:codex', path: file }
      return row
    })
    const input = [workspace(panes)]
    const reads = readSessionDigests(collectSessionRefs(input))
    const result = attachDigests(input, reads.digests)[0]!.tabs[0]!
    expect(result.panes.map((row) => row.digest.firstPrompt)).toEqual(['Prompt a', 'Prompt b'])
    expect(result.panes.map((row) => row.digest.activity)).toEqual([
      { state: 'text', text: 'answer a', at: 100000 },
      { state: 'text', text: 'answer b', at: 160000 },
    ])
    expect(result.panes.map((row) => row.digest.lastActivityAt)).toEqual([100000, 160000])
    expect(result.digest).toEqual(result.panes[0]!.digest)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
