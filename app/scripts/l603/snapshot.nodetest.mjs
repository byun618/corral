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
    const take = (name, state, extra = []) => { const root = profile(name, state); roots.push(root); const out = `${root}/snap.json`; assert.equal(run(['take', root, out, ...extra]).status, 0); return out }
    const a = take('a', base())
    const shuffled = base(); shuffled.activity.records.reverse(); shuffled.activity.records[0].at = 99; shuffled.activity.records[1].id = 'other'
    assert.equal(run(['diff', a, take('b', shuffled)]).status, 0)
    const unlinked = base(); delete unlinked.registry.worktrees['/r/a'].workLink
    const r1 = run(['diff', a, take('c', unlinked, ['--expect-links', '0'])])
    assert.equal(r1.status, 1)
    assert.equal(JSON.parse(r1.stdout).changes[0].key, '/r/a')
    const unsuppressed = base(); unsuppressed.registry.worktrees['/r/b'] = {}
    assert.equal(run(['diff', a, take('d', unsuppressed)]).status, 1)
    const lostEvent = base(); lostEvent.activity.records = lostEvent.activity.records.slice(1)
    assert.equal(run(['diff', a, take('e', lostEvent, ['--expect-events', '0'])]).status, 1)
    const noPending = base(); delete noPending.pending
    assert.equal(run(['diff', a, take('f', noPending)]).status, 1)
    const broken = profile('g', { ...base(), registry: '{not json' }); roots.push(broken)
    assert.equal(run(['take', broken, `${broken}/snap.json`]).status, 2)
    assert.equal(run(['take', '/Users/x', '/tmp/l603w/x.json']).status, 2)
    assert.equal(run(['diff', a, '/tmp/l603g-none/none.json']).status, 2)
  } finally { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) }
})

test('R2-L 둘 다 빈 스냅샷은 기본 기대값에서 실패(exit 3) · seen 은 집합으로 비교 · 쌍 형식도 읽는다', () => {
  const roots = []
  try {
    const empty = profile('h', { registry: { version: 2, repos: [], worktrees: {} } }); roots.push(empty)
    const thin = run(['take', empty, `${empty}/snap.json`])
    assert.equal(thin.status, 3)
    assert.equal(JSON.parse(thin.stdout).code, 'below_expected')
    assert.equal(run(['take', empty, `${empty}/snap0.json`, '--expect-links', '0', '--expect-events', '0']).status, 0)
    const withSeen = (seen) => { const state = base(); state.activity.seen = seen; return state }
    const one = profile('i', withSeen([['run:start:x', 'c'], ['agent:q:c:K:s:b:1', 'c']])); roots.push(one)
    const two = profile('j', withSeen([['run:start:x', 'c'], ['agent:q:c:K:s:b:2', 'c']])); roots.push(two)
    const legacy = profile('k', withSeen(['agent:q:c:K:s:b:1', 'run:start:x'])); roots.push(legacy)
    for (const root of [one, two, legacy]) assert.equal(run(['take', root, `${root}/snap.json`]).status, 0)
    const changed = run(['diff', `${one}/snap.json`, `${two}/snap.json`])
    assert.equal(changed.status, 1)
    assert.equal(JSON.parse(changed.stdout).changes[0].section, 'seen')
    // fix3 R3-D: 쌍 집합 — 연결 id 가 없는 옛 문자열은 연결 id null 이라 쌍과 다르다(같은 형식끼리만 같음).
    assert.equal(run(['diff', `${one}/snap.json`, `${legacy}/snap.json`]).status, 1)
  } finally { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) }
})

// --- fix3 R3-D -----------------------------------------------------------------------------------
test('R3-D --expect-* 값이 빠졌거나 정수가 아니면 exit 2 (리뷰 재현 claude-r3-raw/snap-nan2 — 고침 전: NaN 으로 빈 스냅샷 exit 0)', () => {
  const roots = []
  try {
    const empty = profile('n', { registry: { version: 2, repos: [], worktrees: {} } }); roots.push(empty)
    for (const extra of [['--expect-links'], ['--expect-links', 'abc'], ['--expect-events', '1.5'], ['--expect-links', '-1'], ['--expect-events', '']]) {
      const out = run(['take', empty, `${empty}/snap.json`, ...extra])
      assert.equal(out.status, 2, `${extra.join(' ')} → ${out.stdout}`)
      assert.equal(JSON.parse(out.stdout).code, 'bad_expect')
    }
    // 양성 대조: 정수면 받는다
    assert.equal(run(['take', empty, `${empty}/snap.json`, '--expect-links', '0', '--expect-events', '0']).status, 0)
    assert.equal(run(['take', empty, `${empty}/snap.json`, '--expect-links', '2']).status, 3)
  } finally { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) }
})

test('R3-D seen 은 [열쇠, 연결 id] 쌍으로 · 사건은 레코드 connectionId 까지 대조한다', () => {
  const roots = []
  try {
    const state = (patch) => { const value = base(); patch(value); return value }
    const take = (name, value) => { const root = profile(name, value); roots.push(root); assert.equal(run(['take', root, `${root}/snap.json`]).status, 0); return `${root}/snap.json` }
    const a = take('o', state((value) => { value.activity.seen = [['run:start:x', 'c']]; value.activity.records[0].connectionId = 'c' }))
    const sameAgain = take('p', state((value) => { value.activity.seen = [['run:start:x', 'c'], ['run:start:x', 'c']]; value.activity.records[0].connectionId = 'c' }))
    assert.equal(run(['diff', a, sameAgain]).status, 0)
    const owner = take('q', state((value) => { value.activity.seen = [['run:start:x', 'c2']]; value.activity.records[0].connectionId = 'c' }))
    const ownerDiff = run(['diff', a, owner])
    assert.equal(ownerDiff.status, 1)
    assert.deepEqual(JSON.parse(ownerDiff.stdout).changes.map((row) => row.section), ['seen'])
    const moved = take('r', state((value) => { value.activity.seen = [['run:start:x', 'c']]; value.activity.records[0].connectionId = 'c2' }))
    const movedDiff = run(['diff', a, moved])
    assert.equal(movedDiff.status, 1)
    assert.deepEqual(JSON.parse(movedDiff.stdout).changes.map((row) => [row.section, row.key]), [['events', 'run:start:x']])
  } finally { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) }
})
