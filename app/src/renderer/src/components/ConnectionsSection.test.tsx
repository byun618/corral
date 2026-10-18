// @vitest-environment happy-dom
// LIFE-600 E — 설정 › 작업 연결. 가짜 preload 로 화면이 main 상태를 그대로 그리는지 본다(분기·저장 규칙은 main 쪽 테스트가 본다).
// 출처 id 는 일부러 중립 이름(`src-a`)을 쓴다 — 화면은 출처를 모르고 main 이 준 표시 정보만 그린다(C4).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { WorkActionResult, WorkConnectionAddInput, WorkConnectionAddResult, WorkConnectionSummary, WorkSettingsState } from '../../../shared/work.js'
import { ConnectionsSection } from './ConnectionsSection.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const SOURCE = { id: 'src-a', name: 'Source A', mono: 'SA', addLabel: '+ A 토큰', formTitle: 'A 연결', tokenLabel: 'A 토큰', tokenPrefix: 'a_pat_', keyPattern: null, accountFields: [], tokenHint: null, queryPattern: null }
const CONNECTION: WorkConnectionSummary = { account: {}, 
  id: 'c1', sourceId: 'src-a', name: 'Source A', mono: 'SA', tokenTail: 'wxyz', addedAt: Date.UTC(2026, 9, 8), generation: 0, status: 'ok', pending: null, error: null,
  checkedAt: Date.now(), hiddenSpaceKeys: ['s2'], capabilities: null,
  spaces: [
    { capabilities: {}, key: 's1', name: 'corral', color: null, openCount: 14, hidden: false },
    { capabilities: {}, key: 's2', name: '숨긴 스페이스', color: '#123456', openCount: 0, hidden: true },
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
let addGate: Promise<void>
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
  addGate = Promise.resolve()
  const ok: WorkActionResult = { ok: true }
  testResult = ok
  testGate = Promise.resolve()
  defaultResult = ok
  Reflect.set(window, 'corral', {
    getWorkSettings: async () => state,
    onWorkSettings: (listener: (next: WorkSettingsState) => void) => { listeners.push(listener); return () => {} },
    addWorkConnection: async (input: WorkConnectionAddInput) => { added.push(input); const result = addResult; const gate = addGate; addGate = Promise.resolve(); await gate; return result },
    testWorkConnection: async (input: { connectionId: string }) => { tested.push(input.connectionId); const result = testResult; const gate = testGate; testGate = Promise.resolve(); await gate; return result },
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

it('[R4-B] old-test-result-erases-new-generation-test-error — 새 세대의 실패 줄을 옛 세대 테스트의 늦은 결과가 지우지 못한다(적용 전에 거른다)', async () => {
  let release = (): void => {}
  testGate = new Promise<void>((resolve) => { release = resolve })
  testResult = { ok: false, error: { kind: 'not_connected', status: null, message: '토큰이 바뀌어 이전 토큰으로 한 요청의 결과를 버렸습니다' } }
  await mount()
  act(() => q('[data-connection-test]').click())
  // 교체 성공 — 세대 1. 새 토큰으로 누른 테스트가 invalid_response.
  push(withConnection({ generation: 1, tokenTail: 'new4' }))
  testResult = { ok: false, error: { kind: 'invalid_response', status: null, message: '새 토큰 응답 어긋남' } }
  await act(async () => { q('[data-connection-test]').click() })
  expect(q('[data-connection-test-error="invalid_response"]').textContent).toContain('새 토큰 응답 어긋남')
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(q('[data-connection-test-error="invalid_response"]').textContent).toContain('새 토큰 응답 어긋남')
})

it('[R4-B] 같은 세대에서도 앞선 테스트의 늦은 결과는 최신 테스트의 결과를 덮지 않는다', async () => {
  let release = (): void => {}
  testGate = new Promise<void>((resolve) => { release = resolve })
  testResult = { ok: true }
  await mount()
  act(() => q('[data-connection-test]').click())
  testResult = { ok: false, error: { kind: 'invalid_response', status: null, message: '최신 테스트 어긋남' } }
  await act(async () => { q('[data-connection-test]').click() })
  expect(q('[data-connection-test-error="invalid_response"]').textContent).toContain('최신 테스트 어긋남')
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(q('[data-connection-test-error="invalid_response"]').textContent).toContain('최신 테스트 어긋남')
})

function field(selector: string): HTMLInputElement {
  const found = q(selector)
  if (!(found instanceof HTMLInputElement)) throw new Error(`${selector} 입력칸 아님`)
  return found
}

// LIFE-605 C1 — 칸 여러 개 출처(중립 이름 `src-b`). 칸 목록·이름·각주·카드 자리는 descriptor 가 준다.
const SOURCE_B = {
  id: 'src-b', name: 'Source B', mono: 'SB', addLabel: '+ B', formTitle: 'B 연결', tokenLabel: 'B 토큰', tokenPrefix: null, keyPattern: null, queryPattern: null,
  tokenHint: 'B 토큰 각주',
  accountFields: [
    { key: 'site', label: '사이트 URL', placeholder: 'https://x.example', hint: '사이트 각주', input: 'url' as const, shownIn: 'title' as const, fixedOnReplace: true },
    { key: 'email', label: '이메일', placeholder: 'you@x', hint: null, input: 'email' as const, shownIn: 'meta' as const, fixedOnReplace: false },
  ],
}
const CONNECTION_B: WorkConnectionSummary = { ...CONNECTION, id: 'c2', sourceId: 'src-b', name: 'Source B', mono: 'SB', tokenTail: '7c2e', account: { site: 'b.example', email: 'dev@b.example' } }

it('칸 여러 개 폼 — descriptor 칸 순서대로 그리고, 칸이 다 차야 저장 · 보낸 입력에 칸 값', async () => {
  state = { ...state, sources: [SOURCE, SOURCE_B] }
  await mount()
  act(() => q('[data-connection-add="src-b"]').click())
  const form = q('[data-connection-form="src-b"]')
  expect([...form.querySelectorAll('label')].map((label) => label.firstChild?.textContent)).toEqual(['사이트 URL', '이메일', 'B 토큰'])
  expect(q('[data-connection-account-hint="site"]').textContent).toBe('사이트 각주')
  expect(q('[data-connection-token-hint]').textContent).toBe('B 토큰 각주')
  const save = q('[data-connection-save]')
  type(field('[data-connection-token]'), 'secret-b')
  expect(save.hasAttribute('disabled')).toBe(true)
  type(field('[data-connection-account="site"]'), ' b.example ')
  type(field('[data-connection-account="email"]'), 'dev@b.example')
  expect(save.hasAttribute('disabled')).toBe(false)
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(added).toEqual([{ sourceId: 'src-b', token: 'secret-b', account: { site: 'b.example', email: 'dev@b.example' }, replaceId: null }])
})

it('카드 — 제목 「이름 · 사이트」, 메타 「이메일 · 토큰 이름 ••••끝」 · 칸 없는 출처는 전과 같다', async () => {
  state = { ...state, sources: [SOURCE, SOURCE_B], connections: [CONNECTION, CONNECTION_B] }
  await mount()
  const card = q('[data-connection-card="c2"]')
  expect(card.querySelector('.connection-name')?.textContent).toBe('Source B · b.example')
  expect(card.querySelector('.connection-meta')?.textContent).toMatch(/^dev@b\.example · B 토큰 ••••7c2e · /)
  expect(q('[data-connection-card="c1"]').querySelector('.connection-name')?.textContent).toBe('Source A')
  expect(host.querySelectorAll('[data-connection-card="c1"] [data-connection-card-account]')).toHaveLength(0)
})

it('토큰 바꾸기 — 바꿀 수 없는 칸은 지금 값으로 읽기 전용, 바꿀 수 있는 칸은 미리 채워 고칠 수 있다', async () => {
  state = { ...state, sources: [SOURCE, SOURCE_B], connections: [{ ...CONNECTION_B, status: 'auth', error: { message: '거부', action: 'replace_token' } }] }
  await mount()
  act(() => q('[data-connection-error] .connection-link').click())
  const site = field('[data-connection-account="site"]')
  expect(site.readOnly).toBe(true)
  expect(site.value).toBe('b.example')
  expect(site.hasAttribute('data-connection-account-locked')).toBe(true)
  const email = field('[data-connection-account="email"]')
  expect(email.readOnly).toBe(false)
  expect(email.value).toBe('dev@b.example')
  type(field('[data-connection-token]'), 'new-b')
  await act(async () => { q('[data-connection-form="src-b"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(added.at(-1)).toEqual({ sourceId: 'src-b', token: 'new-b', account: { site: 'b.example', email: 'dev@b.example' }, replaceId: 'c2' })
})

// LIFE-615 R5-A — 토큰 교체 저장을 기다리는 동안 연 새 추가 폼·초안은 옛 교체의 완료가 닫지 않는다.
async function replaceThenOpenAdd(): Promise<{ release: () => void; draft: HTMLInputElement }> {
  let release = (): void => {}
  addGate = new Promise<void>((resolve) => { release = resolve })
  state = withConnection({ status: 'auth', error: { message: '거부됨 (401)', action: 'replace_token' } })
  await mount()
  act(() => q('[data-connection-error] .connection-link').click())
  type(field('[data-connection-token]'), 'a_pat_replace000')
  act(() => { q('[data-connection-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  act(() => q('[data-connection-add="src-a"]').click())
  expect(q('.connection-form-title').textContent).toBe('A 연결')
  const draft = field('[data-connection-token]')
  type(draft, 'a_pat_new_draft_0000')
  return { release, draft }
}

it('[R5-A] 옛 교체가 성공으로 끝나도 그 사이 연 새 추가 폼·초안은 남는다', async () => {
  const { release } = await replaceThenOpenAdd()
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(added.map((input) => input.replaceId)).toEqual(['c1'])
  expect(q('.connection-form-title').textContent).toBe('A 연결')
  expect(field('[data-connection-token]').value).toBe('a_pat_new_draft_0000')
})

it('[R5-A] 옛 교체가 실패로 끝나도 새 추가 폼·초안은 남고 옛 폼의 오류가 끼어들지 않는다', async () => {
  addResult = { ok: false, error: { kind: 'auth', status: 401, message: '토큰을 거부했습니다 (401)' } }
  const { release } = await replaceThenOpenAdd()
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(q('.connection-form-title').textContent).toBe('A 연결')
  expect(field('[data-connection-token]').value).toBe('a_pat_new_draft_0000')
  expect(host.querySelector('[data-connection-form-error]')).toBeNull()
})

// LIFE-615 R5-B — 화면 진입 자동 테스트도 누른 테스트와 같은 실패 줄·수명 규칙.
it('[R5-B] 재시작 뒤 자동 테스트의 invalid_response 를 카드에 보인다', async () => {
  testResult = { ok: false, error: { kind: 'invalid_response', status: null, message: '응답 모양이 어긋났습니다' } }
  state = withConnection({ status: 'unchecked', spaces: null, checkedAt: null })
  await mount()
  expect(tested).toEqual(['c1'])
  expect(q('[data-connection-status]').getAttribute('data-connection-status')).toBe('unchecked')
  expect(q('[data-connection-test-error="invalid_response"]').textContent).toContain('응답 모양이 어긋났습니다')
  // 세대가 오르면 옛 자동 실패 줄은 사라진다(R3-C).
  push(withConnection({ status: 'ok', generation: 1, tokenTail: 'new4' }))
  expect(host.querySelector('[data-connection-test-error]')).toBeNull()
})

it('[R5-B] 늦게 끝난 자동 테스트 실패가 뒤에 누른 테스트 결과를 덮지 않는다(R4-B)', async () => {
  let release = (): void => {}
  testGate = new Promise<void>((resolve) => { release = resolve })
  testResult = { ok: false, error: { kind: 'invalid_response', status: null, message: '자동 테스트 어긋남' } }
  state = withConnection({ status: 'unchecked', spaces: null, checkedAt: null })
  await mount()
  push(withConnection({ status: 'ok' }))
  testResult = { ok: true }
  await act(async () => { q('[data-connection-test]').click() })
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(tested).toEqual(['c1', 'c1'])
  expect(host.querySelector('[data-connection-test-error]')).toBeNull()
})

it('[R5-B] 연결 상태로 남는 실패(auth)는 연결 오류 줄 하나만 — 테스트 실패 줄을 겹치지 않는다', async () => {
  testResult = { ok: false, error: { kind: 'auth', status: 401, message: '토큰이 만료됐거나 폐기됐습니다' } }
  state = withConnection({ status: 'unchecked', spaces: null, checkedAt: null })
  await mount()
  push(withConnection({ status: 'auth', spaces: null, error: { message: '토큰이 만료됐거나 폐기됐습니다', action: 'replace_token' } }))
  expect(host.querySelectorAll('[data-connection-error]')).toHaveLength(1)
  expect(host.querySelector('[data-connection-test-error]')).toBeNull()
})

it('[LIFE-615] 레포 기본 저장 실패 — 「저장하지 못했습니다」 를 한 번만', async () => {
  defaultResult = { ok: false, error: { kind: 'local_write', status: null, message: '저장하지 못했습니다 (EACCES)' } }
  await mount()
  const row = q('[data-repo-default-space="corral"]')
  act(() => row.querySelector<HTMLButtonElement>('button')?.click())
  await act(async () => { [...row.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][0]?.click() })
  expect(q('[data-repo-default-error]').textContent?.split('저장하지 못했습니다').length).toBe(2)
})

// LIFE-615 F1-1 — 저장을 기다리는 사이 **같은 key** 의 폼을 다시 열어 넣은 초안은 옛 저장 성공이 지우거나 닫지 않는다.
it('[F1-1] 교체 저장 중 같은 연결의 「토큰 다시 붙여넣기」 를 다시 눌러 넣은 초안이 옛 저장 성공 뒤에도 남는다', async () => {
  let release = (): void => {}
  addGate = new Promise<void>((resolve) => { release = resolve })
  state = withConnection({ status: 'auth', error: { message: '거부됨 (401)', action: 'replace_token' } })
  await mount()
  act(() => q('[data-connection-error] .connection-link').click())
  type(field('[data-connection-token]'), 'a_pat_replace000')
  act(() => { q('[data-connection-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  act(() => q('[data-connection-error] .connection-link').click())
  type(field('[data-connection-token]'), 'a_pat_reopened_draft')
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(added.map((input) => input.replaceId)).toEqual(['c1'])
  expect(q('.connection-form-title').textContent).toContain('토큰 바꾸기')
  expect(field('[data-connection-token]').value).toBe('a_pat_reopened_draft')
})

it('[F1-1] 추가 저장 중 같은 출처의 「+ 토큰」 을 다시 눌러 넣은 초안이 옛 저장 성공 뒤에도 남는다', async () => {
  let release = (): void => {}
  addGate = new Promise<void>((resolve) => { release = resolve })
  await mount()
  act(() => q('[data-connection-add="src-a"]').click())
  type(field('[data-connection-token]'), 'a_pat_first0000')
  act(() => { q('[data-connection-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  act(() => q('[data-connection-add="src-a"]').click())
  type(field('[data-connection-token]'), 'a_pat_reopened_draft')
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(added.map((input) => input.replaceId)).toEqual([null])
  expect(q('.connection-form-title').textContent).toBe('A 연결')
  expect(field('[data-connection-token]').value).toBe('a_pat_reopened_draft')
})
