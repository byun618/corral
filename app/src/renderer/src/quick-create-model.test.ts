// LIFE-604 — 만들기 모델 순수 함수: 기본 종류 · 부모 규칙 · 상태 후보·각주 · 만들기 막는 이유 · 초안 · 하나 더 · 활동 글.
import { describe, expect, it } from 'vitest'
import type { WorkCreateMeta, WorkItem, WorkKind, WorkStatus } from '../../shared/work.js'
import { chosenStatus, defaultKind, fieldValues, hasDraftContent, keepParent, kindUnavailable, nextForm, parentCandidates, statusNote, statusOptions, submitProblem, titleTooLong, CREATE_NO_BODY, CREATE_NO_PRIORITY, type CreateForm, type CreateMetaState } from './quick-create-model.js'
import { describeChange } from './task-detail-model.js'

const kinds: WorkKind[] = [{ key: 'epic', label: 'Epic', childKinds: ['story', 'bug'] }, { key: 'story', label: 'Story', childKinds: [] }, { key: 'bug', label: 'Bug', childKinds: [] }]
const status = (key: string, category: WorkStatus['category'], order: number): WorkStatus => ({ key, label: key, category, order, color: null })
const statuses = [status('todo', 'todo', 0), status('doing', 'in_progress', 1), status('review', 'in_progress', 2), status('done', 'done', 3)]
const item = (id: string, kind: WorkKind): WorkItem => ({ bodyLock: null, doneAt: null, 
  id, key: id.toUpperCase(), spaceKey: 'S', title: id, body: null, kind, statusKey: 'todo', category: 'todo', resolution: null, priority: null, dueAt: null, parentId: null, placement: 'board',
  rank: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [],
})
const form = (patch: Partial<CreateForm> = {}): CreateForm => ({ kindKey: 'story', title: '제목', body: '', parentId: null, statusKey: null, priority: null, placement: 'board', values: {}, ...patch })
const meta = (patch: Partial<WorkCreateMeta> = {}): WorkCreateMeta => ({ accepts: { body: true, priority: true }, spaceKey: 'S', kindKey: 'story', statusKeys: ['todo'], defaultStatusKey: 'todo', placement: 'applies', fields: [], ...patch })

describe('quick-create-model', () => {
  it('기본 종류 = 자식을 받지 않는 첫 종류, 없으면 첫 종류', () => {
    expect(defaultKind(kinds)?.key).toBe('story')
    expect(defaultKind([{ key: 'a', label: 'A', childKinds: ['a'] }])?.key).toBe('a')
    expect(defaultKind([])).toBeNull()
  })

  it('부모 후보는 그 종류를 받는 작업만 · 종류를 바꿔 규칙 밖이면 비우고 알림', () => {
    const [epicKind, storyKind] = kinds
    if (epicKind === undefined || storyKind === undefined) throw new Error('kinds')
    const epic = item('e1', epicKind)
    const items = [epic, item('s1', storyKind)]
    expect(parentCandidates({ items, kindKey: 'story' }).map((entry) => entry.id)).toEqual(['e1'])
    expect(parentCandidates({ items, kindKey: 'epic' })).toEqual([])
    expect(keepParent({ parent: epic, kindKey: 'bug', kindLabel: 'Bug' })).toEqual({ parentId: 'e1', notice: null })
    expect(keepParent({ parent: epic, kindKey: 'epic', kindLabel: 'Epic' })).toMatchObject({ parentId: null, notice: expect.stringContaining('E1') })
  })

  it('상태 후보·각주는 메타 값으로만(출처 이름 없음) — 열린 상태 전부면 각주 없음, 하나면 「첫 상태로만」', () => {
    expect(statusOptions({ statuses, meta: meta() }).map((entry) => entry.key)).toEqual(['todo'])
    expect(statusNote({ statuses, meta: meta() })).toContain('첫 상태로만')
    expect(statusNote({ statuses, meta: meta({ statusKeys: ['todo', 'doing', 'review'] }) })).toBeNull()
    expect(statusNote({ statuses, meta: meta({ statusKeys: ['todo', 'doing'] }) })).toContain('허용한 상태로만')
    expect(chosenStatus({ form: form({ statusKey: 'doing' }), meta: meta() })).toBe('todo')
    expect(chosenStatus({ form: form({ statusKey: 'doing' }), meta: meta({ statusKeys: ['todo', 'doing'] }) })).toBe('doing')
  })

  it('만들기를 막는 이유 — 받는 중 · 실패 · 지원 밖 · 제목 공백 · 빈 필수(고르기는 선택지 id 만)', () => {
    expect(submitProblem({ form: form(), meta: { state: 'loading' } })).toContain('받는 중')
    expect(submitProblem({ form: form(), meta: { state: 'error', message: 'x' } })).toContain('받지 못했습니다')
    expect(submitProblem({ form: form(), meta: { state: 'ready', meta: meta({ fields: [{ key: 't', label: 'Team', shape: 'unsupported', sourceType: 'user' }] }) } })).toContain('corral 에서 채울 수 없음')
    expect(submitProblem({ form: form({ title: '  ' }), meta: { state: 'ready', meta: meta() } })).toContain('제목')
    const option = meta({ fields: [{ key: 'i', label: 'Impact', shape: 'option', options: [{ id: 'hi', label: 'High' }] }] })
    expect(submitProblem({ form: form({ values: { i: 'nope' } }), meta: { state: 'ready', meta: option } })).toContain('Impact')
    expect(submitProblem({ form: form({ values: { i: 'hi' } }), meta: { state: 'ready', meta: option } })).toBeNull()
    expect(submitProblem({ form: form({ values: { e: '  ' } }), meta: { state: 'ready', meta: meta({ fields: [{ key: 'e', label: 'Env', shape: 'text' }] }) } })).toContain('Env')
    // 메타에 없는 키의 값은 보내지 않는다.
    expect(fieldValues({ form: form({ values: { i: 'hi', stale: 'x' } }), meta: option })).toEqual([{ key: 'i', value: 'hi' }])
  })

  it('R4-E 길이 한도 — 계약 상수(제목 500 · 설명 200,000 · 필수 값 10,000)로 보내기 전에 막고 한도를 말한다, 앞뒤 공백은 빼고 센다', () => {
    const ready: CreateMetaState = { state: 'ready', meta: meta({ fields: [{ key: 'e', label: 'Env', shape: 'text' }] }) }
    expect(submitProblem({ form: form({ title: 'a'.repeat(501), values: { e: 'x' } }), meta: ready })).toBe('제목은 500자까지입니다 (지금 501자)')
    expect(submitProblem({ form: form({ title: ` ${'a'.repeat(500)} `, values: { e: 'x' } }), meta: ready })).toBeNull()
    expect(submitProblem({ form: form({ body: 'b'.repeat(200_001), values: { e: 'x' } }), meta: ready })).toContain('설명은 200,000자까지입니다')
    expect(submitProblem({ form: form({ values: { e: 'v'.repeat(10_001) } }), meta: ready })).toBe('Env 은(는) 10,000자까지입니다')
    expect(titleTooLong('a'.repeat(500))).toBeNull()
    expect(titleTooLong('a'.repeat(501))).toContain('500자까지')
  })

  it('R4-F 메타가 만들 수 없다고 한 종류 — 막는 이유 = 출처 글 · 종류 흐림 이유, 받는 중·실패면 고를 수 있다', () => {
    const ready: CreateMetaState = { state: 'ready', meta: meta({ unavailable: '여기서는 못 만듭니다' }) }
    expect(submitProblem({ form: form(), meta: ready })).toBe('여기서는 못 만듭니다')
    expect(kindUnavailable(ready)).toBe('여기서는 못 만듭니다')
    expect(kindUnavailable({ state: 'ready', meta: meta() })).toBeNull()
    expect(kindUnavailable({ state: 'loading' })).toBeNull()
    expect(kindUnavailable({ state: 'error', message: 'x' })).toBeNull()
  })

  it('초안·하나 더 — 글이 있으면 초안, 하나 더는 제목·설명·필수 값만 비운다', () => {
    expect(hasDraftContent({ form: form({ title: '' }), fieldKeys: [] })).toBe(false)
    expect(hasDraftContent({ form: form({ title: '', body: '본문' }), fieldKeys: [] })).toBe(true)
    expect(hasDraftContent({ form: form({ title: '', values: { i: 'hi' } }), fieldKeys: ['i'] })).toBe(true)
    // R3-F — 지금 종류 메타에 없는 키의 값만 있으면 초안이 아니다.
    expect(hasDraftContent({ form: form({ title: '', values: { i: 'hi' } }), fieldKeys: [] })).toBe(false)
    expect(hasDraftContent({ form: form({ title: '', values: { i: 'hi' } }), fieldKeys: ['other'] })).toBe(false)
    const kept = form({ kindKey: 'bug', parentId: 'e1', statusKey: 'todo', priority: 'high', placement: 'backlog', body: 'b', values: { i: 'hi' } })
    expect(nextForm(kept)).toEqual({ ...kept, title: '', body: '', values: {} })
  })

  it('활동 「만들었음」 글', () => {
    expect(describeChange({ change: { field: 'created', kindLabel: 'Story' }, statuses: [] })).toBe('만들었음 · Story')
  })
})

describe('LIFE-605 C8 받지 않는 칸(accepts)', () => {
  it('설명·우선순위를 받지 않는 종류에 값이 있으면 보내지 않는다 · 비우면 보낸다', () => {
    const filled = form({ body: '설명', priority: 'high' })
    const ready = (accepts: WorkCreateMeta['accepts']): CreateMetaState => ({ state: 'ready', meta: meta({ accepts }) })
    expect(submitProblem({ form: filled, meta: ready({ body: false, priority: true }) })).toContain(CREATE_NO_BODY)
    expect(submitProblem({ form: { ...filled, body: '' }, meta: ready({ body: false, priority: false }) })).toContain(CREATE_NO_PRIORITY)
    expect(submitProblem({ form: { ...filled, body: '', priority: null }, meta: ready({ body: false, priority: false }) })).toBeNull()
  })
})
