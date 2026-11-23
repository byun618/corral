// @vitest-environment happy-dom
// LIFE-834 fix7 R6-1 — preload 의 `dictationPressKeys` 가 보내는 채널이 main 이 등록하는 공유 상수와 같다(agent-detection.preload.test 와 같은 수).
// main 이 같은 상수를 등록한다는 단언은 `main/dictation.test.ts` 「⌘M 가드 배선」.
import { describe, expect, it, vi } from 'vitest'

const sent: Array<{ channel: string; payload: unknown }> = []
let exposed: Record<string, unknown> = {}

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: Record<string, unknown>) => { exposed = api } },
  ipcRenderer: {
    invoke: () => Promise.resolve(null),
    on: () => {},
    removeListener: () => {},
    send: (channel: string, payload: unknown) => { sent.push({ channel, payload }) },
    sendSync: () => null,
  },
  webUtils: { getPathForFile: () => '' },
}))

describe('preload ↔ main 받아쓰기 누름 키 채널 (fix7 R6-1)', () => {
  it('dictationPressKeys 는 공유 상수(= main 등록 채널)로 키를 그대로 보낸다', async () => {
    await import('./index.js')
    const { DICTATION_PRESS_KEYS_CHANNEL } = await import('../shared/dictation.js')
    const send = exposed.dictationPressKeys
    if (typeof send !== 'function') throw new Error('dictationPressKeys 가 노출되지 않았다')
    const keys = { code: 'KeyM', meta: true, shift: true, control: false, alt: false }
    send(keys)
    expect(sent).toEqual([{ channel: DICTATION_PRESS_KEYS_CHANNEL, payload: keys }])
    expect(DICTATION_PRESS_KEYS_CHANNEL).toBe('corral:dictationPressKeys')
  })
})
