// 두 스냅샷을 견주는 순수 함수. **여기는 I/O 도 CDP 도 모른다** — 그래서 단위 테스트가 붙는다(C4).
//
// 판정의 뼈대: 짝이 안 맞으면 스타일 델타가 아니라 **추가/삭제**로 보고한다(K7).
// 한쪽에 없는 요소의 색을 견주는 것은 의미가 없고, 그 행이 스타일 차이로 섞이면
// "구조가 다르다" 는 가장 큰 차이가 잔글씨에 묻힌다.

/** 차이 한 건의 종류. 순서가 곧 보고 순서이자 심각도다. */
/** probe 가 부모당 재는 자식 상한 (`probe.mjs` MAX_ITEMS 와 같은 값). */
export const MAX_CHILDREN = 12

export const KINDS = ['unpaired', 'selector-miss', 'missing', 'count', 'truncated', 'box', 'style', 'font']

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
 * 한 요소의 폰트 수집 상태 (G7). **「같다」와 「못 쟀다」를 가른다** — 이전 판은 수집 실패
 * (`platformFonts` 없음·CDP 오류)를 `null` 로 돌려 차이 0 과 같은 자리에 넣었다.
 */
export function fontState(item) {
  if (!item || item.present === false) return { state: 'absent', why: '그 자리에 요소가 없다' }
  if (item.fontsError) return { state: 'error', why: `수집 실패: ${item.fontsError}` }
  if (!Array.isArray(item.platformFonts)) return { state: 'uncollected', why: '이 요소의 렌더 폰트를 받지 못했다' }
  const families = [...new Set(item.platformFonts.map((font) => font.family))].sort()
  if (families.length === 0) return { state: 'noglyph', why: '글리프가 없다 (그릴 글자가 없는 요소)' }
  return { state: 'ok', families }
}

/**
 * 요소 한 쌍의 렌더 폰트 판정. 셋 중 하나를 돌려준다:
 * `null`(같다) · `{kind:'differs'}`(차이) · `{kind:'unmeasured', why}`(공백 — 사유와 함께).
 */
export function diffItemFonts(leftItem, rightItem) {
  const a = fontState(leftItem)
  const b = fontState(rightItem)
  if (a.state === 'ok' && b.state === 'ok') {
    if (a.families.join(', ') === b.families.join(', ')) return null
    return { kind: 'differs', left: a.families.join(', '), right: b.families.join(', ') }
  }
  return {
    kind: 'unmeasured',
    left: a.state === 'ok' ? a.families.join(', ') : `(${a.why})`,
    right: b.state === 'ok' ? b.families.join(', ') : `(${b.why})`,
    why: [a.state === 'ok' ? null : `orca: ${a.why}`, b.state === 'ok' ? null : `corral: ${b.why}`].filter(Boolean).join(' · ')
  }
}

/**
 * 스냅샷 한 쌍을 견준다.
 *
 * @param left  기준 쪽 스냅샷 (보통 Orca)
 * @param right 견주는 쪽 스냅샷 (보통 corral)
 * @param options.tolerance 박스 허용치 px
 * @param options.units 영역 정의의 단위 목록 — 보고 순서와 설명을 여기서 가져온다
 */
// 차이 한 건의 자리 — 부모 순번(`index`)과, 둘째 이후 자식이면 자식 순번(`childIndex`, R4).
const position = (pair) => ({ ...(pair.index > 0 ? { index: pair.index } : {}), ...(pair.childIndex > 0 ? { childIndex: pair.childIndex } : {}) })

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
  // 렌더 폰트를 **요청한 단위**만 폰트 판정에 넣는다 (G7). `props` 에 `text` 가 없는 단위(점·아이콘)는
  // 애초에 폰트를 재지 않으므로 「못 쟀다」가 아니라 **해당 없음**이다 — 공백 표가 그것으로 차면
  // 정작 봐야 할 수집 실패가 묻힌다.
  const fontsRequested = new Set(
    units.filter((unit) => (unit.props ?? ['box', 'paint', 'text']).includes('text')).map((unit) => unit.id)
  )
  const wantsFonts = (id) => units.length === 0 || fontsRequested.has(id)

  const ids = order ?? [...new Set([...Object.keys(left.elements ?? {}), ...Object.keys(right.elements ?? {})])]
  // 자기 diff(C5)는 **같은 앱을 두 번 찍은 것**이다. 짝짓기 불가·양쪽 선택자 부재는 두 앱을 견줄 때의
  // 성질이지 캡처의 흔들림이 아니라서, 자기 diff 에서는 세지 않는다 — 세면 잡음 바닥이 거짓으로 오른다.
  const self = options.self === true || options.includeUnpaired === false
  const findings = []
  const belowTolerance = []
  const fontUnmeasured = []
  /** 잰 요소 목록. 예전 모양(첫 요소가 record 에 펼쳐진 것)도 받아 준다. */
  const itemsOf = (record) => {
    if (Array.isArray(record?.items) && record.items.length > 0) return record.items
    return record?.box ? [{ index: 0, present: true, box: record.box, style: record.style, platformFonts: record.platformFonts }] : []
  }
  for (const id of ids) {
    const a = left.elements?.[id]
    const b = right.elements?.[id]
    const note = noteById.get(id) ?? null
    // **짝을 못 지은 것과 없는 것은 다르다.** 한쪽 앱에 안정적인 선택자가 없어서 못 잰 단위를
    // "없음" 으로 적으면 그것은 거짓 차이다 — 447~450 이 없는 것을 만들러 간다.
    const unpaired = unpairedById.get(id)
    if (unpaired) {
      if (!self) findings.push({ id, note, kind: 'unpaired', detail: { reason: unpaired } })
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
      const declared = absentRecord?.declaredAbsent === true
      const kind = declared || conditionalById.has(id) ? 'missing' : 'selector-miss'
      findings.push({
        id,
        note,
        kind,
        detail: {
          left: leftPresent ? `있음 (${a.count})` : a?.declaredAbsent ? '없음(선언)' : '없음(선택자 0개)',
          right: rightPresent ? `있음 (${b.count})` : b?.declaredAbsent ? '없음(선언)' : '없음(선택자 0개)',
          absentSide,
          // 표기가 두 뜻을 다시 합치지 않게 **어느 부재인지**를 값으로 남긴다 (R2-L1).
          absence: declared ? 'declared' : conditionalById.has(id) ? 'conditional' : 'selector'
        }
      })
      continue // 한쪽에 없으면 박스·스타일은 견주지 않는다 (K7)
    }
    if (!leftPresent) {
      // **양쪽 다 0개**다. 선언된 부재나 조건부 부재면 차이가 아니지만, 필수 단위가 양쪽에서
      // 0개면 그것은 「같다」가 아니라 **측정 실패**다 (G6) — 선택자 오타·양쪽 DOM 변경이 이 모양이다.
      const declared = a?.declaredAbsent === true || b?.declaredAbsent === true
      if (!self && !declared && !conditionalById.has(id)) {
        findings.push({
          id,
          note,
          kind: 'selector-miss',
          detail: { left: '없음(선택자 0개)', right: '없음(선택자 0개)', absentSide: 'both', absence: 'selector' }
        })
      }
      continue
    }

    if (a.count !== b.count) {
      findings.push({ id, note, kind: 'count', detail: { left: a.count, right: b.count } })
    }

    // ---- 요소 짝짓기 -------------------------------------------------------
    // **부모 단위로 묶는다** (G2). 부모(탭·카드)의 순번을 키로 쓰고 그 **안에서** 자식을 견준다.
    // 전역 순번으로 묶으면 자식이 없는 부모를 건너뛰며 다른 탭끼리 비교된다 — 최종 보고서에
    // x −122.78px 같은 거짓 차이가 실렸다.
    const parentScoped = a.parentScoped === true || b.parentScoped === true
    const leftItems = itemsOf(a)
    const rightItems = itemsOf(b)
    const pairs = []
    if (parentScoped) {
      // **부모별 실제 자식 수**를 먼저 견준다 (fix-r2 S2). 짝은 잰 자식(부모당 상한까지)끼리만 지어지므로, 상한 뒤에만 있는
      // 자식·자식 수 차이는 짝짓기로는 안 보인다. `childCounts` 가 없는 예전 원자료는 잰 자식의 `siblings` 로 읽는다.
      const countsOf = ({ record, items }) => {
        if (Array.isArray(record?.childCounts)) return record.childCounts
        const counts = []
        for (const item of items) {
          if (!Number.isFinite(item.parentIndex)) continue
          counts[item.parentIndex] = item.present === false ? 0 : Number.isFinite(item.siblings) ? item.siblings : 1
        }
        return counts
      }
      const leftCounts = countsOf({ record: a, items: leftItems })
      const rightCounts = countsOf({ record: b, items: rightItems })
      for (let parentIndex = 0; parentIndex < Math.max(leftCounts.length, rightCounts.length); parentIndex += 1) {
        const left = leftCounts[parentIndex] ?? null
        const right = rightCounts[parentIndex] ?? null
        // 부모 자체가 한쪽에만 있으면 아래 짝짓기가 「부모 자체가 없음」으로 적는다 — 여기서 겹쳐 세지 않는다.
        if (left === null || right === null) continue
        // 한쪽이 0 이면 그 부모 안의 부재다 — 아래 짝짓기가 `missing` 으로 적으니 겹쳐 세지 않는다.
        if (left !== right && left > 0 && right > 0) {
          findings.push({ id, note, kind: 'count', ...(parentIndex > 0 ? { index: parentIndex } : {}), detail: { left, right, parentIndex, scope: 'children' } })
        }
        if (left > MAX_CHILDREN || right > MAX_CHILDREN) {
          // 상한 뒤 자식은 **못 쟀다** — 「차이 없음」이 아니라 미측정이다.
          findings.push({ id, note, kind: 'truncated', ...(parentIndex > 0 ? { index: parentIndex } : {}), detail: { left, right, parentIndex, measured: MAX_CHILDREN } })
        }
      }
      // **(부모, 자식) 짝 전부**를 견준다 (R4). 자식 순번이 없는 예전 원자료는 첫 자식(0)이다.
      const childOf = (item) => (Number.isFinite(item.childIndex) ? item.childIndex : 0)
      const keyOf = (item) => `${item.parentIndex}:${childOf(item)}`
      const keys = [...new Map([...leftItems, ...rightItems].filter((item) => Number.isFinite(item.parentIndex)).map((item) => [keyOf(item), item])).values()]
        .map((item) => ({ parentIndex: item.parentIndex, childIndex: childOf(item) }))
        .sort((x, y) => x.parentIndex - y.parentIndex || x.childIndex - y.childIndex)
      const parentOn = (items, parentIndex) => items.some((item) => item.parentIndex === parentIndex)
      for (const key of keys) {
        const find = (items) => items.find((item) => item.parentIndex === key.parentIndex && childOf(item) === key.childIndex) ?? null
        // 부모는 있는데 그 순번의 자식 기록이 없으면 **그 부모 안의 부재**다 — 부모 자체의 부재와 가른다.
        const side = (items) => find(items) ?? (parentOn(items, key.parentIndex) ? { parentIndex: key.parentIndex, childIndex: key.childIndex, present: false } : null)
        pairs.push({
          index: key.parentIndex,
          childIndex: key.childIndex,
          label: `부모 ${key.parentIndex} · 자식 ${key.childIndex}`,
          left: side(leftItems),
          right: side(rightItems)
        })
      }
    } else {
      const count = Math.min(leftItems.length, rightItems.length)
      for (let index = 0; index < count; index += 1) {
        pairs.push({ index, label: `${index}번째`, left: leftItems[index], right: rightItems[index] })
      }
    }

    for (const pair of pairs) {
      const l = pair.left
      const r = pair.right
      const lHas = Boolean(l && l.present !== false)
      const rHas = Boolean(r && r.present !== false)
      if (lHas !== rHas) {
        // **부모 안에서의 부재**다. 부모끼리는 짝이 맞고 그 안에 자식이 한쪽만 있다 —
        // 다른 부모의 자식과 비교하는 것보다 이것이 사실이다.
        findings.push({
          id,
          note,
          kind: 'missing',
          ...position(pair),
          detail: {
            left: lHas ? '있음' : l ? '없음(그 부모 안에 없음)' : '없음(부모 자체가 없음)',
            right: rHas ? '있음' : r ? '없음(그 부모 안에 없음)' : '없음(부모 자체가 없음)',
            absentSide: lHas ? 'right' : 'left',
            absence: parentScoped ? 'parent-scoped' : 'selector',
            parentIndex: parentScoped ? pair.index : undefined,
            childIndex: parentScoped ? pair.childIndex : undefined
          }
        })
        continue
      }
      if (!lHas) continue // 그 부모 안에 양쪽 다 없다 = 차이 없음

      const boxDiff = diffBoxWithBelow(l.box, r.box, tolerance)
      if (boxDiff.over.length > 0) {
        findings.push({ id, note, kind: 'box', detail: boxDiff.over, ...position(pair) })
      }
      if (boxDiff.below.length > 0) {
        // 판정에서 빼되 **세기는 한다** — 허용치가 무엇을 가렸는지 보고서에 남는다.
        belowTolerance.push({ id, note, index: pair.index, ...(pair.childIndex > 0 ? { childIndex: pair.childIndex } : {}), detail: boxDiff.below })
      }
      const styleDiff = diffStyle(l.style, r.style)
      if (styleDiff.length > 0) {
        findings.push({ id, note, kind: 'style', detail: styleDiff, ...position(pair) })
      }
      // 렌더 폰트 (F14·G7) — **요소마다** 본다. 선언값과 따로 내고, 못 쟀으면 공백(사유)로 적는다.
      const fonts = wantsFonts(id) ? diffItemFonts(l, r) : null
      if (fonts && fonts.kind === 'differs') {
        findings.push({ id, note, kind: 'font', detail: fonts, ...position(pair) })
      } else if (fonts) {
        fontUnmeasured.push({ id, note, index: pair.index, ...(pair.childIndex > 0 ? { childIndex: pair.childIndex } : {}), detail: fonts })
      }
    }
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
  return diffSnapshots(first, second, { ...options, self: true, includeUnpaired: false })
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

/**
 * 캡처 하나가 **폰트를 못 잰** 사유들 — 관문 문자열로 낸다 (H2).
 *
 * 왜 순수 함수인가: 이 판단이 틀리면 「폰트가 같다」와 「폰트를 못 쟀다」가 한 칸에 섞인다.
 * 이전 판은 바깥 try 가 정상 종료하면 `fontsCollected:true` 였고, 요소별 실패는 아이템에만
 * 적혔다 — 특히 자기 대조의 **B 캡처**에서만 실패하면 본 보고서에도 총계에도 흔적이 없었다
 * (리뷰 R3-02). 여기서 나온 줄은 전부 관문 사유가 되고, 그래서 반례를 단위 테스트로 세울 수 있다.
 *
 * 글리프가 없는 노드(빈 배열)는 **정상**이다 — 실패로 세지 않는다.
 */
export function fontCaptureFailures(label, meta) {
  const out = []
  if (!meta) return out
  if (meta.fontsCollected === false) out.push(`${label}: ${meta.platformFontsError ?? '사유 미기재'}`)
  const perElement = meta.fontErrors ?? []
  if (perElement.length > 0) {
    const head = perElement
      .slice(0, 3)
      .map((entry) => `${entry.key}: ${entry.error}`)
      .join(' / ')
    out.push(`${label}: 요소별 폰트 수집 실패 ${perElement.length}건 — ${head}${perElement.length > 3 ? ' …' : ''}`)
  }
  return out
}
