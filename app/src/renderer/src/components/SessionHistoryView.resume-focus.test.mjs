// @vitest-environment happy-dom
/* global document, window -- happy-dom 환경 */
// LIFE-808 R2-1 — 재개 `started` 뒤 새 탭 이동은 앱의 새 탭 장치(`useLifecycleActions` 의 pendingSelectRef · setPendingRevealTab · setActive)를 거친다.
// 화면(SessionHistoryView)과 실제 훅을 App 과 같은 배선(onRevealPane = selectPane · onReserveCreatedRow = reserveCreatedRow)으로 묶어 순서를 바꿔 본다.
//   (가) 응답이 state 보다 먼저 온다 → 응답 시점엔 선택을 건드리지 않고, 새 pane 이 도착한 뒤 그것이 선택되고 그 탭을 펴라는 신호가 선다
//   (나) 응답 전에 사용자가 다른 pane 을 고른다 → 응답이 와도, 새 pane 이 도착해도 사용자 선택이 남는다
//   (다) 새 pane 이 응답보다 먼저 state 에 온다 → 응답 뒤 탭 펴기 신호, 다음 state 반영에서 선택(앱의 새 탭 경로 createRow 와 같은 성질)
//   (라)·(마) 표식 하나씩 — (라) worktree 만 바꿈(의도 순번만 바뀜) (마) 파일 탭으로 화면 탭만 바꿈(화면 탭만 바뀜). 둘 다 이동하지 않는다(R3-2)
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useLifecycleActions } from '../hooks/useLifecycleActions.js'
import { useSessionHistory } from '../hooks/useSessionHistory.js'
import { SessionHistoryView } from './SessionHistoryView.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const ID = '11111111-1111-4111-8111-111111111111'
const ROW = { provider: 'claude', id: ID, file: `/h/${ID}.jsonl`, title: 'Alpha', cwd: '/w/a', cwdKey: '/w/a', cwdExists: true, branch: null, model: null, firstPrompt: null, lastPrompt: null, lastActivityAt: 1, empty: false }
const DETAIL = {
  provider: 'claude', id: ID, file: ROW.file, firstPrompt: null, recent: [], messageCount: 0, cwd: '/w/a', cwdExists: true,
  resume: { argv: ['claude', '--resume', ID], cwd: '/w/a', fallback: false, disabled: null }, command: `cd /w/a && claude --resume ${ID}`,
}
const pane = (paneId, tabId, focused = false) => ({ paneId, tabId, workspaceId: 'w1', focused, agent: null, agentSession: null })
const tab = (tabId, panes) => ({ tabId, workspaceId: 'w1', panes })
/** w1 — t1(p1, herdr 포커스) · t2(p2). `resumed` 면 재개가 만든 t9(p9)가 도착한 뒤. w2 = 탭 없는 다른 worktree. `rev` 는 같은 모양의 새 push. */
const stateOf = ({ resumed, rev = 0 }) => ({
  home: '/h',
  rev,
  repos: [{
    root: '/w',
    worktrees: [{
      path: '/w/a', isLinked: true, openWorkspaceId: 'w1',
      workspace: { workspaceId: 'w1', focused: true, tabs: [tab('t1', [pane('p1', 't1', true)]), tab('t2', [pane('p2', 't2')]), ...(resumed ? [tab('t9', [pane('p9', 't9')])] : [])] },
    }, {
      path: '/w/b', isLinked: true, openWorkspaceId: 'w2',
      workspace: { workspaceId: 'w2', focused: false, tabs: [] },
    }],
  }],
})

let host
let root
let hook = null
let finishResume = () => undefined
let resumes = 0
/** 화면이 보이는 탭 — App 이 렌더마다 `shownTabRef` 에 채우는 값(파일 탭이 활성이면 null). */
let shownTab = 't1'
function Harness({ state }) {
  const lifecycle = useLifecycleActions(state)
  lifecycle.shownTabRef.current = shownTab
  hook = lifecycle
  const api = useSessionHistory({ active: true })
  return createElement(SessionHistoryView, { api, repos: state.repos, worktree: '/w/a', workspaceId: 'w1', onRevealPane: lifecycle.selectPane, onReserveCreatedRow: lifecycle.reserveCreatedRow })
}
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }) }
const push = async (state) => { act(() => root.render(createElement(Harness, { state }))); await flush() }
const click = async (selector) => { await act(async () => { host.querySelector(selector)?.click(); for (let i = 0; i < 8; i += 1) await Promise.resolve() }) }

beforeEach(() => {
  resumes = 0
  shownTab = 't1'
  Reflect.set(window, 'corral', {
    getUiPrefs: () => Promise.resolve({}),
    setUiPrefs: () => undefined,
    sessionHistoryList: () => Promise.resolve({ kind: 'ok', rows: [ROW], unreadable: 0, realpaths: {} }),
    sessionHistoryDetail: () => Promise.resolve({ kind: 'ok', detail: DETAIL }),
    sessionHistoryResume: () => { resumes += 1; return new Promise((resolve) => { finishResume = resolve }) },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** 보기를 띄우고 행을 골라 재개를 누른다 — 응답은 아직 안 왔다. */
async function requestResume() {
  await push(stateOf({ resumed: false }))
  expect(hook.selectedPane).toBe('p1')
  await click(`[data-history-row="claude:${ID}"]`)
  await click('[data-history-resume]')
  expect(resumes).toBe(1)
}
const answer = async () => { await act(async () => { finishResume({ kind: 'started', paneId: 'p9', tabId: 't9', workspaceId: 'w1' }); for (let i = 0; i < 8; i += 1) await Promise.resolve() }) }

describe('R2-1 재개 뒤 새 탭 이동 — 앱의 새 탭 장치', () => {
  it('(가) 응답이 state 보다 먼저 와도 새 pane 이 도착한 뒤 그것이 선택되고 그 탭을 펴라는 신호가 선다', async () => {
    await requestResume()
    await answer()
    // 응답 시점: 새 pane 이 아직 상태에 없다 — 선택은 그대로, 탭 펴기는 신호만
    expect(hook.selectedPane).toBe('p1')
    expect(hook.pendingRevealTab).toBe('t9')
    await push(stateOf({ resumed: true }))
    expect(hook.selectedPane).toBe('p9')
    expect(hook.activeWorkspaceId).toBe('w1')
  })
  it('(나) 응답 전에 다른 pane 을 고르면 이동하지 않는다 — 응답 뒤에도, 새 pane 도착 뒤에도', async () => {
    await requestResume()
    act(() => hook.selectPane('p2'))
    await flush()
    await answer()
    expect(hook.pendingRevealTab).toBeNull()
    await push(stateOf({ resumed: true }))
    expect(hook.selectedPane).toBe('p2')
    expect(hook.pendingRevealTab).toBeNull()
  })
  it('(다) 새 pane 이 응답보다 먼저 도착해도 — 응답 뒤 탭을 펴라는 신호, 다음 state 반영에서 그 pane 이 선택된다', async () => {
    await requestResume()
    await push(stateOf({ resumed: true }))
    expect(hook.selectedPane).toBe('p1')
    await answer()
    expect(hook.pendingRevealTab).toBe('t9')
    await push(stateOf({ resumed: true, rev: 1 }))
    expect(hook.selectedPane).toBe('p9')
  })
  it('(라) 응답 전에 다른 worktree 를 고르면(의도 순번만 바뀜 — 선택 pane·화면 탭은 그대로) 이동하지 않는다', async () => {
    await requestResume()
    act(() => hook.actions.activateWorkspace('w2'))
    await flush()
    expect(hook.selectedPane).toBe('p1')
    await answer()
    expect(hook.pendingRevealTab).toBeNull()
    expect(hook.activeWorkspaceId).toBe('w2')
  })
  it('(마) 응답 전에 파일 탭으로 화면 탭만 바꾸면(의도 순번·선택 pane 은 그대로) 이동하지 않는다', async () => {
    await requestResume()
    shownTab = null
    await push(stateOf({ resumed: false, rev: 1 }))
    await answer()
    expect(hook.pendingRevealTab).toBeNull()
    await push(stateOf({ resumed: true, rev: 2 }))
    expect(hook.selectedPane).toBe('p1')
  })
})
