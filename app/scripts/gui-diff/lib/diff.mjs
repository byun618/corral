// 두 스냅샷을 견주는 순수 함수. **여기는 I/O 도 CDP 도 모른다** — 그래서 단위 테스트가 붙는다(C4).
//
// 판정의 뼈대: 짝이 안 맞으면 스타일 델타가 아니라 **추가/삭제**로 보고한다(K7).
// 한쪽에 없는 요소의 색을 견주는 것은 의미가 없고, 그 행이 스타일 차이로 섞이면
// "구조가 다르다" 는 가장 큰 차이가 잔글씨에 묻힌다.

/** 차이 한 건의 종류. 순서가 곧 보고 순서이자 심각도다. */
export const KINDS = ['unpaired', 'missing', 'count', 'box', 'style']

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * 박스 비교. `tolerance` px 이내는 같다고 본다.
 *
 * 왜 허용치가 필요한가: 서브픽셀 레이아웃은 같은 앱을 두 번 찍어도 0.01px 씩 흔들린다.
 * 허용치의 **값 자체는 여기서 정하지 않는다** — C5 잡음 대조가 실측으로 정하고 호출자가 넘긴다.
 */
export function diffBox(left, right, tolerance) {
  if (!left || !right) return []
  const out = []
  for (const key of ['x', 'y', 'w', 'h']) {
    const a = num(left[key])
    const b = num(right[key])
    if (a === null || b === null) {
      if (a !== b) out.push({ prop: key, left: left[key] ?? null, right: right[key] ?? null, delta: null })
      continue
    }
    const delta = Math.round((b - a) * 100) / 100
    if (Math.abs(delta) > tolerance) out.push({ prop: key, left: a, right: b, delta })
  }
  return out
}

/** 스타일 비교. 한쪽에만 있는 속성도 차이다 — 조용히 건너뛰면 "안 쟀다" 가 "같다" 로 읽힌다. */
export function diffStyle(left, right) {
  if (!left || !right) return []
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
  const out = []
  for (const prop of keys) {
    const a = left[prop]
    const b = right[prop]
    if (a === b) continue
    out.push({ prop, left: a ?? null, right: b ?? null })
  }
  return out
}

/**
 * 스냅샷 한 쌍을 견준다.
 *
 * @param left  기준 쪽 스냅샷 (보통 Orca)
 * @param right 견주는 쪽 스냅샷 (보통 corral)
 * @param options.tolerance 박스 허용치 px
 * @param options.units 영역 정의의 단위 목록 — 보고 순서와 설명을 여기서 가져온다
 */
export function diffSnapshots(left, right, options = {}) {
  const tolerance = options.tolerance ?? 0
  const units = options.units ?? []
  const order = units.length > 0 ? units.map((unit) => unit.id) : null
  const noteById = new Map(units.map((unit) => [unit.id, unit.note ?? null]))
  const unpairedById = new Map(units.filter((unit) => unit.unpaired).map((unit) => [unit.id, unit.unpaired]))

  const ids = order ?? [...new Set([...Object.keys(left.elements ?? {}), ...Object.keys(right.elements ?? {})])]
  const findings = []
  for (const id of ids) {
    const a = left.elements?.[id]
    const b = right.elements?.[id]
    const note = noteById.get(id) ?? null
    // **짝을 못 지은 것과 없는 것은 다르다.** 한쪽 앱에 안정적인 선택자가 없어서 못 잰 단위를
    // "없음" 으로 적으면 그것은 거짓 차이다 — 447~450 이 없는 것을 만들러 간다.
    const unpaired = unpairedById.get(id)
    if (unpaired) {
      // 자기 diff(C5 잡음 바닥)에서는 건너뛴다. 짝짓기 불가는 **두 앱을 견줄 때의 성질**이지
      // 같은 앱을 두 번 찍은 것 사이의 흔들림이 아니다 — 여기에 세면 잡음 바닥이 거짓으로 오른다.
      if (options.includeUnpaired !== false) findings.push({ id, note, kind: 'unpaired', detail: { reason: unpaired } })
      continue
    }
    // 둘 다 안 쟀다 — 영역 정의에는 있는데 스냅샷에 없는 경우다. 조용히 넘기지 않는다.
    if (!a && !b) {
      findings.push({ id, note, kind: 'missing', detail: { left: 'unmeasured', right: 'unmeasured' } })
      continue
    }
    const leftPresent = Boolean(a?.present)
    const rightPresent = Boolean(b?.present)
    if (leftPresent !== rightPresent) {
      findings.push({
        id,
        note,
        kind: 'missing',
        detail: { left: leftPresent ? `있음 (${a.count})` : '없음', right: rightPresent ? `있음 (${b.count})` : '없음' }
      })
      continue // 한쪽에 없으면 박스·스타일은 견주지 않는다 (K7)
    }
    if (!leftPresent) continue // 둘 다 없다 = 차이 없음

    if (a.count !== b.count) {
      findings.push({ id, note, kind: 'count', detail: { left: a.count, right: b.count } })
    }
    const box = diffBox(a.box, b.box, tolerance)
    if (box.length > 0) findings.push({ id, note, kind: 'box', detail: box })
    const style = diffStyle(a.style, b.style)
    if (style.length > 0) findings.push({ id, note, kind: 'style', detail: style })
  }
  return {
    left: { app: left.app ?? null, meta: left.meta ?? null },
    right: { app: right.app ?? null, meta: right.meta ?? null },
    tolerance,
    findings,
    summary: KINDS.reduce((acc, kind) => {
      acc[kind] = findings.filter((finding) => finding.kind === kind).length
      return acc
    }, { total: findings.length })
  }
}

/**
 * 잡음 바닥(C5) — 같은 앱을 두 번 찍어 서로 견준다. 차이가 나오면 그만큼은 **도구의 흔들림**이지
 * 앱의 차이가 아니다. 두 앱 비교와 같은 코드를 타야 의미가 있으므로 같은 함수를 부른다.
 */
export function selfDiff(first, second, options = {}) {
  return diffSnapshots(first, second, { ...options, includeUnpaired: false })
}

/**
 * 메타(창 크기·테마·포커스·DPR) 대칭 점검. 여기가 어긋나면 본 diff 의 모든 행이 의심스럽다 —
 * 그래서 차이 목록이 아니라 **경고**로 따로 낸다. 판정 문서 맨 위에 붙는다.
 */
export function compareMeta(left, right) {
  const warnings = []
  const check = (key, label) => {
    const a = left?.meta?.[key]
    const b = right?.meta?.[key]
    if (a !== b) warnings.push({ key, label, left: a ?? null, right: b ?? null })
  }
  check('innerWidth', '창 안쪽 너비')
  check('innerHeight', '창 안쪽 높이')
  check('devicePixelRatio', '픽셀 배율')
  check('hasFocus', '문서 포커스')
  check('prefersDark', '다크 모드 선호')
  if ((left?.meta?.devOverlays ?? 0) > 0 || (right?.meta?.devOverlays ?? 0) > 0) {
    warnings.push({
      key: 'devOverlays',
      label: '개발 서버 **오류 오버레이**가 화면을 덮고 있다 — 이 캡처는 오염됐다',
      left: left?.meta?.devOverlays ?? 0,
      right: right?.meta?.devOverlays ?? 0
    })
  }
  return warnings
}
