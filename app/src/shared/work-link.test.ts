// LIFE-603 C9 — 작업 링크 해석: 명시 > 예외 > 레포 기본 연결 > 유일 일치, 모호하면 붙이지 않는다.
import { describe, expect, it } from 'vitest'
import { branchLinkKey, readStoredWorkLink, resolveWorkLink, type LinkConnection, type StoredWorkLink } from './work-link.js'

const LA: LinkConnection = { id: 'c-la', sourceId: 'la', keyPattern: 'LIFE-\\d+' }
const MOCK: LinkConnection = { id: 'c-mock', sourceId: 'mock-jira', keyPattern: '[A-Z][A-Z0-9]*-\\d+' }
const explicit: StoredWorkLink = { sourceId: 'la', connectionId: 'c-la', itemId: 'uuid-603', key: 'LIFE-603', linkedAt: 1 }
const resolve = (input: Partial<Parameters<typeof resolveWorkLink>[0]>) =>
  resolveWorkLink({ branch: 'LIFE-603-start', explicit: null, suppressed: false, defaultConnectionId: null, connections: [LA], ...input })

describe('branchLinkKey — 대소문자 그대로 · 가장 왼쪽 키 하나', () => {
  it('브랜치 앞의 키', () => {
    expect(branchLinkKey({ branch: 'refs/heads/LIFE-603-start-work-link', pattern: LA.keyPattern })).toBe('LIFE-603')
    expect(branchLinkKey({ branch: 'feature/LIFE-372-la-issue-link', pattern: LA.keyPattern })).toBe('LIFE-372')
  })
  it('소문자 키는 붙지 않는다', () => {
    expect(branchLinkKey({ branch: 'life-603-start', pattern: LA.keyPattern })).toBeNull()
    expect(branchLinkKey({ branch: 'core-12-fix', pattern: MOCK.keyPattern })).toBeNull()
  })
  it('키가 둘이면 가장 왼쪽 하나', () => {
    expect(branchLinkKey({ branch: 'LIFE-603-fix-LIFE-12', pattern: LA.keyPattern })).toBe('LIFE-603')
    expect(branchLinkKey({ branch: 'CORE-7-and-WEB-1', pattern: MOCK.keyPattern })).toBe('CORE-7')
  })
  it('글자 속에 박힌 모양·숫자 이어짐은 키가 아니다', () => {
    expect(branchLinkKey({ branch: 'xLIFE-603', pattern: LA.keyPattern })).toBeNull()
    expect(branchLinkKey({ branch: 'LIFE-6031', pattern: LA.keyPattern })).toBe('LIFE-6031')
    expect(branchLinkKey({ branch: 'main', pattern: LA.keyPattern })).toBeNull()
  })
  it('잘못된 패턴·없는 패턴은 null', () => {
    expect(branchLinkKey({ branch: 'LIFE-1', pattern: '(' })).toBeNull()
    expect(branchLinkKey({ branch: 'LIFE-1', pattern: null })).toBeNull()
  })
})

describe('resolveWorkLink — 고르는 순서', () => {
  it('명시 링크가 이긴다 — 키 없는 브랜치도 붙는다', () => {
    expect(resolve({ branch: 'scratch', explicit })).toEqual({ mode: 'explicit', sourceId: 'la', connectionId: 'c-la', key: 'LIFE-603', itemId: 'uuid-603', connected: true })
  })
  it('명시 링크의 연결이 해제되면 connected false — 키만 그린다', () => {
    expect(resolve({ explicit, connections: [MOCK] })).toMatchObject({ mode: 'explicit', connected: false })
  })
  it('예외(떼기)면 자동 연결하지 않는다', () => {
    expect(resolve({ suppressed: true })).toBeNull()
  })
  it('유일 일치면 자동 연결', () => {
    expect(resolve({})).toEqual({ mode: 'auto', sourceId: 'la', connectionId: 'c-la', key: 'LIFE-603', itemId: null, connected: true })
  })
  it('양성 대조 — 두 연결의 패턴이 겹치면 붙이지 않는다', () => {
    expect(resolve({ connections: [LA, MOCK] })).toBeNull()
  })
  it('겹쳐도 레포 기본 스페이스의 연결이 후보면 그쪽', () => {
    expect(resolve({ connections: [LA, MOCK], defaultConnectionId: 'c-mock' })).toMatchObject({ mode: 'auto', connectionId: 'c-mock', key: 'LIFE-603' })
    expect(resolve({ connections: [LA, MOCK], defaultConnectionId: 'c-la' })).toMatchObject({ connectionId: 'c-la' })
  })
  it('기본 연결이 후보가 아니면 유일 일치로 — 그것도 아니면 없음', () => {
    expect(resolve({ branch: 'WEB-1-copy', connections: [LA, MOCK], defaultConnectionId: 'c-la' })).toMatchObject({ connectionId: 'c-mock', key: 'WEB-1' })
  })
  it('detached(브랜치 없음)는 명시 링크만', () => {
    expect(resolve({ branch: null })).toBeNull()
    expect(resolve({ branch: null, explicit })).toMatchObject({ mode: 'explicit' })
  })
})

describe('readStoredWorkLink — 영속 값 손검증', () => {
  it('맞는 모양만', () => {
    expect(readStoredWorkLink(explicit)).toEqual(explicit)
    for (const bad of [null, 'LIFE-603', { ...explicit, key: '' }, { ...explicit, linkedAt: 'x' }, { ...explicit, itemId: 3 }, { sourceId: 'la' }]) expect(readStoredWorkLink(bad)).toBeNull()
  })
})
