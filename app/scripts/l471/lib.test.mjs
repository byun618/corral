// LIFE-471 r2 F-B — G8 세는 프록시의 계수기는 청크가 어디서 끊겨도 같은 수를 센다(완결 메시지 단위).
// control = JSON-RPC 줄, endpoint = 길이 접두 프레임(u32 LE + 본문).
import { describe, expect, it } from 'vitest'
import { makeCounter } from './lib.mjs'

const LINE = '{"id":"1","method":"pane.focus","params":{"pane_id":"p1"}}\n'
/** endpoint 프레임 — 본문에 이름이 ASCII 그대로 실리고 뒤에 이진 바이트가 이어진다(개행 없음). */
const frame = (name) => {
  const body = Buffer.concat([Buffer.from([7, 0, name.length]), Buffer.from(name, 'latin1'), Buffer.from([2, 0, 0, 0, 9])])
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}
/** 바이트를 주어진 위치들에서 잘라 청크로 먹이고 센 값을 돌려준다. */
function countSplit(mode, bytes, cuts) {
  const counter = makeCounter()
  const state = counter.newState(mode)
  let from = 0
  for (const cut of [...cuts, bytes.length]) {
    counter.feed(state, bytes.subarray(from, cut))
    from = cut
  }
  return counter.counts
}
const afterName = (bytes, name) => bytes.indexOf(name) + name.length
const PANE = { 'pane.focus': 1, 'tab.focus': 0 }

describe('r2 F-B 계수기 청크 경계 — control(JSON 줄)', () => {
  const bytes = Buffer.from(LINE, 'latin1')
  it('한 덩어리 — 1건', () => {
    expect(countSplit('line', bytes, [])).toEqual(PANE)
  })
  it('메서드 이름 바로 뒤에서 끊김 — 1건(리뷰 재현: 0건으로 빠지던 것)', () => {
    expect(countSplit('line', bytes, [afterName(bytes, 'pane.focus')])).toEqual(PANE)
    const tab = Buffer.from(LINE.replace('pane.focus', 'tab.focus'), 'latin1')
    expect(countSplit('line', tab, [afterName(tab, 'tab.focus')])).toEqual({ 'pane.focus': 0, 'tab.focus': 1 })
  })
  it('메서드 이름 한가운데서 끊김 — 1건', () => {
    expect(countSplit('line', bytes, [bytes.indexOf('pane.focus') + 4])).toEqual(PANE)
  })
  it('모든 위치에서 끊어도 같고, 여러 줄·긴 이름(pane.focus_direction)은 거른다', () => {
    const text = Buffer.from(LINE + LINE.replace('pane.focus', 'pane.focus_direction') + LINE.replace('pane.focus', 'tab.focus'), 'latin1')
    for (let cut = 0; cut <= text.length; cut += 1) expect(countSplit('line', text, [cut])).toEqual({ 'pane.focus': 1, 'tab.focus': 1 })
  })
})

describe('r2 F-B 계수기 청크 경계 — endpoint(길이 접두 프레임, 개행 없음)', () => {
  const bytes = frame('pane.focus')
  it('한 덩어리 — 1건', () => {
    expect(countSplit('frame', bytes, [])).toEqual(PANE)
  })
  it('메서드 이름 바로 뒤에서 끊김 — 1건', () => {
    expect(countSplit('frame', bytes, [afterName(bytes, 'pane.focus')])).toEqual(PANE)
  })
  it('메서드 이름 한가운데서 끊김 · 길이 머리 안에서 끊김 — 1건', () => {
    expect(countSplit('frame', bytes, [bytes.indexOf('pane.focus') + 4])).toEqual(PANE)
    expect(countSplit('frame', bytes, [2])).toEqual(PANE)
  })
  it('여러 프레임을 모든 위치에서 끊어도 같고, 긴 이름은 거른다', () => {
    const all = Buffer.concat([frame('pane.focus'), frame('pane.focus_direction'), frame('tab.focus')])
    for (let cut = 0; cut <= all.length; cut += 1) expect(countSplit('frame', all, [cut])).toEqual({ 'pane.focus': 1, 'tab.focus': 1 })
  })
})

describe('끝나지 않은 마지막 메시지', () => {
  it('flush 에서 센다', () => {
    const counter = makeCounter()
    const state = counter.newState('line')
    counter.feed(state, Buffer.from('{"method":"tab.focus"}', 'latin1'))
    expect(counter.counts['tab.focus']).toBe(0)
    counter.flush(state)
    expect(counter.counts['tab.focus']).toBe(1)
  })
})
