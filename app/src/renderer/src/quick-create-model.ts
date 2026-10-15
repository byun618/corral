// 작업 만들기 모델 (LIFE-604) — 빠른 생성 모달·인라인 추가가 같이 쓰는 순수 함수. 상태·요청은 `useQuickCreate`.
//
// - 출처 이름으로 분기하지 않는다(K3) — 「첫 상태로만 만듭니다」 각주·필수 필드 상자·상태 후보는 생성 메타(E11) 값으로만 정한다.
// - 기본 종류 = 그 스페이스 종류 중 **자식을 받지 않는 첫 종류**(예: Task · Story), 없으면 첫 종류. 출처가 정한 종류 순서를 따른다.
// - 부모 후보 = 같은 스페이스에서 불러온 작업 중 그 종류를 `childKinds` 로 받는 것(C2). 불러오지 않은 쪽(다음 쪽)의 작업은 후보에 없다.

import type { WorkCreateFieldValue, WorkCreateMeta, WorkItem, WorkKind, WorkPlacement, WorkPriority, WorkStatus } from '../../shared/work.js'

export type CreateTarget = { connectionId: string; spaceKey: string }

/** 모달의 입력 — 초안도 이 모양 그대로 남는다. `statusKey` null = 메타의 기본 상태. `values` 는 필수 필드 키 → 값(종류를 바꿔도 같은 키면 남는다). */
export type CreateForm = {
  kindKey: string
  title: string
  body: string
  parentId: string | null
  statusKey: string | null
  priority: WorkPriority | null
  placement: WorkPlacement
  values: Record<string, string>
}

/** 메타 한 칸의 상태 — 받는 중 · 받음 · 실패(이유). */
export type CreateMetaState = { state: 'loading' } | { state: 'ready'; meta: WorkCreateMeta } | { state: 'error'; message: string }

export function targetKey(target: CreateTarget): string {
  return `${target.connectionId}::${target.spaceKey}`
}

export function defaultKind(kinds: WorkKind[]): WorkKind | null {
  return kinds.find((kind) => kind.childKinds.length === 0) ?? kinds[0] ?? null
}

export function parentCandidates({ items, kindKey }: { items: WorkItem[]; kindKey: string }): WorkItem[] {
  return items.filter((item) => item.kind.childKinds.includes(kindKey))
}

/** 종류를 바꿨을 때 부모가 규칙 밖이 되면 비운다 — 비웠으면 알림 글. */
export function keepParent({ parent, kindKey, kindLabel }: { parent: WorkItem | null; kindKey: string; kindLabel: string }): { parentId: string | null; notice: string | null } {
  if (parent === null) return { parentId: null, notice: null }
  if (parent.kind.childKinds.includes(kindKey)) return { parentId: parent.id, notice: null }
  return { parentId: null, notice: `${parent.key} 은(는) ${kindLabel} 를 자식으로 받지 않아 부모를 비웠습니다.` }
}

/**
 * 폼의 부모가 지금 쓸 수 있는가(R1-D) — 불러온 목록에 있고 그 종류를 자식으로 받아야 한다. 아니면 비우고 알림 글.
 * 칩은 불러온 작업에서 부모를 찾아 그리므로, 목록에 없는 부모 id 를 남기면 칩(「부모 없음」)과 요청이 어긋난다.
 */
export function checkParent({ form, items }: { form: CreateForm; items: WorkItem[] }): { form: CreateForm; notice: string | null } {
  if (form.parentId === null) return { form, notice: null }
  const parent = items.find((item) => item.id === form.parentId)
  if (parent !== undefined && parent.kind.childKinds.includes(form.kindKey)) return { form, notice: null }
  const notice = parent === undefined ? '부모가 지금 목록에 없어 비웠습니다.' : `${parent.key} 은(는) 이 종류를 자식으로 받지 않아 부모를 비웠습니다.`
  return { form: { ...form, parentId: null }, notice }
}

/** 상태 후보 — 메타가 허용한 상태만, 스페이스 상태 순서대로. */
export function statusOptions({ statuses, meta }: { statuses: WorkStatus[]; meta: WorkCreateMeta }): WorkStatus[] {
  return statuses.filter((status) => meta.statusKeys.includes(status.key))
}

/** 메타가 열린 상태 일부만 허용하면 각주를 단다(출처가 첫 상태로만 만든다 등). 이름이 아니라 개수로 안다. */
export function statusNote({ statuses, meta }: { statuses: WorkStatus[]; meta: WorkCreateMeta }): string | null {
  const open = statuses.filter((status) => status.category !== 'done').length
  if (meta.statusKeys.length >= open) return null
  return meta.statusKeys.length === 1 ? '이 출처는 워크플로의 첫 상태로만 만듭니다' : '이 출처가 허용한 상태로만 만듭니다'
}

/** 보낼 상태 — 고른 상태가 메타 안이면 그것, 아니면 기본 상태. */
export function chosenStatus({ form, meta }: { form: CreateForm; meta: WorkCreateMeta }): string {
  return form.statusKey !== null && meta.statusKeys.includes(form.statusKey) ? form.statusKey : meta.defaultStatusKey
}

/** 필수 필드 값 — 메타에 있는 키만, 메타 순서대로. */
export function fieldValues({ form, meta }: { form: CreateForm; meta: WorkCreateMeta }): WorkCreateFieldValue[] {
  return meta.fields.map((field) => ({ key: field.key, value: form.values[field.key] ?? '' }))
}

/**
 * 만들기를 막는 이유 — 없으면 null. 순서: 메타 받는 중·실패 → 지원 밖 필수 필드 → 제목 → 빈 필수 필드.
 * 진행 중(보내는 중·확인 중)·쓰기 막힘은 부르는 쪽이 앞에 둔다.
 */
export function submitProblem({ form, meta }: { form: CreateForm; meta: CreateMetaState }): string | null {
  if (meta.state === 'loading') return '만들기 정보를 받는 중…'
  if (meta.state === 'error') return `만들기 정보를 받지 못했습니다 — ${meta.message}`
  const unsupported = meta.meta.fields.find((field) => field.shape === 'unsupported')
  if (unsupported !== undefined) return `${unsupported.label} 은(는) corral 에서 채울 수 없음 — 출처에서 만드세요`
  if (form.title.trim().length === 0) return '제목을 입력하세요'
  const empty = meta.meta.fields.find((field) => {
    const value = form.values[field.key] ?? ''
    if (field.shape === 'option') return !field.options.some((option) => option.id === value)
    return value.trim().length === 0
  })
  return empty === undefined ? null : `필수 필드 ${empty.label} 을(를) 채우세요`
}

/** 초안으로 남길 만한가 — 제목·설명·필수 필드 값 중 하나라도 있으면(C5). */
export function hasDraftContent(form: CreateForm): boolean {
  return form.title.trim().length > 0 || form.body.trim().length > 0 || Object.values(form.values).some((value) => value.trim().length > 0)
}

/** 「하나 더」 — 제목·설명·필수 필드 값만 비우고 나머지(종류·부모·상태·우선순위·배치)는 그대로(C6). */
export function nextForm(form: CreateForm): CreateForm {
  return { ...form, title: '', body: '', values: {} }
}

/** 결과를 모르는 만들기(R1-A) 뒤의 안내 — 목록을 다시 확인하기 전에는 다시 만들지 못한다. */
export const UNKNOWN_CREATE = '만들어졌는지 모릅니다 — 「목록 다시 확인」 뒤에 다시 만들 수 있습니다.'

/** 오류 분류 문구(T1 K2) — 인증·권한·네트워크는 앞에 갈래를 붙인다. */
export function createErrorText(error: { kind: string; message: string }): string {
  switch (error.kind) {
    case 'auth': return `인증 실패 — ${error.message}`
    case 'forbidden': return `권한 부족 — ${error.message}`
    case 'network': return `네트워크 — ${error.message}`
    case 'invalid_response': return `서버 응답 오류 — ${error.message}`
    case 'rejected': return `출처가 거절했습니다 — ${error.message}`
    default: return error.message
  }
}

export const PRIORITY_CYCLE: (WorkPriority | null)[] = [null, 'highest', 'high', 'medium', 'low', 'lowest']
