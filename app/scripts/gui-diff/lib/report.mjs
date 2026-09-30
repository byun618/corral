// 결과 쓰기 — json(기계용) + md(사람용). 판정 문서(C7)가 요구하는 7칸 표를 그대로 낸다.

import fs from 'node:fs'
import path from 'node:path'

const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
// 자리 표기 — 둘째 이후 부모는 `[n번째]`, 둘째 이후 자식은 `· 자식 m번째` 를 붙인다 (R4).
const where = (entry) => {
  const parent = entry.index ? ` [${entry.index + 1}번째]` : ''
  return entry.childIndex ? `${parent || ' [1번째]'} · 자식 ${entry.childIndex + 1}번째` : parent
}

/** 차이 한 건을 사람이 읽는 한 줄로. 값이 길면 자른다 — 표가 깨지면 아무도 안 읽는다. */
export function describeFinding(finding) {
  const clip = (value, n = 46) => {
    const text = String(value)
    return text.length > n ? `${text.slice(0, n - 1)}…` : text
  }
  switch (finding.kind) {
    case 'unpaired':
      return { orca: '(못 잼)', corral: '(못 잼)', diff: `짝짓기 불가 — ${finding.detail.reason}` }
    case 'missing': {
      // **두 뜻을 합치지 않는다** (R2-L1). 선언된 부재·조건부 관측 부재·부모 안의 부재는 다른 사실이다.
      const absence = finding.detail?.absence
      const diff =
        absence === 'declared'
          ? '한쪽에만 있음(선언)'
          : absence === 'conditional'
            ? '한쪽에만 있음(관측 — 조건부 렌더)'
            : absence === 'parent-scoped'
              ? `같은 부모(${finding.detail.parentIndex ?? '?'}번째) 안에서 한쪽에만 있음`
              : finding.detail?.left === 'unmeasured'
                ? '양쪽 다 측정 안 됨'
                : '한쪽에만 있음(관측)'
      return { orca: clip(finding.detail.left), corral: clip(finding.detail.right), diff }
    }
    case 'selector-miss':
      // 「없다」가 아니라 **못 찾았다** — 선택자 부패다. 차이로 읽으면 없는 것을 만들러 간다.
      return { orca: clip(finding.detail.left), corral: clip(finding.detail.right), diff: '선택자가 0개를 찾음 — 측정 실패' }
    case 'font':
      return { orca: clip(finding.detail.left, 60), corral: clip(finding.detail.right, 60), diff: '렌더 폰트(platformFonts)' }
    case 'count':
      return { orca: `${finding.detail.left}개`, corral: `${finding.detail.right}개`, diff: '개수' }
    case 'box':
      return {
        orca: finding.detail.map((d) => `${d.prop}=${d.left}`).join(' '),
        corral: finding.detail.map((d) => `${d.prop}=${d.right}`).join(' '),
        diff: finding.detail.map((d) => `${d.prop} ${d.delta > 0 ? '+' : ''}${d.delta}px`).join(', ')
      }
    case 'style':
      return {
        orca: clip(finding.detail.map((d) => `${d.prop}: ${d.left}`).join('; '), 70),
        corral: clip(finding.detail.map((d) => `${d.prop}: ${d.right}`).join('; '), 70),
        // `fontFamily` 는 **선언값**이다 — corral 은 폰트를 이름만 선언하고 번들하지 않으므로
        // (app-screens §0) 실제 렌더 폰트 차이와 구분해 읽어야 한다. 그 자리에 ⚑ 를 찍는다.
        diff: finding.detail.map((d) => (d.prop === 'fontFamily' ? 'fontFamily ⚑' : d.prop)).join(', ')
      }
    default:
      return { orca: '', corral: '', diff: finding.kind }
  }
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
  return filePath
}

/**
 * 첫 측정 결과 문서 (C7). 분류 칸은 **초안**이다 — 447~450 착수 때 확정한다.
 * 도구는 분류를 추측하지 않는다: 자동으로 붙일 수 있는 것은 `해소 대상` 후보뿐이고,
 * 그마저 사람이 뒤집을 수 있게 사유 칸을 비워 둔다. 도구가 의도를 아는 척하면 그 문서는 못 믿는다.
 */
export function renderReport({ date, runs, areas, notes }) {
  const lines = []
  lines.push(`# Orca ↔ corral GUI 차이 — ${date}`)
  lines.push('')
  lines.push('LIFE-443 측정 도구(`app/scripts/gui-diff/measure.mjs`)가 낸 첫 측정 결과다.')
  lines.push('**분류 칸은 초안이다** — 해소 대상/의도적/보류의 확정은 447~450 각 체크포인트 착수 때 한다.')
  lines.push('')
  lines.push('## 측정 조건')
  lines.push('')
  lines.push('| 항목 | Orca | corral |')
  lines.push('| --- | --- | --- |')
  for (const row of notes.conditions) {
    lines.push(`| ${cell(row.label)} | ${cell(row.orca)} | ${cell(row.corral)} |`)
  }
  lines.push('')
  if (notes.warnings.length > 0) {
    lines.push('### ⚠ 대칭 경고 — 아래 행이 있으면 그 회차의 모든 차이가 의심스럽다')
    lines.push('')
    for (const warning of notes.warnings) {
      lines.push(`- \`${warning.key}\` ${warning.label}: Orca \`${warning.left}\` / corral \`${warning.right}\``)
    }
    lines.push('')
  }
  lines.push('## 상태 재현 검증 (C9) — 요청한 상태가 두 앱에 **같게** 만들어졌는가')
  lines.push('')
  lines.push('축이 하나라도 어긋나면 그 상태의 차이 행은 분류에서 「보류」로 내려간다 — 제품 차이인지')
  lines.push('하네스가 만든 차이인지 그 회차로는 가를 수 없기 때문이다.')
  lines.push('')
  lines.push('| 상태 | 축 | 요청 | Orca | corral | 일치 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const entry of notes.stateAxes ?? []) {
    for (const axis of entry.axes ?? []) {
      lines.push(
        `| ${cell(entry.state)} | ${cell(axis.label)} | ${cell(axis.requested)} | ${cell(axis.orca)} | ${cell(axis.corral)} | ${axis.ok ? '○' : '✗'} |`
      )
    }
  }
  lines.push('')
  lines.push('## 잡음 바닥 (C5 음성 대조)')
  lines.push('')
  lines.push('허용치의 근거는 **허용치 없이 잰 흔들림**이다 — 그래서 회차마다 `허용치 0` 칸도 함께 낸다.')
  lines.push('')
  lines.push('| 앱 | 자기 diff(허용치 적용) | 허용치 | 자기 diff(허용치 0) | 허용치 0 에서 최대 델타 | 결과 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const row of notes.noiseFloor) {
    lines.push(
      `| ${cell(row.app)} | ${cell(row.total)}건 | ${cell(row.tolerance)}px | ${cell(row.totalAtZero ?? '(안 냄)')}건 | ${cell(row.maxDeltaAtZero ?? '(안 냄)')}px | ${cell(row.verdict)} |`
    )
  }
  lines.push('')
  lines.push('## 양성 대조 (C6) — 알려진 차이를 도구가 잡는가')
  lines.push('')
  if (!notes.controlsMode) {
    lines.push('이 회차는 `--controls` 없이 돌았다 — **양성 대조를 돌지 않았다.** 이 회차는 C6 의 근거가 아니다.')
    lines.push('(왜 기본이 아닌가: 대조를 모든 실행의 관문으로 두면 부분 측정이 실패하고, 447~450 이 그 차이를')
    lines.push('실제로 해소했을 때 도구가 그 회차를 실패로 만든다.)')
  } else {
    lines.push('| # | 알려진 차이 | 도구가 낸 행 | 판정 |')
    lines.push('| --- | --- | --- | --- |')
    for (const row of notes.positiveControls) {
      lines.push(`| ${cell(row.id)} | ${cell(row.claim)} | ${cell(row.evidence)} | ${cell(row.verdict)} |`)
    }
  }
  lines.push('')

  for (const area of areas) {
    lines.push(`## 영역: ${area.area}`)
    lines.push('')
    if (area.description) {
      lines.push(area.description)
      lines.push('')
    }
    lines.push('범례: ⚑ = `font-family` **선언값** 차이 — 실제 렌더 폰트는 별도 확인이 필요하다 (corral 은 폰트를 번들하지 않는다).')
    lines.push('')
    lines.push('| 영역 | 상태 | Orca | corral | 차이 | 분류(해소 대상/의도적/보류) | 근거 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const state of area.states) {
      if (state.skipped) {
        lines.push(
          `| ${cell(area.area)} | ${cell(state.state)} | (공백) | (공백) | (공백) | 보류 | 재현 못 함 — ${cell(state.skipped)} |`
        )
        continue
      }
      if (state.findings.length === 0) {
        lines.push(`| ${cell(area.area)} | ${cell(state.state)} | — | — | 차이 0건 | — | ${cell(state.raw)} |`)
        continue
      }
      for (const finding of state.findings) {
        const described = describeFinding(finding)
        const classification =
          finding.kind === 'unpaired'
            ? '보류 — 도구가 못 잰다'
            : finding.kind === 'selector-miss'
              ? '보류 — 측정 실패(선택자 부패). 차이로 읽지 않는다'
              : (finding.classification ?? '(초안 미정)')
        const label = `${area.area} › ${finding.note ?? finding.id}${where(finding)}`
        lines.push(
          `| ${cell(label)} | ${cell(state.state)} | ${cell(described.orca)} | ${cell(described.corral)} | ${cell(described.diff)} | ${cell(classification)} | ${cell(state.raw)} |`
        )
      }
    }
    lines.push('')
    // 허용치가 가린 것 — 판정에서 뺐다는 말과 **없었다는 말**은 다르다 (F12).
    const below = area.states.flatMap((state) => (state.belowTolerance ?? []).map((entry) => ({ state: state.state, ...entry })))
    if (below.length > 0) {
      lines.push(`### 허용치 이하로 걸러진 박스 차이 — ${below.length}건 (판정에서 빼되 세어 둔다)`)
      lines.push('')
      lines.push('| 단위 | 상태 | 속성 | Orca | corral | 델타 |')
      lines.push('| --- | --- | --- | --- | --- | --- |')
      for (const entry of below) {
        for (const item of entry.detail) {
          lines.push(
            `| ${cell(entry.note ?? entry.id)}${where(entry)} | ${cell(entry.state)} | ${cell(item.prop)} | ${cell(item.left)} | ${cell(item.right)} | ${cell(item.delta)}px |`
          )
        }
      }
      lines.push('')
    }
    const fontGaps = area.states.flatMap((state) => (state.fontUnmeasured ?? []).map((entry) => ({ state: state.state, ...entry })))
    if (fontGaps.length > 0) {
      lines.push(`### 렌더 폰트를 못 잰 자리 — ${fontGaps.length}건`)
      lines.push('')
      lines.push('**「같다」가 아니라 「못 쟀다」다** — 수집 실패·글리프 없음·한쪽 부재를 사유 칸에 적는다 (G7).')
      lines.push('')
      lines.push('| 단위 | 상태 | Orca | corral | 사유 |')
      lines.push('| --- | --- | --- | --- | --- |')
      for (const entry of fontGaps) {
        lines.push(
          `| ${cell(entry.note ?? entry.id)}${where(entry)} | ${cell(entry.state)} | ${cell(entry.detail.left)} | ${cell(entry.detail.right)} | ${cell(entry.detail.why ?? '한쪽 노드에 글리프가 없다')} |`
        )
      }
      lines.push('')
    }
  }

  lines.push('## 재현한 상태 / 재현 못 한 상태 (C7)')
  lines.push('')
  lines.push('| 영역 | 상태 | 재현 | 사유 |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of notes.stateMatrix) {
    lines.push(
      `| ${cell(row.area)} | ${cell(row.state)} | ${cell(row.reproduced ? '○' : '✗')} | ${cell(row.reason ?? '')}${(row.mismatched ?? []).length > 0 ? ` (어긋난 축: ${row.mismatched.join(',')})` : ''} |`
    )
  }
  lines.push('')
  lines.push('## 실행 회차')
  lines.push('')
  lines.push(`명시 실행 목록: \`${runs}\`. 이 문서의 모든 수치는 그 파일의 행으로 되짚을 수 있다.`)
  lines.push('')
  return `${lines.join('\n')}\n`
}
