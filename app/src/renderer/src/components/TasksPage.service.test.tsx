// @vitest-environment happy-dom
// LIFE-601 수정 r1 R1-B — 키 검색이 실제 WorkService(모의 출처)의 상태 push 와 맞물려 반복 조회를 만들지 않는다.
// main 의 WorkService 를 그대로 띄워 preload 자리에 잇는다(성공 settle → emit → onWorkSettings → 새 settings 객체).
// 렌더러와 main 을 함께 import 하므로 web 타입 검사(tsconfig.web.json)에서 뺀다 — 같은 이유의 선례가 tsconfig.node.json 의 exclude 다.
// 타입은 vitest(esbuild)가 아니라 이 파일이 쓰는 main 공개 표면(WorkService.request·settings·addConnection)이 node 프로젝트에서 검사된다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkRequest, WorkResponse, WorkSettingsState } from '../../../shared/work.js'
import { mockSourceEntry, seedMockDemoState } from '../../../main/work/mock-source.js'
import { WorkService } from '../../../main/work/service.js'
import { WorkSourceRegistry } from '../../../main/work/source.js'
import { CredentialVault } from '../../../main/work/vault.js'
import { FakeCipher, MemoryStore } from '../../../main/work/test-kit.js'
import { TasksPageInPanel } from './TasksPage.harness.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let settingsListener: (value: WorkSettingsState) => void

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
async function renderPage({ open = true }: { open?: boolean } = {}): Promise<void> {
  act(() => root.render(createElement(TasksPageInPanel, { open, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} })))
  await settle()
}
const q = (selector: string): Element | null => host.querySelector(selector)
function type(value: string): void {
  const input = q('[data-tasks-search]')
  if (!(input instanceof HTMLInputElement)) throw new Error('검색 칸 없음')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('R1-B 키 검색 — 실제 WorkService 상태 push 까지 이어도 반복 조회가 없다', () => {
  it('키 한 번 입력 = 연결당 findByKey 1회, 성공 push 가 재조회를 부르지 않는다 · 닫힌 동안 push 에도 0', async () => {
    const service = new WorkService({
      store: new MemoryStore(), vault: new CredentialVault(new FakeCipher()), sources: new WorkSourceRegistry([mockSourceEntry({ state: seedMockDemoState() })]),
      repos: () => [], onChange: (state) => settingsListener(state), now: () => 1_791_800_000_000, newId: () => 'conn-1',
    })
    const pushes: number[] = []
    const finds: WorkRequest[] = []
    Reflect.set(window, 'corral', {
      getUiPrefs: async () => ({ tasksPage: undefined }),
      setUiPrefs: () => {},
      getWorkSettings: async () => service.settings(),
      onWorkSettings: (listener: (value: WorkSettingsState) => void) => { settingsListener = (value) => { pushes.push(1); listener(value) }; return () => {} },
      workRequest: (request: WorkRequest) => {
        if (request.call.op === 'findByKey') {
          finds.push(request)
          // 반복 조회가 있으면(수정 전) 20회에서 끊는다 — 끝없는 act 로 시험이 멈추지 않고 횟수로 실패하게.
          if (finds.length > 20) return new Promise<WorkResponse>(() => {})
        }
        return service.request(request)
      },
    })
    settingsListener = () => {}
    const added = await service.addConnection({ sourceId: 'mock-jira', token: 'mock_l601_fixture', replaceId: null })
    expect(added.ok).toBe(true)
    await renderPage()
    expect(q('[data-tasks-board] [data-issue-card]')).not.toBeNull()
    type('CORE-2')
    for (let round = 0; round < 10; round += 1) await settle()
    expect(pushes.length).toBeGreaterThan(0)
    expect(finds).toHaveLength(1)
    expect(q('[data-search-hit]')).not.toBeNull()
    await renderPage({ open: false })
    const before = finds.length
    for (let round = 0; round < 3; round += 1) await act(async () => { settingsListener(service.settings()) })
    await settle()
    expect(finds).toHaveLength(before)
  })
})
