// 양성 대조 (C6) — **도구가 알려진 차이를 잡는가**를 본다. 순수 함수라 단위 테스트가 붙는다.
//
// 왜 측정의 필수 관문에서 뺐나 (F8): 이전 판은 모든 실행이 사이드바 두 대조를 통과해야 exit 0 이었다.
// 그러면 ① `--areas tabbar` 처럼 정상적인 부분 측정이 "대조 행이 없다" 로 실패하고
// ② 447~450 이 그 차이를 **실제로 해소하면** 도구가 그 회차를 실패로 만든다 — 도구가 해소를 막는다.
// 그래서 대조는 `--controls` 로 **명시할 때만** 돌리고, 일반 측정의 유효성은 그 요청 자체로 판정한다.
//
// 왜 판별력을 따로 시험하나 (F9): 이전 판의 ⓐ 는 `kind === 'missing'` 이기만 하면 통과여서
// **Orca 쪽 선택자가 썩어도**(반대 방향 부재) 통과였고, ⓑ 는 행이 1건이면 통과라 `unpaired`
// (측정 불가)도 통과였다. 「차이가 있다」와 「그 차이를 잡았다」는 다르다.

/** 알려진 차이 둘. `expect` 가 방향·종류까지 적는다 — 여기가 판별력의 전부다. */
export const POSITIVE_CONTROLS = [
  {
    // LIFE-467 K8ⓓ — 옛 ⓐ(에이전트 2개 묶음 알약: Orca 있음 / corral 없음, 임계 2 vs 3)는 S1 이 **해소**했다.
    // 해소되면 뒤집히는 것이 정상이라, 그 뒤집힘은 `specs/LIFE-467-sidebar/raw/claude/k9-diff-before-after.md` 에
    // 원자료와 함께 적고 대조는 **S1 이 건드리지 않는** 알려진 부재로 옮긴다: Orca 전용 상단 내비 묶음.
    id: 'C6ⓐ',
    area: 'sidebar',
    state: 'default',
    unit: 'nav-buttons',
    claim: 'Orca 는 상단 내비 버튼 묶음(작업·자동화·모바일)이 있고 corral 은 없다',
    expect: { kind: 'missing', absentSide: 'right' },
    requires: []
  },
  {
    // LIFE-468 K4ⓕ — 옛 ⓑ(레포 헤더 아이콘: Orca 폴더 vs corral 이니셜 사각형)는 S2 가 **해소**했다(K4ⓐ lucide Folder).
    // 해소되면 뒤집히는 것이 정상이라 옛 정의는 `RESOLVED_CONTROLS` 로 옮겨 **뒤집힘을 회차마다 원자료로 남기고**,
    // 대조는 S2 가 건드리지 않는 알려진 부재로 옮긴다: corral 전용 브랜드 줄(Orca 는 창 크롬 — S4 LIFE-470 몫).
    id: 'C6ⓑ',
    area: 'sidebar',
    state: 'default',
    unit: 'brandbar',
    claim: 'corral 은 상단 브랜드 줄이 있고 Orca 는 없다(창 크롬이 그 자리를 쓴다)',
    expect: { kind: 'missing', absentSide: 'left' },
    requires: []
  }
]

/**
 * **해소로 뒤집힌 대조** — 관문이 아니다. `--controls` 회차마다 `evaluateResolvedControls` 로 상태를 셋으로 갈라 보고서에 남긴다:
 * 판정 불가(미측정·측정 불가 행·한쪽 부재) / 관련 차이 없음(= 해소 유지) / 관련 차이 있음. 「해소 유지」는 두 앱 다 관측됐고
 * 옛 차이를 정의한 속성의 차이가 **하나도** 없을 때만이다 — 양성 대조가 실패했다는 사실만으로는 같아졌다는 증거가 아니다(r1 CDX-R3).
 */
export const RESOLVED_CONTROLS = [
  {
    id: 'C6ⓑ(옛)',
    area: 'sidebar',
    state: 'default',
    unit: 'repo-header-icon',
    claim: '레포 헤더가 Orca 폴더 아이콘(lucide) vs corral 이니셜 사각형 — LIFE-468 K4ⓐ 가 해소',
    // 양쪽 다 있어야 하고, **모양과 칠 둘 다** 달라야 한다 — 1px 박스 차이 하나로는 아이콘 차이가 아니다.
    // 옛 차이를 **정의한 속성만** 본다(R001 원자료: 크기 14↔15 · 배경 칠 · radius 3 · flex · 모노 글꼴 · 색). 해소 뒤에도 남는
    // 영역 공통 y 오프셋(상단 줄 — S4)과 컨테이너 상속 fontSize/lineHeight(글리프 없는 svg — 그릴 글자가 없다)는
    // 아이콘 모양 차이가 아니라서 세지 않는다 — 그 둘로 「다시 잡혔다」고 하면 뒤집힘을 못 본다(iter9 R010).
    expect: {
      bothPresent: true,
      kinds: ['box', 'style'],
      props: ['w', 'h', 'backgroundColor', 'borderTopLeftRadius', 'display', 'fontFamily', 'color']
    },
    requires: [],
    resolvedBy: 'LIFE-468'
  }
]

const DISQUALIFYING = new Set(['unpaired', 'selector-miss', 'truncated'])

/**
 * @param results 영역별 결과 `[{ area, states: [{ state, findings, skipped }] }]`
 * @param prerequisites `{ orcaCompact: boolean, orcaNotSendTarget: boolean }` — 상태 주입이 관측한 값
 * @param controls 기본은 `POSITIVE_CONTROLS`
 */
export function evaluateControls({ results = [], prerequisites = {}, controls = POSITIVE_CONTROLS } = {}) {
  return controls.map((control) => {
    const area = results.find((entry) => entry.area === control.area)
    const state = area?.states?.find((entry) => entry.state === control.state)
    const row = { id: control.id, area: control.area, state: control.state, unit: control.unit, claim: control.claim }

    if (!area || !state || state.skipped) {
      return { ...row, pass: false, evidence: '(그 영역·상태를 재지 않았다)', verdict: '측정 안 됨 — 실패' }
    }
    const onlyProps = control.expect.props ? new Set(control.expect.props) : null
    // `expect.props` 가 있으면 box·style 행은 그 속성이 하나라도 든 행만 센다(존재/부재·측정 불가 행은 그대로).
    const relevant = (finding) =>
      !onlyProps || !Array.isArray(finding.detail) || finding.detail.some((entry) => onlyProps.has(entry.prop))
    const hits = (state.findings ?? []).filter((finding) => finding.id === control.unit && relevant(finding))
    const evidence = hits.length > 0 ? hits.map((hit) => `${hit.kind}: ${JSON.stringify(hit.detail).slice(0, 90)}`).join(' / ') : '(행 없음)'

    const missingPrereq = (control.requires ?? []).filter((key) => prerequisites[key] !== true)
    if (missingPrereq.length > 0) {
      return { ...row, pass: false, evidence, verdict: `전제 미확인(${missingPrereq.join(',')}) — 실패` }
    }
    const blocked = hits.filter((hit) => DISQUALIFYING.has(hit.kind))
    if (blocked.length > 0) {
      return { ...row, pass: false, evidence, verdict: `측정 불가 행(${blocked.map((hit) => hit.kind).join(',')}) — 실패` }
    }
    if (hits.length === 0) {
      return { ...row, pass: false, evidence, verdict: '못 잡았다 — 실패' }
    }

    if (control.expect.kind === 'missing') {
      const hit = hits.find((entry) => entry.kind === 'missing')
      if (!hit) return { ...row, pass: false, evidence, verdict: '존재/부재로 잡히지 않았다 — 실패' }
      if (hit.detail?.absentSide !== control.expect.absentSide) {
        // 방향이 반대면 잡은 것이 아니다 — 우리 쪽 선택자가 썩은 모양도 여기로 온다.
        return { ...row, pass: false, evidence, verdict: `방향이 다르다(없는 쪽=${hit.detail?.absentSide ?? '?'}) — 실패` }
      }
      return { ...row, pass: true, evidence, verdict: '잡았다(존재/부재·방향 일치) — 통과' }
    }

    if (control.expect.bothPresent) {
      const absent = hits.find((entry) => entry.kind === 'missing')
      if (absent) return { ...row, pass: false, evidence, verdict: '한쪽이 없다 — 이 대조는 양쪽 존재를 전제한다 — 실패' }
      const kinds = new Set(hits.map((entry) => entry.kind))
      const wanted = control.expect.kinds ?? []
      const lacking = wanted.filter((kind) => !kinds.has(kind))
      if (lacking.length > 0) {
        return { ...row, pass: false, evidence, verdict: `종류가 모자라다(없는 종류: ${lacking.join(',')}) — 실패` }
      }
      return { ...row, pass: true, evidence, verdict: `잡았다(${wanted.join('+')}) — 통과` }
    }

    return { ...row, pass: false, evidence, verdict: '대조 정의가 기대를 적지 않았다 — 실패' }
  })
}

/** 해소된 옛 대조의 상태 — 판정 불가 / 관련 차이 없음(해소 유지) / 관련 차이 있음. */
export const RESOLVED_STATUS = {
  unknown: '판정 불가',
  clear: '관련 차이 없음 — 해소 유지',
  present: '관련 차이 있음 — 해소가 되돌아갔나 확인'
}

/**
 * 해소된 옛 대조를 판정한다. 양성 대조 판정기(`evaluateControls`)의 「못 잡았다」를 뒤집어 쓰지 않는다 — 측정 불가도 「못 잡았다」로 가기 때문이다.
 * - 판정 불가: 그 영역·상태를 재지 않았다 · 그 단위에 측정 불가 행(unpaired·selector-miss·truncated)이 있다 · 한쪽이 없다(missing).
 *   diff 는 한쪽이라도 선택자가 0개면 selector-miss/missing 을 내므로, 이 셋이 없으면 두 앱 다 관측된 것이다.
 * - 관련 차이 있음: 옛 차이를 정의한 속성(`expect.props`) 중 **하나라도** 다르다 — box·style 둘 다일 필요가 없다(색만 바뀌어도 해소 유지가 아니다).
 *   속성 목록이 없는 행(font·count)도 관련 차이로 센다.
 * - 관련 차이 없음: 위 둘이 아니다.
 * @param results 영역별 결과 `[{ area, states: [{ state, findings, skipped }] }]`
 * @param controls 기본은 `RESOLVED_CONTROLS`
 */
export function evaluateResolvedControls({ results = [], controls = RESOLVED_CONTROLS } = {}) {
  return controls.map((control) => {
    const area = results.find((entry) => entry.area === control.area)
    const state = area?.states?.find((entry) => entry.state === control.state)
    const row = { id: control.id, area: control.area, state: control.state, unit: control.unit, claim: control.claim }
    if (!area || !state || state.skipped) {
      return { ...row, status: 'unknown', evidence: '(그 영역·상태를 재지 않았다)', verdict: `${RESOLVED_STATUS.unknown} — 측정 안 됨` }
    }
    const all = (state.findings ?? []).filter((finding) => finding.id === control.unit)
    const evidence = all.length > 0 ? all.map((hit) => `${hit.kind}: ${JSON.stringify(hit.detail).slice(0, 90)}`).join(' / ') : '(행 없음)'
    const blocked = all.filter((hit) => DISQUALIFYING.has(hit.kind) || hit.kind === 'missing')
    if (blocked.length > 0) {
      return { ...row, status: 'unknown', evidence, verdict: `${RESOLVED_STATUS.unknown} — ${[...new Set(blocked.map((hit) => hit.kind))].join(',')}` }
    }
    const onlyProps = control.expect.props ? new Set(control.expect.props) : null
    const relevantProps = all.flatMap((hit) =>
      Array.isArray(hit.detail) ? hit.detail.filter((entry) => !onlyProps || onlyProps.has(entry.prop)).map((entry) => `${hit.kind}.${entry.prop}`) : [hit.kind]
    )
    if (relevantProps.length > 0) {
      return { ...row, status: 'present', evidence, verdict: `${RESOLVED_STATUS.present} (${relevantProps.join(', ')})` }
    }
    return { ...row, status: 'clear', evidence, verdict: RESOLVED_STATUS.clear }
  })
}
