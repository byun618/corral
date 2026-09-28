// 두 스냅샷을 견주는 순수 함수. **여기는 I/O 도 CDP 도 모른다** — 그래서 단위 테스트가 붙는다(C4).
//
// 판정의 뼈대: 짝이 안 맞으면 스타일 델타가 아니라 **추가/삭제**로 보고한다(K7).
// 한쪽에 없는 요소의 색을 견주는 것은 의미가 없고, 그 행이 스타일 차이로 섞이면
// "구조가 다르다" 는 가장 큰 차이가 잔글씨에 묻힌다.

/** 차이 한 건의 종류. 순서가 곧 보고 순서이자 심각도다. */
export const KINDS = ['unpaired', 'selector-miss', 'missing', 'count', 'box', 'style', 'font']

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * 박스 비교. `tolerance` px 이내는 같다고 본다.
 *
 * 왜 허용치가 필요한가: 서브픽셀 레이아웃은 같은 앱을 두 번 찍어도 0.01px 씩 흔들린다.
 * 허용치의 **값 자체는 여기서 정하지 않는다** — C5 잡음 대조가 실측으로 정하고 호출자가 넘긴다.
 */
export function diffBox(left, right, tolerance) {
  return diffBoxWithBelow(left, right, tolerance).over
}

/**
 * 박스 비교의 전량 — 허용치를 **넘은 것**(`over`)과 **넘지 않은 것**(`below`)을 함께 돌려준다.
 *
 * 왜 below 를 버리지 않는가 (F12): 허용치 이하 차이는 판정에서 빼는 것이 맞지만, 보고서에서
 * 사라지면 "0.5px 이하는 아예 없었다" 로 읽힌다. 건수로 남겨서 허용치가 무엇을 가렸는지 보이게 한다.
 *
 * 반올림은 **부호 대칭**이다: `Math.round` 는 half 를 +∞ 로 보내므로 +0.505 는 0.51(차이),
 * -0.505 는 -0.50(허용치 통과)으로 갈렸다 (G7). 절댓값으로 반올림하고 부호를 되돌린다.
 */
export function diffBoxWithBelow(left, right, tolerance) {
  if (!left || !right) return { over: [], below: [] }
  const over = []
  const below = []
  for (const key of ['x', 'y', 'w', 'h']) {
    const a = num(left[key])
    const b = num(right[key])
    if (a === null || b === null) {
      if (a !== b) over.push({ prop: key, left: left[key] ?? null, right: right[key] ?? null, delta: null })
      continue
    }
    const raw = b - a
    const delta = Math.sign(raw) * (Math.round(Math.abs(raw) * 100) / 100)
    if (Math.abs(delta) > tolerance) over.push({ prop: key, left: a, right: b, delta })
    else if (delta !== 0) below.push({ prop: key, left: a, right: b, delta })
  }
  return { over, below }
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
 * 렌더 폰트 비교 (F14). `CSS.getPlatformFontsForNode` 가 준 **실제로 찍힌 폰트**다 —
 * `font-family` 선언값과 다른 축이고, 선언이 같아도 렌더가 갈릴 수 있다(반대도 가능).
 *
 * 글리프 수는 견주지 않는다: 두 앱의 문구가 다르면 글자 수가 달라 항상 차이가 된다.
 * **가족 이름의 집합**만 본다. 한쪽이 빈 목록이면 「그 노드에 글리프가 없다」는 뜻이라
 * 차이가 아니라 `측정 안 됨` 으로 적는다.
 */
export function diffFonts(left, right) {
  const families = (list) => (Array.isArray(list) ? [...new Set(list.map((font) => font.family))].sort() : null)
  const a = families(left)
  const b = families(right)
  if (a === null || b === null) return null
  if (a.length === 0 || b.length === 0) {
    return { kind: 'unmeasured', left: a.join(', ') || '(글리프 없음)', right: b.join(', ') || '(글리프 없음)' }
  }
  if (a.join(', ') === b.join(', ')) return null
  return { kind: 'differs', left: a.join(', '), right: b.join(', ') }
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
  // **조건부로 그려지는 단위**는 0개를 찾는 것이 정상이다 (임계·hover·상태 의존). 그 자리를
  // 선택자 부패로 읽으면 알려진 제품 차이(C6ⓐ 의 묶음 알약 같은 것)가 측정 실패로 둔갑한다.
  // 반대로 구조 단위(껍데기·검색 줄)가 0개면 그것은 부패다 — 그래서 **영역 정의가 선언한다.**
  const conditionalById = new Set(units.filter((unit) => unit.conditional).map((unit) => unit.id))

  const ids = order ?? [...new Set([...Object.keys(left.elements ?? {}), ...Object.keys(right.elements ?? {})])]
  const findings = []
  const belowTolerance = []
  const fontUnmeasured = []
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
      // **선언상 없음**과 **선택자가 0개를 찾음**은 다르다 (F11). 앞은 짝짓기 파일의 선언이고,
      // 뒤는 선택자 부패 — 447~450 이 DOM 을 고친 뒤에 예정된 사건이다. 뒤엣것을 차이로 내보내면
      // 「corral 에 없음」이라는 거짓 차이가 나간다. 그래서 종류를 갈라 내고, 관문도 따로 본다.
      const absentSide = leftPresent ? 'right' : 'left'
      const absentRecord = leftPresent ? b : a
      const kind = absentRecord?.declaredAbsent === true || conditionalById.has(id) ? 'missing' : 'selector-miss'
      findings.push({
        id,
        note,
        kind,
        detail: {
          left: leftPresent ? `있음 (${a.count})` : absentRecord === a && a?.declaredAbsent ? '없음(선언)' : '없음(선택자 0개)',
          right: rightPresent ? `있음 (${b.count})` : absentRecord === b && b?.declaredAbsent ? '없음(선언)' : '없음(선택자 0개)',
          absentSide
        }
      })
      continue // 한쪽에 없으면 박스·스타일은 견주지 않는다 (K7)
    }
    if (!leftPresent) continue // 둘 다 없다 = 차이 없음

    if (a.count !== b.count) {
      findings.push({ id, note, kind: 'count', detail: { left: a.count, right: b.count } })
    }
    // **걸린 요소를 전부 순번으로 견준다** (F7). 이전 판은 첫 요소만 봐서 둘째 이후 카드·행·탭의
    // 차이가 본 diff 와 자기 diff 모두에서 0 이었다. 개수가 다르면 겹치는 순번까지만 본다 —
    // 개수 차이는 위에서 이미 한 건으로 나갔다.
    const leftItems = Array.isArray(a.items) && a.items.length > 0 ? a.items : a.box ? [{ box: a.box, style: a.style }] : []
    const rightItems = Array.isArray(b.items) && b.items.length > 0 ? b.items : b.box ? [{ box: b.box, style: b.style }] : []
    const pairs = Math.min(leftItems.length, rightItems.length)
    for (let index = 0; index < pairs; index += 1) {
      const boxDiff = diffBoxWithBelow(leftItems[index].box, rightItems[index].box, tolerance)
      if (boxDiff.over.length > 0) {
        findings.push({ id, note, kind: 'box', detail: boxDiff.over, ...(index > 0 ? { index } : {}) })
      }
      if (boxDiff.below.length > 0) {
        // 판정에서 빼되 **세기는 한다** — 허용치가 무엇을 가렸는지 보고서에 남는다.
        belowTolerance.push({ id, note, index, detail: boxDiff.below })
      }
      const styleDiff = diffStyle(leftItems[index].style, rightItems[index].style)
      if (styleDiff.length > 0) {
        findings.push({ id, note, kind: 'style', detail: styleDiff, ...(index > 0 ? { index } : {}) })
      }
    }
    // 렌더 폰트 (F14) — 선언값과 **따로** 낸다.
    const fonts = diffFonts(a.platformFonts, b.platformFonts)
    if (fonts && fonts.kind === 'differs') findings.push({ id, note, kind: 'font', detail: fonts })
    else if (fonts) fontUnmeasured.push({ id, note, detail: fonts })
  }
  return {
    left: { app: left.app ?? null, meta: left.meta ?? null },
    right: { app: right.app ?? null, meta: right.meta ?? null },
    tolerance,
    findings,
    // 허용치가 가린 것과 렌더 폰트를 못 잰 자리 — 차이 목록이 아니라 **기록**이다.
    belowTolerance,
    fontUnmeasured,
    summary: KINDS.reduce((acc, kind) => {
      acc[kind] = findings.filter((finding) => finding.kind === kind).length
      return acc
    }, { total: findings.length, belowTolerance: belowTolerance.length, fontUnmeasured: fontUnmeasured.length })
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
