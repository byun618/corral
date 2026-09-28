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
// 설명이 되는 것은 **하나**다: 이 attempt 의 pane 이 저 자신 이름으로 쓴, 보고가 아닌 메시지.
// `from.kind === 'worker'` 이고 `from.dispatchId` 와 `dispatchId` 가 검사 중인 attempt 이며 종류가
// heartbeat·question·status·escalation 인 것. `worker_done` 은 없다 — 그래서 이 비교는 "정산된 워커가
// 다시 보고할 수 없다" 자리에서도 그대로 쓸 수 있고, 거기서 막아야 할 쓰기가 바로 그것이다.
//
// 그리고 설명은 **양방향으로 값에 묶인다** (r2 지적 B). "이 칸이 흔들려도 된다" 가 아니라 "이 쓰기가
// **정확히 이 값으로** 만들었어야 한다" 이고, 그 값이 아니면 — 움직이지 않았더라도 — 실패다:
//
//   messages#count                    == 이전 수 + 설명 가능한 메시지 수
//   dispatches[d].worker.lastHeartbeatAt == 마지막 heartbeat 메시지의 createdAt
//   dispatches[d].updatedAt              == 같은 값
//   dispatches[d].version                == 이전 version + heartbeat 수
//
// heartbeat 가 하나도 없으면 저 세 칸은 **움직여서는 안 된다**. 그래서 설명 없는 `version` 증가(+1 이든
// +50 이든)도, 미래로 간 `updatedAt` 도, 부작용 없이 덧붙은 heartbeat 메시지도 전부 걸린다.
//
// **재관측 기록(`dispatch.reconcile`)은 대상 안에 있다.** r1 은 이것을 대상에서 뺐다가 A 지적을 받았다 —
// 제품 `index.ts:663` 의 `if (pass.changed && !mutating)` 를 `if (pass.changed)` 로 바꾸면 거절된 호출이
// 제 관측을 문서에 남기는데, 그것을 `clean` 으로 읽었다. 빼야 할 이유가 없다는 것이 계측으로 나왔다
// (`raw/worker/claude/r2/probe/`): 재관측 기록은 **열린 attempt 를 처음 재관측하는 명령 한 번만** 바뀌고,
// 그 뒤로는 heartbeat 를 몇 번 보내든 읽기를 몇 번 하든 그대로다(`changed=false`). 네이티브 관문에서
// F1(a) 창이 열릴 때는 worker-start·worker-show·terminal show 가 이미 지나가 기록이 서 있으므로, 정상
// 창에서는 이 칸이 움직이지 않는다 — r1 의 네이티브 4회(워커 3·코디 1)가 모두 `touched: false` 였다.
// 그러니 이 칸이 창 안에서 움직였다면 그것은 **설명되지 않는 쓰기**이고, 그렇게 읽는다.
//
// 검출력:
//   - 거절이 Task·Dispatch 레코드를 건드리면 → 설명되지 않는 값변경
//   - 거절이 제 재관측을 남기면 → 설명되지 않는 추가·값변경 (A)
//   - 거절이 `version`·`updatedAt` 만 밀면 → 요구값과 어긋난다 (B)
//   - 거절이 새 Dispatch·새 delivery 를 만들면 → 설명되지 않는 추가
//   - 거절이 메시지를 쓰면 → coordinator 자격이라 `from.kind` 가 다르다. 설명되지 않는 추가
//   - 무엇이 지워지는 것은 어느 경우에도 설명되지 않는다
//
// 남는 한계 (r2 지적 L-b 로 문장을 정정한다): 위조의 난이도는 **종류마다 다르다.** `heartbeat` 는
// `lastHeartbeatAt`·`updatedAt`·`version` 을 정확히 맞춰야 설명된 것으로 읽히지만, `status`·`question`·
// `escalation` 은 **요구값이 하나도 없다** — 메시지 한 줄을 워커 자격으로 덧붙이는 것만으로 설명된다.
// 그래서 "요구값까지 맞춰야 한다" 는 heartbeat 에만 해당하는 말이고, 나머지 세 종류에 대해서는
// 이 비교가 위조를 가려내지 못한다. 거절은 coordinator 자격으로 도는 호출이라 그 경로가 실제로
// 있지는 않지만, 비교가 거기까지 증명하지는 않는다. 다만 위조한 메시지 **옆에서** 파생 칸이 움직이면
// 그것은 여전히 걸린다 (음성 대조 `status-message-beside-an-unexplained-version-bump`).
//
// 그리고 이 비교는 **창이 열릴 때의 전제**에 기대고 있다 (r2 지적 H). 재관측 기록은 열린 attempt 를
// **처음** 재관측하는 명령 한 번만 쓰이는데, 그 명령이 창 **안**에 있으면 — 선행 `worker-show` 의 pane
// 관측이 실패해 기록이 서지 못했다가 창 안의 정상 heartbeat 가 도장을 같이 찍는 모양 — 거절이 아무것도
// 쓰지 않았는데도 `version` 이 +2 로 움직여 `clean:false` 가 된다. 바이트로 구분할 방법이 없다.
// 그래서 비교를 느슨하게 하는 대신 **창을 열기 전에 전제를 세운다**: `unobservedOpenAttempts()` 가
// 비어 있어야 창을 연다. 세우지 못하면 관문은 "거절이 썼다" 가 아니라 **"전제 미충족"** 으로 멈춘다.
import { createHash } from 'node:crypto'

/** 같은 바이트에서 digest 와 문서를 함께 뜬다 — 두 번 읽으면 그 사이가 또 창이 된다. */
export const snapshot = bytes => ({
  digest: createHash('sha256').update(bytes).digest('hex'),
  state: JSON.parse(bytes.toString('utf8') || 'null'),
})

/**
 * 원소가 전부 고유한 문자열 `id` 를 가진 배열인가. 그렇다면 위치가 아니라 id 로 키를 잡는다 —
 * 배열 중간에 하나가 끼어들어도 뒤쪽 원소가 통째로 "바뀐 키" 로 보이지 않게.
 *
 * **아니면 위치 키로 돌아간다** (`[0]`, `[1]`, …), 그리고 그때 비교는 더 거칠다 (r3 지적 L-k):
 * `id` 없는 배열(또는 `id` 가 겹치는 배열)에서는 **원소 하나가 앞에 삽입되면 그 뒤 전부가 변경 키로
 * 잡힌다.** 거짓 통과가 아니라 거짓 실패 쪽이라 관문으로는 안전한 방향이지만, 문서가 그 모양이 되면
 * 「거절이 아무것도 저장하지 않는다」의 diff 가 읽기 어려워진다. `state.json` 의 배열
 * (`runs`·`tasks`·`dispatches`·`messages`·`deliveries`)은 전부 고유 `id` 를 가지므로 지금은
 * 늘 id 키다 — 위치 키로 내려가는 것은 스키마가 바뀌었다는 신호다.
 */
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

/**
 * 창을 열기 전 전제 (r2 지적 H): **열린 attempt 는 전부 재관측 기록이 서 있어야 한다.**
 * 서 있지 않은 attempt 의 id 목록을 돌려준다 — 비어 있어야 창을 연다.
 *
 * 열린 attempt 전부를 보는 이유는 L-a 다: 제품의 재관측 훑기(`index.ts:378-383`)는 `status ==='dispatched'`
 * 인 **모든** attempt 에 적용되므로, 창 안에서 다른 attempt 의 첫 도장이 찍혀도 같은 거짓 실패가 난다.
 * 읽기 명령 한 번이 그 전부를 한꺼번에 세운다.
 */
export const unobservedOpenAttempts = state => {
  // r3 지적 L-h. `null` 에 `[]` 를 돌려주면 「문서를 못 읽었다」가 「전제가 섰다」로 읽힌다 —
  // r2 지적 I 를 고친 라운드의 새 코드에 같은 모양이 들어갔다. 문서가 아니면 던진다.
  if (state === null || typeof state !== 'object' || Array.isArray(state))
    throw new TypeError(`unobservedOpenAttempts: 문서가 아니다 (${state === null ? 'null' : typeof state}). `
      + '문서를 못 뜬 것이고, 그것은 "열린 attempt 가 전부 관측됐다" 가 아니다.')
  return (state.dispatches ?? [])
    .filter(entry => entry?.status === 'dispatched' && entry?.reconcile?.observed !== true)
    .map(entry => entry.id)
}

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
  // r2 지적 I. 「본 것이 없다」를 「깨끗하다」로 읽지 않는다.
  // 문서가 아예 아니면 그것은 이 함수를 잘못 부른 것이다 — 조용히 통과시키지 않고 던진다.
  const document = (value, side) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError(`refusalDelta: ${side} 가 문서가 아니다 (${value === null ? 'null' : typeof value}). `
        + '두 관측 중 하나를 못 뜬 것이고, 그것은 "아무것도 안 바뀌었다" 가 아니다.')
    return value
  }
  document(before, 'before'); document(after, 'after')
  // 검사 중인 attempt 가 양쪽 문서 어디에도 없으면 비교할 대상이 없다. 실패다.
  const present = side => (side?.dispatches ?? []).some(entry => entry?.id === dispatchId)
  const unobservable = present(before) || present(after) ? [] : [`dispatches[${dispatchId}]`]

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

  // 요구값: 관측된 동시 쓰기가 문서를 **정확히 이 값으로** 만들었어야 한다. 값이 다르면 실패이고,
  // 움직이지 않았어도 실패다 — 양쪽을 다 봐야 "부작용 없는 heartbeat" 가 걸린다 (B).
  const record = `dispatches[${dispatchId}]`
  const priorVersion = (before?.dispatches ?? []).find(entry => entry.id === dispatchId)?.version
  const required = new Map()
  if (explainable.length > 0) required.set('messages#count', JSON.stringify(priorMessages.length + explainable.length))
  if (beats.length > 0) {
    const at = beats[beats.length - 1].createdAt
    required.set(`${record}.worker.lastHeartbeatAt`, JSON.stringify(at))
    required.set(`${record}.updatedAt`, JSON.stringify(at))
    if (typeof priorVersion === 'number') required.set(`${record}.version`, JSON.stringify(priorVersion + beats.length))
  }
  /** 요구했는데 그 값이 아닌 칸. `changed` 에 없어도 (= 안 움직였어도) 걸린다. */
  const mismatched = [...required.keys()].filter(key => right.get(key) !== required.get(key)).sort()

  const messageOf = key => /^messages\[([^\]]+)\]/.exec(key)?.[1] ?? null
  const unexplained = {
    added: added.filter(key => !explainableIds.has(messageOf(key) ?? '')),
    removed,
    changed: changed.filter(key => !(required.has(key) && required.get(key) === right.get(key))),
    mismatched,
  }
  return {
    dispatchId,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
    explainedBy: explainable.map(entry => ({ id: entry.id, type: entry.type, at: entry.createdAt, from: entry.from?.kind ?? null })),
    reconcile: { touched: [...added, ...removed, ...changed].some(key => key === `${record}.reconcile` || key.startsWith(`${record}.reconcile.`)), inScope: true },
    /**
     * r3 지적 M(R3). 창 안에서 재관측 **이유가 바뀌면** (`pane_live` → `pane_gone` 등)
     * `applyReconcile` 의 멱등이 풀려 attempt 가 `unknown` 으로 정산되고 `status`·`settledBy`·
     * `settledAt`·`version` 이 함께 움직인다 (`model.ts:313,316`). 그것은 거절의 쓰기가 아니라
     * **pane 이 사라진 것**이다. `clean` 은 여전히 거짓이지만(문서는 실제로 움직였다) 호출부가
     * 「거절이 썼다」가 아닌 문장을 고를 수 있도록 원인을 따로 내준다 — H 가 고친 것과 같은 종류의
     * 오귀속을 여기서도 막는다.
     */
    settledInWindow: (after?.dispatches ?? []).filter(entry => {
      const was = (before?.dispatches ?? []).find(older => older.id === entry.id)
      return was?.status === 'dispatched' && entry.status !== 'dispatched' && entry.settledBy === 'reconcile'
    }).map(entry => ({ id: entry.id, status: entry.status, reason: entry.reconcile?.reason ?? null })),
    required: Object.fromEntries([...required].map(([key, value]) => [key, JSON.parse(value)])),
    ignored: appeared.filter(entry => !explainableIds.has(entry.id))
      .map(entry => ({ id: entry.id, type: entry.type, from: entry.from?.kind ?? null, dispatchId: entry.dispatchId ?? null })),
    unobservable,
    added, removed, changed, unexplained,
    clean: unobservable.length === 0 && unexplained.added.length === 0 && unexplained.removed.length === 0
      && unexplained.changed.length === 0 && unexplained.mismatched.length === 0,
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
    /** 비어 있지 않으면 「비교할 대상을 못 봤다」이고, 그것은 통과가 아니다 (r2 지적 I). */
    unobservable: delta.unobservable,
    /** 비어 있지 않으면 창 안에서 pane 이 사라져 attempt 가 정산된 것이다 (r3 지적 M). */
    settledInWindow: delta.settledInWindow,
    ignored: delta.ignored,
    unexplained: { added: rows(delta.unexplained.added), removed: rows(delta.unexplained.removed),
      changed: rows(delta.unexplained.changed), mismatched: rows(delta.unexplained.mismatched) },
    required: delta.required,
    // 설명된 변경도 값까지 적는다 — "무엇이 흔들렸고 무엇이 그것을 설명했나" 가 이 기록의 전부다.
    explainedChanges: rows(delta.changed.filter(key => !delta.unexplained.changed.includes(key))),
    addedMessages: delta.added.filter(key => key.startsWith('messages[')).length,
  }
}
