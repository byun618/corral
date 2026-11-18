// @vitest-environment happy-dom
// LIFE-811 C5·C6·C7·C8(렌더러)·C9·C10 — PR 보기: 상태별 글, #14858 씨앗 표시 요소, 본문 안전, 보일 때만 묻기·전환·새로고침, 늦은 응답, 보기 등록.
import fs from 'node:fs'
import path from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPrComments, type PrComments, type PrCommentsResult } from '../../../shared/pr-comments.js'
import type { PrInfo } from '../../../shared/pr-status.js'
import { usePrComments } from '../hooks/usePrComments.js'
import { PrCommentsView } from './PrCommentsView.js'
import { RIGHT_PANEL_VIEWS } from './right-panel-views.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const SEED = readPrComments(fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'main', 'fixtures', 'pr-comments-14858.json'), 'utf8'))
const PR: PrInfo = { number: 14858, state: 'merged', url: 'https://github.com/cli/cli/pull/14858', headRefName: 'bagtoad/private-fork-deletion-guard', baseRefName: 'trunk', createdAt: null, mergedAt: null, closedAt: null }
const EMPTY: PrComments = { reviews: [], threads: [], comments: [], more: { reviews: 0, threads: 0, comments: 0 } }
const ok = (comments: PrComments, pr: PrInfo = PR): PrCommentsResult => ({ kind: 'comments', pr, comments })

type Call = { path: string; refresh?: boolean; resolve: (result: PrCommentsResult) => void }
let calls: Call[] = []
let host: HTMLDivElement
let root: Root
let opened: string[] = []

beforeEach(() => {
  calls = []
  opened = []
  Reflect.set(window, 'corral', {
    prComments: (input: { path: string; refresh?: boolean }) => new Promise<PrCommentsResult>((resolve) => { calls.push({ ...input, resolve }) }),
  })
  Reflect.set(window, 'open', (url: string) => { opened.push(url); return null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function Harness({ path: target, active }: { path: string | null; active: boolean }): React.JSX.Element {
  const api = usePrComments({ path: target, active })
  return createElement(PrCommentsView, { api, title: target })
}
const render = (props: { path: string | null; active: boolean }): void => act(() => root.render(createElement(Harness, props)))
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const answer = async (call: Call | undefined, result: PrCommentsResult): Promise<void> => {
  await act(async () => { call?.resolve(result); await Promise.resolve(); await Promise.resolve() })
}
const q = (selector: string): HTMLElement | null => host.querySelector<HTMLElement>(selector)
const all = (selector: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(selector)]
const empty = (): string | null => q('[data-pr-empty]')?.textContent ?? null

async function shown(result: PrCommentsResult): Promise<void> {
  render({ path: '/w/a', active: true })
  await flush()
  await answer(calls.at(-1), result)
}

describe('C5 상태별 화면 — 서로 다른 글', () => {
  it('worktree 없음 · 불러오는 중', async () => {
    render({ path: null, active: true })
    await flush()
    expect(empty()).toBe('열린 worktree 가 없습니다.')
    expect(calls).toHaveLength(0)
    render({ path: '/w/a', active: true })
    await flush()
    expect(empty()).toBe('PR 코멘트를 불러오는 중…')
  })
  it('결과 상태마다 글이 다르다', async () => {
    const cases: [PrCommentsResult, string][] = [
      [{ kind: 'none' }, '이 브랜치에 PR 이 없습니다.'],
      [{ kind: 'error', error: 'not_github', message: 'no git remotes found' }, '이 worktree 의 원격이 GitHub 이 아닙니다.'],
      [{ kind: 'error', error: 'no_gh', message: 'gh 를 찾지 못했습니다' }, 'gh 가 없습니다 — GitHub CLI(gh)를 설치하면 PR 코멘트를 볼 수 있습니다.'],
      [{ kind: 'error', error: 'unauthenticated', message: 'To get started with GitHub CLI, please run:  gh auth login' }, 'gh 로그인이 필요합니다 — 터미널에서 `gh auth login` 을 실행하세요.'],
      [{ kind: 'error', error: 'repo_unreadable', message: "gh: Could not resolve to a Repository with the name 'x/y'." }, '레포를 읽을 수 없습니다 — gh 계정에 이 레포 접근 권한이 있는지 확인하세요.'],
      [{ kind: 'error', error: 'failed', message: '시간 초과' }, 'PR 코멘트를 읽지 못했습니다 — 시간 초과'],
      [{ kind: 'error', error: 'failed', message: 'gh 출력 모양이 다릅니다' }, 'PR 코멘트를 읽지 못했습니다 — gh 출력 모양이 다릅니다'],
      [{ kind: 'error', error: 'failed', message: '출력이 너무 큽니다' }, 'PR 코멘트를 읽지 못했습니다 — 출력이 너무 큽니다'],
      [ok(EMPTY), '이 PR 에 리뷰 코멘트가 없습니다.'],
    ]
    const texts: string[] = []
    for (const [result, text] of cases) {
      act(() => root.unmount())
      root = createRoot(host)
      calls = []
      await shown(result)
      expect(empty()).toBe(text)
      texts.push(text)
    }
    expect(new Set(texts).size).toBe(cases.length)
    // 코멘트 0건이어도 머리는 PR 을 보인다.
    expect(q('[data-pr-title]')?.textContent).toBe('PR #14858 · 머지됨')
  })
})

describe('C6 표시 요소 (#14858 씨앗)', () => {
  it('머리 · 리뷰 3(빈 본문 1 제외) · 스레드 1(해소됨, 기본 접힘 → 펼치면 답글 포함 2) · 일반 3(숨김 2)', async () => {
    expect(SEED).not.toBeNull()
    if (SEED === null) return
    await shown(ok(SEED))
    expect(q('[data-pr-title]')?.textContent).toBe('PR #14858 · 머지됨')
    expect(all('[data-pr-review]').map((el) => el.dataset.prReview)).toEqual(['COMMENTED', 'APPROVED', 'COMMENTED'])
    expect(all('[data-pr-review-state]').map((el) => el.textContent)).toEqual(['코멘트', '승인', '코멘트'])
    expect(all('[data-pr-review] [data-pr-author]').map((el) => el.textContent)).toEqual(['copilot-pull-request-reviewer', 'babakks', '9nzhc899wn-maker'])
    const thread = all('[data-pr-thread]')
    expect(thread).toHaveLength(1)
    expect(q('[data-pr-thread-location]')?.textContent).toBe('acceptance/testdata/repo/repo-delete-private-forks.txtar:15')
    expect(q('[data-pr-badge="resolved"]')?.textContent).toBe('해소됨')
    expect(q('[data-pr-badge="outdated"]')).toBeNull()
    expect(thread[0]?.hasAttribute('data-pr-open')).toBe(false)
    expect(all('[data-pr-thread-comment]')).toHaveLength(0)
    act(() => q('.pr-thread-head')?.click())
    expect(all('[data-pr-thread-comment] [data-pr-author]').map((el) => el.textContent)).toEqual(['copilot-pull-request-reviewer', 'BagToad'])
    expect(all('[data-pr-comment]')).toHaveLength(3)
    expect(all('[data-pr-hidden]')).toHaveLength(2)
    expect(all('[data-pr-comment] [data-pr-author]').map((el) => el.textContent)).toEqual(['Ufktarimarge', 'biggiebarker8-cloud', 'biggiebarker8-cloud'])
    // 숨긴 코멘트의 본문은 그리지 않는다.
    expect(host.textContent).not.toContain('Fix it')
    // 시각이 보인다.
    expect(all('.pr-time').every((el) => el.textContent !== '')).toBe(true)
    // GitHub 열기 → PR URL(바깥 열기 경로).
    act(() => q('[data-pr-open]')?.click())
    expect(opened).toEqual(['https://github.com/cli/cli/pull/14858'])
  })
  it('미해소 · outdated · 줄 없음 스레드는 펼쳐진 채, 「N건 더」 는 PR URL', async () => {
    const comments: PrComments = {
      ...EMPTY,
      threads: [{ id: 't', path: 'a.go', line: null, resolved: false, outdated: true, comments: [{ id: 'c', author: null, body: 'hi', at: '2026-01-01T00:00:00Z', url: 'https://github.com/cli/cli/pull/1#discussion_r1' }], more: 0 }],
      more: { reviews: 0, threads: 0, comments: 55 },
    }
    await shown(ok(comments))
    expect(q('[data-pr-thread-location]')?.textContent).toBe('a.go · 줄 없음')
    expect(q('[data-pr-badge="outdated"]')?.textContent).toBe('outdated')
    expect(q('[data-pr-thread]')?.hasAttribute('data-pr-open')).toBe(true)
    expect(q('[data-pr-thread-comment] [data-pr-author]')?.textContent).toBe('ghost')
    const more = q('[data-pr-section="comments"] [data-pr-more]')
    expect(more?.textContent).toBe('55건 더 — GitHub 에서 보기')
    act(() => more?.click())
    expect(opened).toEqual(['https://github.com/cli/cli/pull/14858'])
  })
})

describe('C7 본문 안전', () => {
  it('<script>·onerror·원격 이미지가 실행 가능한 요소로 생기지 않는다, javascript: 링크는 열지 않는다', async () => {
    const body = '<script>window.__pwned = 1</script>\n\n<img src="https://evil.example/x.png" onerror="window.__pwned = 2">\n\n![remote](https://evil.example/y.png)\n\n[bad](javascript:alert(1)) [good](https://example.com/z)'
    await shown(ok({ ...EMPTY, comments: [{ id: 'c', author: 'a', body, at: null, url: 'https://github.com/cli/cli/pull/1#issuecomment-1', minimized: false }] }))
    expect(host.querySelectorAll('script')).toHaveLength(0)
    expect(host.querySelectorAll('img')).toHaveLength(0)
    expect(host.querySelectorAll('[onerror]')).toHaveLength(0)
    expect(Reflect.get(window, '__pwned')).toBeUndefined()
    // raw HTML 은 글자로 보인다.
    expect(q('[data-pr-comment]')?.textContent).toContain('<script>')
    const links = all('[data-pr-comment] [data-md-link]')
    expect(links.map((el) => el.dataset.mdLink)).toEqual(['blocked', 'external'])
    act(() => links[0]?.click())
    act(() => links[1]?.click())
    expect(opened).toEqual(['https://example.com/z'])
  })
})

describe('C8 갱신 시점 (렌더러)', () => {
  it('보이지 않으면 0회 · 보이면 1회 · worktree 전환 1회 · 숨겼다 다시 보이면 1회(main TTL 이 gh 를 막는다) · 새로고침은 refresh 1회', async () => {
    render({ path: '/w/a', active: false })
    await flush()
    expect(calls).toHaveLength(0)
    render({ path: '/w/b', active: false })
    await flush()
    expect(calls).toHaveLength(0)
    render({ path: '/w/a', active: true })
    await flush()
    expect(calls.map((call) => call.path)).toEqual(['/w/a'])
    await answer(calls[0], ok(EMPTY))
    render({ path: '/w/b', active: true })
    await flush()
    expect(calls.map((call) => call.path)).toEqual(['/w/a', '/w/b'])
    await answer(calls[1], ok(EMPTY))
    render({ path: '/w/b', active: false })
    await flush()
    expect(calls).toHaveLength(2)
    render({ path: '/w/b', active: true })
    await flush()
    expect(calls).toHaveLength(3)
    expect(calls[2]?.refresh).toBeUndefined()
    await answer(calls[2], ok(EMPTY))
    act(() => q('[data-pr-refresh]')?.click())
    await flush()
    expect(calls).toHaveLength(4)
    expect(calls[3]).toMatchObject({ path: '/w/b', refresh: true })
  })
})

describe('C9 늦은 응답', () => {
  const one = (login: string): PrComments => ({ ...EMPTY, comments: [{ id: login, author: login, body: `from ${login}`, at: null, url: 'https://github.com/x/y/pull/1#issuecomment-1', minimized: false }] })
  it('A → B 로 바꾼 뒤 A 가 늦게 와도 B 화면에 A 가 그려지지 않는다', async () => {
    render({ path: '/w/a', active: true })
    await flush()
    render({ path: '/w/b', active: true })
    await flush()
    const [callA, callB] = calls
    expect([callA?.path, callB?.path]).toEqual(['/w/a', '/w/b'])
    await answer(callB, ok(one('bee')))
    expect(q('[data-pr-comment] [data-pr-author]')?.textContent).toBe('bee')
    await answer(callA, ok(one('ay')))
    expect(q('[data-pr-comment] [data-pr-author]')?.textContent).toBe('bee')
    expect(host.textContent).not.toContain('from ay')
  })
  it('A 가 아직 안 왔고 B 도 안 왔을 때 A 가 와도 불러오는 중(A 를 그리지 않는다)', async () => {
    render({ path: '/w/a', active: true })
    await flush()
    render({ path: '/w/b', active: true })
    await flush()
    await answer(calls[0], ok(one('ay')))
    expect(empty()).toBe('PR 코멘트를 불러오는 중…')
  })
  it('같은 대상 새로고침 중에는 이전 내용을 유지하고 불러오는 중 표지, 옛 요청이 늦게 와도 새 응답을 덮지 않는다', async () => {
    render({ path: '/w/a', active: true })
    await flush()
    await answer(calls[0], ok(one('first')))
    act(() => q('[data-pr-refresh]')?.click())
    await flush()
    expect(q('[data-pr-view]')?.hasAttribute('data-pr-busy')).toBe(true)
    expect(q('[data-pr-comment] [data-pr-author]')?.textContent).toBe('first')
    act(() => q('[data-pr-refresh]')?.click())
    await flush()
    await answer(calls[2], ok(one('newest')))
    await answer(calls[1], ok(one('older')))
    expect(q('[data-pr-comment] [data-pr-author]')?.textContent).toBe('newest')
    expect(q('[data-pr-view]')?.hasAttribute('data-pr-busy')).toBe(false)
  })
  it('B 로 바꾸면 A 의 내용은 즉시 지운다', async () => {
    render({ path: '/w/a', active: true })
    await flush()
    await answer(calls[0], ok(one('ay')))
    render({ path: '/w/b', active: true })
    expect(host.textContent).not.toContain('from ay')
    expect(empty()).toBe('PR 코멘트를 불러오는 중…')
  })
})

describe('C10 보기 등록', () => {
  it('RIGHT_PANEL_VIEWS 에 pr — 제목 「PR」, 단축키 없음, 작업 상세 앞', () => {
    expect(RIGHT_PANEL_VIEWS.map((view) => view.id)).toEqual(['explorer', 'scm', 'pr', 'detail'])
    expect(RIGHT_PANEL_VIEWS.find((view) => view.id === 'pr')).toMatchObject({ title: 'PR', action: null, widthToken: '--right-panel-w' })
  })
})
