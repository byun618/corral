// LIFE-580 R3-A2 — (vitest, .mjs: 앱 tsconfig 가 mobile 소스를 품지 않아 타입검사 밖에 둔다) 네이티브 J5 계산기를 **실제 ListFeed(main) → 실제 폰 ListStore·ConnectionLog → computeNativeJ5** 로 잇는다(가짜 시계).
// 리뷰어 재현(`raw/review/codex-r3-raw/review-native-correlation.test.ts`)의 모양: 대상 p6 의 상태는 원인 +4000 ms 에 바뀌고, 그 사이 다른 p5 만
// +100 ms 에 바뀐다. 계산기는 p5 목록이 아니라 p6 이 기대 상태로 바뀐 목록을 골라야 한다. 실폰·실제 지연 측정이 아니다.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ListFeed } from '../../src/main/mobile/feed'
import { FIXTURE_NOW, listFixture } from '../../src/main/mobile/list-fixture'
import { computeNativeJ5 } from './native-j5.mjs'

// 폰 코어는 경로를 값으로 불러온다 — 글자 그대로 import 하면 앱 tsc 가 mobile 소스까지 프로그램에 넣어 TS6307 로 실패한다(앱 tsconfig 밖).
const mobileCore = (name) => import(new URL(`../../../mobile/src/core/${name}.ts`, import.meta.url).pathname)
const { ConnectionLog } = await mobileCore('log')
const { ListStore } = await mobileCore('list-store')
const { UnreadLedger } = await mobileCore('unread')

function rig() {
  vi.useFakeTimers()
  vi.setSystemTime(FIXTURE_NOW)
  const log = new ConnectionLog(() => Date.now())
  let listener = null
  const connection = {
    onSession: (fn) => {
      listener = fn
      return () => undefined
    },
    liveAttempt: () => 1,
    send: () => true,
    clockSample: () => ({ offsetMs: 0, rttMs: 0, at: Date.now(), pingId: 1, sentAt: Date.now(), recvAt: Date.now(), serverAt: Date.now() }),
  }
  const store = new ListStore({ connection, log, ledger: new UnreadLedger({ store: { load: () => null, save: () => undefined }, now: () => Date.now() }), now: () => Date.now(), timer: { setTimeout, clearTimeout } })
  void store
  const status = { target: 'idle', other: 'working' }
  const fixture = () => listFixture({ p6: { agentStatus: status.target, digest: { turnOutcome: null } }, p5: { agentStatus: status.other } })
  let state = fixture()
  const feed = new ListFeed({ read: () => ({ state, prefs: null, now: Date.now() }), now: () => Date.now(), log: () => undefined, refreshMs: 1_000_000 })
  feed.subscribe((text) => listener?.({ kind: 'list', attempt: 1, message: JSON.parse(text) }))
  const change = (patch) => {
    Object.assign(status, patch)
    state = fixture()
    feed.changed()
  }
  return { log, feed, change }
}

/** 5전이: 원인 → (+100 다른 채널) → (+targetDelay 대상) → 다음 원인까지 8초 간격. */
function drive(input) {
  const { log, feed, change } = rig()
  vi.advanceTimersByTime(1_000)
  const causes = []
  for (let i = 0; i < 5; i += 1) {
    const expect = i % 2 === 0 ? 'working' : 'idle'
    const causeAt = Date.now()
    causes.push(JSON.stringify({ kind: 'cause', i, state: expect, target: 'p6', expect, pane: 'p6', causeAt, doneAt: causeAt + 20, exit: 0 }))
    if (input.otherFirst) {
      vi.advanceTimersByTime(100)
      change({ other: i % 2 === 0 ? 'idle' : 'working' })
      vi.advanceTimersByTime(input.targetDelay - 100)
    } else vi.advanceTimersByTime(input.targetDelay)
    change({ target: expect })
    vi.advanceTimersByTime(8_000 - input.targetDelay)
  }
  feed.stop()
  return computeNativeJ5({ phoneText: log.text(), causeText: causes.join('\n') })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('R3-A2 실제 feed → 폰 기록 → 계산기 — 대상 채널 전이만 짝', () => {
  it('다른 채널이 먼저 바뀌고 대상은 4초 뒤 — 4.1초로 계산해 미달(이전 계산기는 0.2초 통과)', () => {
    const result = drive({ targetDelay: 4_000, otherFirst: true })
    expect(result.counted).toBe(5)
    // 판정 먼저 — 이전 계산기는 여기서 0.2초·통과로 갈린다.
    expect(result.rows.map((row) => row.bMs >= 4_000)).toEqual([true, true, true, true, true])
    expect(result.verdict).toBe('미달')
    expect(result.rows.map((row) => row.dot)).toEqual(['working', expect.stringMatching(/^(idle|done)$/), 'working', expect.stringMatching(/^(idle|done)$/), 'working'])
  })

  it('양성 대조 — 같은 잡음에서 대상이 0.3초 뒤 바뀌면 통과(대상 목록의 seq)', () => {
    const result = drive({ targetDelay: 300, otherFirst: true })
    expect(result.counted).toBe(5)
    for (const row of result.rows) expect(row.bMs).toBeLessThan(1_000)
    expect(result.verdict).toBe('통과')
  })

  it('폰 기록의 `changes` 가 다른 채널만 바뀐 목록과 대상 목록을 가른다', () => {
    const { log, feed, change } = rig()
    vi.advanceTimersByTime(1_000)
    change({ other: 'idle' })
    vi.advanceTimersByTime(1_000)
    change({ target: 'working' })
    vi.advanceTimersByTime(1_000)
    feed.stop()
    const changes = log.list().filter((entry) => entry.event === 'list_recv').map((entry) => entry.detail.changes)
    expect(changes.slice(1)).toEqual(['p5=idle', 'p6=working'])
  })
})
