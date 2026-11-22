// LIFE-834 fix1 G1 — 받아쓰기 넣기의 main 전달 경로. 고정 대상 pane 이 지금 붙은 탭에 없으면(같은 영역의 다른 탭·파일 탭) 기존 stream 길은
// herdr 가 조용히 버린다(S1 — `TerminalStreams.input` 은 쥔 연결이 없으면 `stream.input_blocked` 로 반환). 그 경우 guard `pane.send_text` 로 보내
// 막히지 않는다. 가짜 stream 은 실제와 같은 S1 가드를 흉내 낸다 — 붙지 않은 pane 의 input 은 버리고 버린 수를 센다.
import { describe, expect, it } from 'vitest'
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '../shared/terminal-paste.js'
import type { TerminalIdentity, TerminalOperation } from './adapter/index.js'
import { createDictationInserter, sendTextToPane } from './dictation.js'

function fakeStream(held: string[]) {
  const delivered: Array<{ paneId: string; data: string }> = []
  let blocked = 0
  return {
    held,
    delivered,
    blocked: () => blocked,
    heldPaneIds: () => [...held],
    // `TerminalStreams.input` 의 S1 가드와 같은 모양 — 어느 연결도 쥐지 않은 pane 이면 버린다
    input: (request: { paneId: string; data: string }) => {
      if (!held.includes(request.paneId)) {
        blocked += 1
        return
      }
      delivered.push(request)
    },
  }
}

function harness(held: string[], sendText?: (input: { paneId: string; text: string; signal: AbortSignal }) => Promise<void>) {
  const stream = fakeStream(held)
  const sent: Array<{ paneId: string; text: string }> = []
  const inserter = createDictationInserter({
    heldPaneIds: stream.heldPaneIds,
    paste: stream.input,
    sendText:
      sendText ??
      (async (input) => {
        sent.push({ paneId: input.paneId, text: input.text })
      }),
    log: () => undefined,
  })
  return { stream, sent, inserter }
}

const paste = (text: string): string => `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`

describe('G1 — 다른 탭이 붙은 상태에서 고정 pane 으로 보낸 받아쓰기 입력이 막히지 않는다', () => {
  it('고정 pane(p1)이 붙은 탭에 없고 다른 탭(p9)이 붙어 있다 → stream 으로 보내 버려지지 않고 pane.send_text 로 p1 에 간다', async () => {
    const h = harness(['p9'])
    const result = await h.inserter.insert({ sessionId: 's1', paneId: 'p1', text: '워크트리 목록을 보여주고' })
    expect(result).toEqual({ ok: true, via: 'send-text' })
    expect(h.sent).toEqual([{ paneId: 'p1', text: '워크트리 목록을 보여주고' }])
    expect(h.stream.blocked()).toBe(0)
    expect(h.stream.delivered).toEqual([])
  })
  it('고정 pane 이 붙은 탭에 있으면 ⌘V 와 같은 길 — 강제 bracketed paste 로 stream 에, send_text 는 안 쓴다', async () => {
    const h = harness(['p1', 'p2'])
    const result = await h.inserter.insert({ sessionId: 's1', paneId: 'p1', text: '리뷰 결과를 요약해줘.' })
    expect(result).toEqual({ ok: true, via: 'paste' })
    expect(h.stream.delivered).toEqual([{ paneId: 'p1', data: paste('리뷰 결과를 요약해줘.') }])
    expect(h.sent).toEqual([])
  })
  it('send_text 길은 Enter 가 될 수 있는 것을 뺀다 — 줄바꿈·탭은 공백, ESC·제어 문자는 버림, CR 을 덧붙이지 않는다', async () => {
    const h = harness([])
    await h.inserter.insert({ sessionId: 's1', paneId: 'p1', text: '첫 줄\r\n둘째\t줄\x1b[201~\x03끝' })
    expect(h.sent).toEqual([{ paneId: 'p1', text: '첫 줄 둘째 줄[201~끝' }])
    expect(h.sent[0]?.text.includes('\r')).toBe(false)
    expect(h.sent[0]?.text.includes('\n')).toBe(false)
  })
  it('탭을 오가는 동안에도 도착 순서대로 — 앞의 send_text 왕복이 끝나야 다음(붙은 길 포함)을 보낸다', async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const h = harness([], async (input) => {
      order.push(`send:${input.text}`)
      await new Promise<void>((resolve) => (release = resolve))
    })
    const first = h.inserter.insert({ sessionId: 's1', paneId: 'p1', text: '하나' })
    // 길은 넣는 순간에 정한다 — 첫 넣기가 send_text 로 떠난 뒤 사용자가 원래 탭으로 돌아왔다
    for (let index = 0; index < 10 && order.length === 0; index++) await Promise.resolve()
    expect(order).toEqual(['send:하나'])
    h.stream.held.push('p1')
    const second = h.inserter.insert({ sessionId: 's1', paneId: 'p1', text: '둘' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.stream.delivered).toEqual([])
    release()
    await first
    await second
    order.push(...h.stream.delivered.map((item) => `paste:${item.data}`))
    expect(order).toEqual(['send:하나', `paste:${paste('둘')}`])
  })
  it('보낼 길이 없으면(guard 거절·pane 없음) 조용히 버리지 않고 ok:false insert-failed — 다음 세션 넣기는 이어 간다', async () => {
    const h = harness(['p2'], async (input) => {
      if (input.text === '실패') throw new Error('pane 을 찾지 못했다 (p1)')
    })
    expect(await h.inserter.insert({ sessionId: 's1', paneId: 'p1', text: '실패' })).toEqual({ ok: false, code: 'insert-failed', message: 'pane 을 찾지 못했다 (p1)' })
    // 큐는 막히지 않는다 — 다음 세션은 넣는다. 같은 세션의 남은 항목은 버린다(fix2 — 실패 알림 세션당 한 번)
    expect(await h.inserter.insert({ sessionId: 's2', paneId: 'p2', text: '다음' })).toEqual({ ok: true, via: 'paste' })
    expect(await h.inserter.insert({ sessionId: 's1', paneId: 'p2', text: '같은 세션' })).toEqual({ ok: false, code: 'skipped', message: '' })
  })
})

describe('sendTextToPane — guard pane.send_text 봉투', () => {
  const identity = (paneId: string): TerminalIdentity => ({ epoch: 'e1', ptyId: `t-${paneId}.1`, paneId, tabId: 'tab', workspaceId: 'ws', path: '/w', repo: '/r', title: '' })
  it('지금 epoch 목록에서 그 pane 을 찾아 보낸다', async () => {
    const calls: Array<{ target: TerminalIdentity; text: string; ctx: TerminalOperation }> = []
    const backend = {
      epoch: async () => 'e1',
      list: async () => [identity('p0'), identity('p1')],
      send: async (target: TerminalIdentity, text: string, ctx: TerminalOperation) => {
        calls.push({ target, text, ctx })
      },
    }
    await sendTextToPane({ backend, paneId: 'p1', text: '글', deadlineMs: 5000, signal: new AbortController().signal })
    expect(calls.map((call) => [call.target.paneId, call.text])).toEqual([['p1', '글']])
    expect(calls[0]?.ctx.deadlineAt).toBeGreaterThan(Date.now())
  })
  it('목록에 없으면 던진다(보내지 않는다)', async () => {
    let sent = 0
    const backend = {
      epoch: async () => 'e1',
      list: async () => [identity('p0')],
      send: async () => {
        sent += 1
      },
    }
    await expect(sendTextToPane({ backend, paneId: 'p1', text: '글', deadlineMs: 5000, signal: new AbortController().signal })).rejects.toThrow('pane 을 찾지 못했다')
    expect(sent).toBe(0)
  })
})
