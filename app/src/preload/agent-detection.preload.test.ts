// @vitest-environment happy-dom
// LIFE-520 fix2 R2-02 — preload 가 부르는 채널 이름이 main 이 등록하는 이름과 같다. electron 을 가짜로 바꿔 preload 를 실제로 적재하고,
// 노출된 `getAgentDetection`·`refreshAgentDetection`·`onAgentDetection` 이 쓰는 채널을 공유 상수와 대조한다. main 이 같은 상수를 등록한다는 단언은
// `main/agent-detection.test.ts` 「main 이 등록하는 채널」(preload 프로젝트는 main 을 import 하지 않는다 — tsconfig.preload).
import { describe, expect, it, vi } from 'vitest'

const invoked: string[] = []
const listened: string[] = []
let exposed: Record<string, unknown> = {}

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: Record<string, unknown>) => { exposed = api } },
  ipcRenderer: {
    invoke: (channel: string) => { invoked.push(channel); return Promise.resolve(null) },
    on: (channel: string) => { listened.push(channel) },
    removeListener: () => {},
    send: () => {},
    sendSync: () => null,
  },
  webUtils: { getPathForFile: () => '' },
}))

describe('preload ↔ main 채널 이름 (K3ⓑ, R2-02)', () => {
  it('invoke 두 채널은 공유 상수(= main 등록 채널)와 같고, 푸시 채널은 main 이 보내는 상수와 같다', async () => {
    await import('./index.js')
    const { AGENT_DETECTION_CHANNEL } = await import('../shared/agent-detection.js')
    const call = (name: string): void => {
      const fn = exposed[name]
      if (typeof fn !== 'function') throw new Error(`${name} 이 노출되지 않았다`)
      fn(() => {})
    }
    call('getAgentDetection')
    call('refreshAgentDetection')
    call('onAgentDetection')
    expect(invoked).toEqual([AGENT_DETECTION_CHANNEL.get, AGENT_DETECTION_CHANNEL.refresh])
    expect(invoked).toEqual(['corral:agentDetectionGet', 'corral:agentDetectionRefresh'])
    expect(listened).toEqual([AGENT_DETECTION_CHANNEL.push])
  })
})
