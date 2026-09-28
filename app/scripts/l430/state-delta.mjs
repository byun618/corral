// LIFE-430 C3 (LA ②의 F1(a)). "거절된 기동은 아무것도 저장하지 않는다" 를 재는 방법에 관한 것이다.
//
// 지금까지의 방법은 `state.json` 전체 바이트의 sha256 을 두 번 떠서 같은지 보는 것이었다. 그 비교는
// 옳은 말을 하지만 혼자 있을 수 없다 — 두 관측 사이에 **거절과 무관한 쓰기**가 들어오면 digest 가
// 달라지고, 검사는 거절이 무언가를 저장한 것처럼 실패한다. LIFE-426 에서 5회 중 2회가 그렇게 실패했다.
// 끼어든 쓰기는 자동 heartbeat 가 아니라, 관문이 pane 의 모델에게 준 TASK 1단계(`orchestration send
// --type heartbeat`)와 2단계(`ask`)를 **모델이 실행한 시점**이 두 digest 사이에 걸린 것이다
// (00-analysis F4). pane 이 살아 있는 한 언제든 일어날 수 있고, 재실행으로 넘기면 그때부터 그 검사는
// 관문이 아니다.
//
// 그래서 "달라졌나" 대신 **"달라진 것이 무엇이고, 무엇이 그것을 설명하나"** 를 묻는다.
//
//   1. 두 문서를 **값**까지 펼쳐 키→값 지도로 만든다. 키는 배열 위치가 아니라 레코드의 `id` 로 잡는다
//      — 메시지 하나가 덧붙었다고 그 뒤 모든 원소의 키가 밀리면 비교가 의미를 잃는다.
//   2. 추가·삭제·값변경 키를 **값 비교로** 뽑는다. 키 이름 집합만 보면 값이 바뀐 것을 놓친다.
//   3. 그 변화 하나하나를 **관측된 동시 쓰기로 설명할 수 있는지** 본다. 설명되지 않는 변화가 하나라도
//      있으면 실패이고, 실패 메시지는 그 키들을 말한다.
//
// 설명이 되는 것은 둘이다.
//
// **첫째, 이 attempt 의 pane 이 저 자신 이름으로 쓴, 보고가 아닌 메시지.**
// 구체적으로 `from.kind === 'worker'` 이고 `from.dispatchId` 와 `dispatchId` 가 검사 중인 attempt 이며
// 종류가 heartbeat·question·status·escalation 인 것. 그리고 그 쓰기가 제품 안에서 **함께** 움직이는
// 칸들 — heartbeat 는 `dispatch.worker.lastHeartbeatAt` 을 그 메시지의 시각으로 옮기고
// (`orchestration/index.ts` 의 send heartbeat 경로), 그러면서 `updatedAt` 을 같은 값으로 두고
// `version` 을 1 올린다. 그 셋은 **값이 정확히 맞을 때만** 설명된 것으로 센다. "이 칸은 원래 흔들리니까
// 빼자" 가 아니라 "이 쓰기가 이 값으로 만들었어야 한다" 이다.
//
// **둘째, §4.5 의 재관측 기록.** 제품의 모든 명령은 열린 attempt 를 다시 관측하고, 받아들여진
// 변경은 그 관측을 자기 쓰기에 실어 보낸다 (`orchestration/index.ts` 의 `session()`). 그래서 pane 이
// 창 안에서 명령을 하나라도 돌리면 `dispatch.reconcile` 이 `null` 에서 기록으로 바뀌고, 그와 함께
// `updatedAt`·`version` 이 움직인다. 이것은 **읽어서 안 것이 아니라 제품을 돌려서 본 것**이다
// (`raw/worker/claude/c3/product-shape/`) — 손으로 만든 장치는 이 칸을 몰랐고, 프로브가 잡았다.
//
// 재관측 기록은 "누가 썼는지" 를 문서만 보고 가릴 수 없다. pane 의 명령이 남긴 것과 거절된 호출이
// 남겼을 것이 같은 칸이다. 그래서 **이 비교는 재관측 기록을 "거절이 아무것도 저장하지 않는다" 의
// 대상에서 뺀다** — 대신 `observed: true` 인 것만 설명으로 받고(관측이 실패했거나 pane 이 사라졌다는
// 기록은 그대로 걸린다), 그 공백은 **격리 측정**이 메운다: 같은 거절을 pane 이 조용한 상태에서 돌려
// 문서가 바이트 그대로인지를 따로 잰다 (`c3/product-shape/`, 아래 `refused start writes nothing`).
// `updatedAt` 과 `version` 은 그 두 가지 중 **무엇이든 하나가 실제로 설명된 뒤에만**, 그리고 앞으로만
// 움직일 수 있다 — 아무것도 설명되지 않았는데 움직이면 걸린다.
//
// 검출력은 그래서 이렇게 남는다:
//   - 거절이 Task·Dispatch 레코드를 건드리면 → 설명되지 않는 값변경
//   - 거절이 새 Dispatch 를 만들면 → 설명되지 않는 추가 (메시지가 아니다)
//   - 거절이 새 수신(delivery) 기록을 만들면 → 설명되지 않는 추가
//   - 거절이 메시지를 쓰면 → 그것은 coordinator 가 쓴 것이라 `from.kind` 가 다르다. 설명되지 않는 추가
//   - **`worker_done` 은 허용 목록에 없다.** 그래서 이 비교는 "정산된 워커가 다시 보고할 수 없다" 를
//     재는 자리에서도 그대로 쓸 수 있다 — 거기서 막아야 할 쓰기가 바로 worker_done 이다
//   - 무엇이 지워지는 것은 어느 경우에도 설명되지 않는다
//
// 남는 한계 둘. ① pane 이 자기 이름으로 쓸 수 있는 종류의 메시지를 **거절 경로가 위조해서** 쓴다면
// 이 비교는 그것을 설명된 것으로 읽는다. 거절은 coordinator 자격으로 도는 호출이라 그 경로가 실제로
// 존재하지는 않지만, 비교가 거기까지 증명하지는 않는다. ② 위에 적은 대로 재관측 기록은 대상 밖이다 —
// 거절이 **오직** 그 칸만 건드렸다면 이 비교는 통과한다. 그 한 경우는 격리 측정이 따로 답한다.
import { createHash } from 'node:crypto'

/** 같은 바이트에서 digest 와 문서를 함께 뜬다 — 두 번 읽으면 그 사이가 또 창이 된다. */
export const snapshot = bytes => ({
  digest: createHash('sha256').update(bytes).digest('hex'),
  state: JSON.parse(bytes.toString('utf8') || 'null'),
})

/** 원소가 전부 고유한 문자열 `id` 를 가진 배열인가. 그렇다면 위치가 아니라 id 로 키를 잡는다. */
const keyedById = value =>
  value.length > 0
  && value.every(entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string')
  && new Set(value.map(entry => entry.id)).size === value.length

function walk(value, prefix, out) {
  if (value === null || typeof value !== 'object') { out.set(prefix, JSON.stringify(value)); return out }
  if (Array.isArray(value)) {
    // 길이도 하나의 칸이다. 허용된 수만큼만 늘어났는지가 추가 키 검사와 별개로 한 번 더 걸린다.
    out.set(`${prefix}#count`, JSON.stringify(value.length))
    const byId = keyedById(value)
    value.forEach((entry, index) => walk(entry, `${prefix}[${byId ? entry.id : index}]`, out))
    return out
  }
  for (const name of Object.keys(value).sort()) walk(value[name], prefix === '' ? name : `${prefix}.${name}`, out)
  return out
}
/** 문서 하나를 키→값(JSON 문자열) 지도로. 값까지 펼치므로 변경 키는 값 비교에서 나온다. */
export const flattenState = state => walk(state ?? null, '', new Map())

/** pane 이 자기 attempt 위에서 쓸 수 있는, 보고가 아닌 메시지. worker_done 은 여기 없다 (위 주석). */
const CONCURRENT_TYPES = new Set(['heartbeat', 'question', 'status', 'escalation'])

/**
 * 두 관측 사이의 변화와, 그 중 무엇이 설명되는지.
 *
 * @param {object|null} before  앞 관측의 문서
 * @param {object|null} after   뒤 관측의 문서
 * @param {{dispatchId: string}} options  pane 이 자기 이름으로 쓸 수 있는 attempt
 */
export function refusalDelta(before, after, { dispatchId }) {
  const left = flattenState(before), right = flattenState(after)
  const added = [...right.keys()].filter(key => !left.has(key)).sort()
  const removed = [...left.keys()].filter(key => !right.has(key)).sort()
  const changed = [...left.keys()].filter(key => right.has(key) && right.get(key) !== left.get(key)).sort()

  const priorMessages = before?.messages ?? []
  const seen = new Set(priorMessages.map(entry => entry.id))
  const appeared = (after?.messages ?? []).filter(entry => !seen.has(entry.id))
  const explainable = appeared.filter(entry =>
    entry?.from?.kind === 'worker' && entry?.from?.dispatchId === dispatchId
    && entry?.dispatchId === dispatchId && CONCURRENT_TYPES.has(entry?.type))
  const explainableIds = new Set(explainable.map(entry => entry.id))
  const beats = explainable.filter(entry => entry.type === 'heartbeat')

  // 설명된 변경은 "이 칸이 흔들려도 된다" 가 아니라 "이 쓰기가 이 값으로 만들었어야 한다" 이다.
  const record = `dispatches[${dispatchId}]`
  const expected = new Map()
  if (explainable.length > 0) expected.set('messages#count', JSON.stringify(priorMessages.length + explainable.length))
  if (beats.length > 0) expected.set(`${record}.worker.lastHeartbeatAt`, JSON.stringify(beats[beats.length - 1].createdAt))

  // §4.5 재관측 기록. 값은 못 고정하고(누가 썼는지 문서가 말하지 않는다) `observed: true` 만 받는다.
  const isReconcile = key => key === `${record}.reconcile` || key.startsWith(`${record}.reconcile.`)
  const reconcileObserved = (after?.dispatches ?? []).find(entry => entry.id === dispatchId)?.reconcile?.observed === true
  const reconcileAllowed = reconcileObserved
    && [...added, ...removed, ...changed].some(isReconcile)

  // `updatedAt`·`version` 은 파생 칸이다. 설명된 실질 변경이 **먼저** 있어야, 그리고 앞으로만.
  const substantive = beats.length > 0 || reconcileAllowed
  const forwards = key => {
    if (!substantive) return false
    const from = JSON.parse(left.get(key) ?? 'null'), to = JSON.parse(right.get(key) ?? 'null')
    if (key.endsWith('.version')) return typeof from === 'number' && typeof to === 'number' && to > from
    return typeof to === 'string' && (from === null || (typeof from === 'string' && to >= from))
  }
  const allowedChange = key =>
    (expected.has(key) && expected.get(key) === right.get(key))
    || (isReconcile(key) && reconcileAllowed)
    || ((key === `${record}.updatedAt` || key === `${record}.version`) && forwards(key))

  const messageOf = key => /^messages\[([^\]]+)\]/.exec(key)?.[1] ?? null
  const unexplained = {
    added: added.filter(key => !explainableIds.has(messageOf(key) ?? '') && !(isReconcile(key) && reconcileAllowed)),
    removed: removed.filter(key => !(isReconcile(key) && reconcileAllowed)),
    changed: changed.filter(key => !allowedChange(key)),
  }
  return {
    dispatchId,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
    explainedBy: explainable.map(entry => ({ id: entry.id, type: entry.type, at: entry.createdAt, from: entry.from?.kind ?? null })),
    reconcile: { touched: [...added, ...removed, ...changed].some(isReconcile), observedTrue: reconcileObserved, allowed: reconcileAllowed },
    ignored: appeared.filter(entry => !explainableIds.has(entry.id))
      .map(entry => ({ id: entry.id, type: entry.type, from: entry.from?.kind ?? null, dispatchId: entry.dispatchId ?? null })),
    added, removed, changed, unexplained,
    clean: unexplained.added.length === 0 && unexplained.removed.length === 0 && unexplained.changed.length === 0,
  }
}

// --- 기록 (C3d) -----------------------------------------------------------------------------------
//
// 키 단위로 무엇이 바뀌었는지 남기되, 값은 **허용 목록**으로 거른다. 거부 목록이 아니라 허용 목록인
// 이유는 메시지 `body`·`payload` 에 워커가 타이핑한 아무 문자열이나 들어올 수 있기 때문이다 — 로컬
// 경로를 적지 않는다는 LIFE-426 규칙을 "무엇이 경로처럼 보이나" 로 지키면 언젠가 새는 모양이 나온다.
// 통과하는 것은 수·불리언·null·ISO 시각·corral id·짧은 소문자 낱말·64자 hex 뿐이고, 나머지는 전부
// 그 값의 sha256 앞 12자로 적는다. 두 값이 같은지 다른지는 digest 로도 그대로 보인다.
const SAFE_STRING = [
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/,          // ISO 시각
  /^(msg|ctx|task|run|delivery)_[0-9a-f]+$/, // corral id
  /^[a-z][a-z_]{0,31}$/,                    // 상태 낱말 (dispatched·completed·worker·settled …)
  /^[0-9a-f]{64}$/,                         // sha256
]
const digest12 = text => 'sha256:' + createHash('sha256').update(text).digest('hex').slice(0, 12)
const safeValue = json => {
  if (json === undefined) return null
  let parsed
  try { parsed = JSON.parse(json) } catch { return digest12(json) }
  if (parsed === null || typeof parsed === 'number' || typeof parsed === 'boolean') return parsed
  if (typeof parsed === 'string' && SAFE_STRING.some(shape => shape.test(parsed))) return parsed
  return digest12(json)
}
/** 키에도 워커가 정한 이름(`--payload` 의 키)이 섞일 수 있다. 같은 이유로 허용 목록으로 거른다. */
const safeKey = key => /^[A-Za-z0-9_.#[\]-]+$/.test(key) ? key : digest12(key)

/** 판정과 기록에 쓰는 형태. 통과하든 실패하든 남긴다 — 통과한 회차의 설명도 증거다. */
export function describeDelta(delta, before, after) {
  const left = flattenState(before), right = flattenState(after)
  const rows = keys => keys.map(key => ({ key: safeKey(key), before: safeValue(left.get(key)), after: safeValue(right.get(key)) }))
  return {
    dispatchId: delta.dispatchId,
    clean: delta.clean,
    counts: delta.counts,
    explainedBy: delta.explainedBy,
    reconcile: delta.reconcile,
    ignored: delta.ignored,
    unexplained: { added: rows(delta.unexplained.added), removed: rows(delta.unexplained.removed), changed: rows(delta.unexplained.changed) },
    // 설명된 변경도 값까지 적는다 — "무엇이 흔들렸고 무엇이 그것을 설명했나" 가 이 기록의 전부다.
    explainedChanges: rows(delta.changed.filter(key => !delta.unexplained.changed.includes(key))),
    addedMessages: delta.added.filter(key => key.startsWith('messages[')).length,
  }
}
