// LIFE-603 R1-H ④ 자기점검 — 같은 상태는 같다(순서·시각 무시), 링크·예외·활동 하나만 바뀌어도 다르다(판별력), 손상·없음은 같음으로 읽지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const run = (args) => spawnSync(process.execPath, [path.join(here, 'snapshot.mjs'), ...args], { encoding: 'utf8' })
const LINK = { sourceId: 'mock-jira', connectionId: 'c', itemId: 'm-2', key: 'CORE-2', linkedAt: 1 }

function profile(name, { registry, activity, pending }) {
  const root = `/tmp/l603g-ck${name}${process.pid}`
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'ud'), { recursive: true })
  if (registry !== undefined) fs.writeFileSync(path.join(root, 'ud', 'repos.json'), typeof registry === 'string' ? registry : JSON.stringify(registry))
  if (activity !== undefined) fs.writeFileSync(path.join(root, 'ud', 'work-activity.json'), JSON.stringify(activity))
  if (pending !== undefined) fs.writeFileSync(path.join(root, 'ud', 'work-start-pending.json'), JSON.stringify(pending))
  return root
}
const base = () => ({
  registry: { version: 2, repos: [], worktrees: { '/r/a': { workLink: LINK }, '/r/b': { workLinkSuppressed: true }, '/r/c': { comment: 'x' } } },
  activity: { version: 1, records: [{ id: '1', at: 5, eventKey: 'run:start:x', change: { field: 'run', event: 'start' } }, { id: '2', at: 6, change: { field: 'title' } }], seen: ['run:start:x'] },
  pending: { version: 1, entries: [] },
})

test('같음 · 다름 · 실패', () => {
  const roots = []
  try {
    const take = (name, state) => { const root = profile(name, state); roots.push(root); const out = `${root}/snap.json`; assert.equal(run(['take', root, out]).status, 0); return out }
    const a = take('a', base())
    const shuffled = base(); shuffled.activity.records.reverse(); shuffled.activity.records[0].at = 99; shuffled.activity.records[1].id = 'other'
    assert.equal(run(['diff', a, take('b', shuffled)]).status, 0)
    const unlinked = base(); delete unlinked.registry.worktrees['/r/a'].workLink
    const r1 = run(['diff', a, take('c', unlinked)])
    assert.equal(r1.status, 1)
    assert.equal(JSON.parse(r1.stdout).changes[0].key, '/r/a')
    const unsuppressed = base(); unsuppressed.registry.worktrees['/r/b'] = {}
    assert.equal(run(['diff', a, take('d', unsuppressed)]).status, 1)
    const lostEvent = base(); lostEvent.activity.records = lostEvent.activity.records.slice(1)
    assert.equal(run(['diff', a, take('e', lostEvent)]).status, 1)
    const noPending = base(); delete noPending.pending
    assert.equal(run(['diff', a, take('f', noPending)]).status, 1)
    const broken = profile('g', { ...base(), registry: '{not json' }); roots.push(broken)
    assert.equal(run(['take', broken, `${broken}/snap.json`]).status, 2)
    assert.equal(run(['take', '/Users/x', '/tmp/l603w/x.json']).status, 2)
    assert.equal(run(['diff', a, '/tmp/l603g-none/none.json']).status, 2)
  } finally { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) }
})
