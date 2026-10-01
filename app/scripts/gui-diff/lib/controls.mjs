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
 * **해소로 뒤집힌 대조** — 관문이 아니다. `--controls` 회차마다 같은 판정기로 돌려 **뒤집혔는지**(= 더는 못 잡는지)를
 * 보고서에 남긴다. 여기서 `pass: false` 가 정상이다 — 다시 잡히면 해소가 되돌아갔다는 뜻이다.
 */
export const RESOLVED_CONTROLS = [
  {
    id: 'C6ⓑ(옛)',
    area: 'sidebar',
    state: 'default',
    unit: 'repo-header-icon',
    claim: '레포 헤더가 Orca 폴더 아이콘(lucide) vs corral 이니셜 사각형 — LIFE-468 K4ⓐ 가 해소',
    // 양쪽 다 있어야 하고, **모양과 칠 둘 다** 달라야 한다 — 1px 박스 차이 하나로는 아이콘 차이가 아니다.
    expect: { bothPresent: true, kinds: ['box', 'style'] },
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
    const hits = (state.findings ?? []).filter((finding) => finding.id === control.unit)
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
