// @vitest-environment happy-dom
// LIFE-600 E — 설정 › 작업 연결. 가짜 preload 로 화면이 main 상태를 그대로 그리는지 본다(분기·저장 규칙은 main 쪽 테스트가 본다).
// 출처 id 는 일부러 중립 이름(`src-a`)을 쓴다 — 화면은 출처를 모르고 main 이 준 표시 정보만 그린다(C4).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { WorkActionResult, WorkConnectionAddInput, WorkConnectionAddResult, WorkConnectionSummary, WorkSettingsState } from '../../../shared/work.js'
import { ConnectionsSection } from './ConnectionsSection.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const SOURCE = { id: 'src-a', name: 'Source A', mono: 'SA', addLabel: '+ A 토큰', formTitle: 'A 연결', tokenLabel: 'A 토큰', tokenPrefix: 'a_pat_' }
const CONNECTION: WorkConnectionSummary = {
  id: 'c1', sourceId: 'src-a', name: 'Source A', mono: 'SA', tokenTail: 'wxyz', addedAt: Date.UTC(2026, 9, 8), generation: 0, status: 'ok', pending: null, error: null,
  checkedAt: Date.now(), hiddenSpaceKeys: ['s2'], capabilities: null,
  spaces: [
    { key: 's1', name: 'corral', color: null, openCount: 14, hidden: false },
    { key: 's2', name: '숨긴 스페이스', color: '#123456', openCount: 0, hidden: true },
  ],
}

let host: HTMLDivElement
let root: Root
let state: WorkSettingsState
let listeners: Array<(next: WorkSettingsState) => void>
const added: WorkConnectionAddInput[] = []
const tested: string[] = []
const hidden: Array<{ spaceKey: string; hidden: boolean }> = []
const defaults: Array<{ repoRoot: string; target: { connectionId: string; spaceKey: string } | null }> = []
let addResult: WorkConnectionAddResult
let testResult: WorkActionResult
let testGate: Promise<void>
let defaultResult: WorkActionResult

function push(next: WorkSettingsState): void {
  state = next
  act(() => { for (const listener of listeners) listener(next) })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  state = { sources: [SOURCE], connections: [CONNECTION], repoDefaults: [{ repoRoot: '/r/corral', connectionId: 'c1', spaceKey: 's1' }] }
  listeners = []
  for (const list of [added, tested, hidden, defaults]) list.length = 0
  addResult = { ok: true, connection: CONNECTION }
  const ok: WorkActionResult = { ok: true }
  testResult = ok
  testGate = Promise.resolve()
  defaultResult = ok
  Reflect.set(window, 'corral', {
    getWorkSettings: async () => state,
    onWorkSettings: (listener: (next: WorkSettingsState) => void) => { listeners.push(listener); return () => {} },
    addWorkConnection: async (input: WorkConnectionAddInput) => { added.push(input); return addResult },
    testWorkConnection: async (input: { connectionId: string }) => { tested.push(input.connectionId); await testGate; return testResult },
    removeWorkConnection: async () => ok,
    setWorkSpaceHidden: async (input: { spaceKey: string; hidden: boolean }) => { hidden.push({ spaceKey: input.spaceKey, hidden: input.hidden }); return ok },
    setRepoDefaultSpace: async (input: { repoRoot: string; target: { connectionId: string; spaceKey: string } | null }) => { defaults.push(input); return defaultResult },
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'corral')
})

async function mount(): Promise<void> {
  await act(async () => { root.render(createElement(ConnectionsSection, { repos: [{ root: '/r/corral', name: 'corral' }, { root: '/r/other', name: 'other' }] })) })
}
function q(selector: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(selector)
  if (found === null) throw new Error(`${selector} 없음`)
  return found
}
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('연결 카드 — main 이 준 이름·글자·끝 4자, 상태 pill, 스페이스 행', async () => {
  await mount()
  expect(q('[data-connection-add="src-a"]').textContent).toBe('+ A 토큰')
  const card = q('[data-connection-card="c1"]')
  expect(card.textContent).toContain('Source A')
  expect(card.textContent).toContain('••••wxyz')
  expect(q('[data-connection-status]').getAttribute('data-connection-status')).toBe('ok')
  expect([...host.querySelectorAll('[data-space-row]')].map((row) => row.getAttribute('data-space-row'))).toEqual(['s1', 's2'])
  expect(host.querySelector('[data-connection-error]')).toBeNull()
})

it('마지막 켜진 스페이스는 잠김 + 이유, 꺼진 스페이스는 켤 수 있다', async () => {
  await mount()
  const locked = q('[data-space-row="s1"] [data-space-locked]')
  expect(locked.getAttribute('title')).toContain('마지막 스페이스')
  expect(q('[data-space-row="s1"] [role="switch"]').hasAttribute('disabled')).toBe(true)
  await act(async () => { q('[data-space-row="s2"] [role="switch"]').click() })
  expect(hidden).toEqual([{ spaceKey: 's2', hidden: false }])
})

it('토큰 추가 — 접두사가 틀리면 보내지 않고, 맞으면 sourceId 와 함께 보낸다', async () => {
  await mount()
  act(() => q('[data-connection-add="src-a"]').click())
  expect(q('[data-connection-form]').getAttribute('data-connection-form')).toBe('src-a')
  const input = host.querySelector<HTMLInputElement>('[data-connection-token]')
  if (input === null) throw new Error('input')
  expect(input.type).toBe('password')
  type(input, 'wrong_token')
  expect(q('[data-connection-form-error="prefix"]').textContent).toContain('a_pat_')
  expect(q('[data-connection-save]').hasAttribute('disabled')).toBe(true)
  type(input, '  a_pat_fake0000  ')
  await act(async () => { q('[data-connection-save]').click() })
  expect(added).toEqual([{ sourceId: 'src-a', token: 'a_pat_fake0000', replaceId: null }])
  expect(host.querySelector('[data-connection-form]')).toBeNull()
})

it('추가 실패 — 오류를 폼에 보이고 폼을 유지한다', async () => {
  addResult = { ok: false, error: { kind: 'auth', message: '토큰을 거부했습니다 (401)', status: 401 } }
  await mount()
  act(() => q('[data-connection-add="src-a"]').click())
  const input = host.querySelector<HTMLInputElement>('[data-connection-token]')
  if (input === null) throw new Error('input')
  type(input, 'a_pat_fake0000')
  await act(async () => { q('[data-connection-save]').click() })
  expect(q('[data-connection-form-error="auth"]').textContent).toContain('401')
})

it('오류 상태 — 인증 실패는 「토큰 다시 붙여넣기」 로 같은 연결의 교체 폼을 연다 · 네트워크는 다시 시도', async () => {
  await mount()
  push({ ...state, connections: [{ ...CONNECTION, status: 'auth', error: { message: '거부됨 (401)', action: 'replace_token' } }] })
  expect(q('[data-connection-error]').getAttribute('data-connection-error')).toBe('auth')
  act(() => { [...host.querySelectorAll<HTMLButtonElement>('[data-connection-error] button')][0]?.click() })
  expect(q('[data-connection-form]').textContent).toContain('토큰 바꾸기')
  push({ ...state, connections: [{ ...CONNECTION, status: 'offline', error: { message: '닿지 않습니다', action: 'retry' } }] })
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[data-connection-error] button')][0]?.click() })
  expect(tested).toContain('c1')
})

it('키체인 대기 — 이유를 먼저 보인다 · 아직 안 읽은 연결은 화면이 열릴 때 한 번 테스트', async () => {
  state = { ...state, connections: [{ ...CONNECTION, status: 'unchecked', spaces: null }] }
  await mount()
  expect(tested).toEqual(['c1'])
  push({ ...state, connections: [{ ...CONNECTION, status: 'testing', pending: 'keychain', spaces: null }] })
  expect(q('[data-connection-pending="keychain"]').textContent).toContain('키체인')
  expect(q('[data-connection-status]').getAttribute('data-connection-status')).toBe('testing')
  push({ ...state, connections: [{ ...CONNECTION, status: 'unchecked', spaces: null }] })
  expect(tested).toEqual(['c1'])
})

it('레포 ↔ 기본 스페이스 — 지정된 스페이스 이름, 메뉴는 보이는 스페이스만', async () => {
  await mount()
  const row = q('[data-repo-default-space="corral"]')
  expect(row.textContent).toContain('corral')
  expect(q('[data-repo-default-space="other"]').textContent).toContain('지정 안 함')
  act(() => row.querySelector<HTMLButtonElement>('button')?.click())
  const options = [...row.querySelectorAll('[role="menuitem"]')].map((option) => option.textContent ?? '')
  expect(options.some((text) => text.includes('숨긴 스페이스'))).toBe(false)
  await act(async () => { [...row.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][1]?.click() })
  expect(defaults).toEqual([{ repoRoot: '/r/corral', target: { connectionId: 'c1', spaceKey: 's1' } }])
})

it('[R2-E] 누른 연결 테스트의 실패 — 연결 상태로 남지 않는 응답 어긋남도 카드에 보이고, 다시 성공하면 지운다', async () => {
  testResult = { ok: false, error: { kind: 'invalid_response', status: null, message: '응답 모양이 어긋났습니다' } }
  await mount()
  await act(async () => { q('[data-connection-test]').click() })
  expect(q('[data-connection-status]').getAttribute('data-connection-status')).toBe('ok')
  expect(q('[data-connection-test-error="invalid_response"]').textContent).toContain('응답 모양이 어긋났습니다')
  testResult = { ok: true }
  await act(async () => { q('[data-connection-test]').click() })
  expect(host.querySelector('[data-connection-test-error]')).toBeNull()
})

it('[R2-E] 레포 기본 저장 실패 — 실패 문구를 그 줄에 보인다', async () => {
  defaultResult = { ok: false, error: { kind: 'local_write', status: null, message: '저장하지 못했습니다 (EACCES)' } }
  await mount()
  const row = q('[data-repo-default-space="corral"]')
  act(() => row.querySelector<HTMLButtonElement>('button')?.click())
  await act(async () => { [...row.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][0]?.click() })
  expect(q('[data-repo-default-error]').textContent).toContain('EACCES')
})

function withConnection(patch: Partial<WorkConnectionSummary>): WorkSettingsState {
  return { ...state, connections: [{ ...CONNECTION, ...patch }] }
}

it('[R3-C] old-test-error-persists-after-successful-token-replacement — 옛 토큰 테스트의 auth 실패는 교체 성공(세대 오름) 뒤 보이지 않는다', async () => {
  testResult = { ok: false, error: { kind: 'auth', status: 401, message: '토큰이 만료됐거나 폐기됐습니다' } }
  await mount()
  await act(async () => { q('[data-connection-test]').click() })
  push(withConnection({ status: 'auth', error: { message: '토큰이 만료됐거나 폐기됐습니다', action: 'replace_token' } }))
  expect(host.querySelector('[data-connection-test-error]')).toBeNull()
  // 토큰 교체 성공 — 같은 connection.id, 세대 1, 새 끝 4자, 오류 없음.
  push(withConnection({ generation: 1, tokenTail: 'new4', status: 'ok', error: null }))
  expect(q('[data-connection-status]').getAttribute('data-connection-status')).toBe('ok')
  expect(host.textContent).toContain('new4')
  expect(host.querySelector('[data-connection-test-error]')).toBeNull()
  expect(host.textContent).not.toContain('만료')
})

it('[R3-C] 같은 세대의 invalid_response 줄은 상태 push 가 와도 남는다(R2-E 유지)', async () => {
  testResult = { ok: false, error: { kind: 'invalid_response', status: null, message: '응답 모양이 어긋났습니다' } }
  await mount()
  await act(async () => { q('[data-connection-test]').click() })
  push(withConnection({ checkedAt: Date.now() + 1000 }))
  expect(q('[data-connection-test-error="invalid_response"]').textContent).toContain('응답 모양이 어긋났습니다')
})

it('[R3-C] 교체 전에 누른 테스트가 교체 뒤 늦게 실패해도 새 세대 카드에 보이지 않는다', async () => {
  let release = (): void => {}
  testGate = new Promise<void>((resolve) => { release = resolve })
  testResult = { ok: false, error: { kind: 'invalid_response', status: null, message: '옛 토큰 응답 어긋남' } }
  await mount()
  act(() => q('[data-connection-test]').click())
  push(withConnection({ generation: 1, tokenTail: 'new4' }))
  await act(async () => { release(); await testGate })
  expect(host.querySelector('[data-connection-test-error]')).toBeNull()
})
