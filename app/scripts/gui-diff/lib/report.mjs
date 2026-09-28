// 결과 쓰기 — json(기계용) + md(사람용). 판정 문서(C7)가 요구하는 7칸 표를 그대로 낸다.

import fs from 'node:fs'
import path from 'node:path'

const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')

/** 차이 한 건을 사람이 읽는 한 줄로. 값이 길면 자른다 — 표가 깨지면 아무도 안 읽는다. */
export function describeFinding(finding) {
  const clip = (value, n = 46) => {
    const text = String(value)
    return text.length > n ? `${text.slice(0, n - 1)}…` : text
  }
  switch (finding.kind) {
    case 'unpaired':
      return { orca: '(못 잼)', corral: '(못 잼)', diff: `짝짓기 불가 — ${finding.detail.reason}` }
    case 'missing':
      return { orca: clip(finding.detail.left), corral: clip(finding.detail.right), diff: '한쪽에만 있음' }
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
  lines.push('## 잡음 바닥 (C5 음성 대조)')
  lines.push('')
  lines.push('| 앱 | 같은 상태 2회 자기 diff | 허용치 | 결과 |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of notes.noiseFloor) {
    lines.push(`| ${cell(row.app)} | ${cell(row.total)}건 | ${cell(row.tolerance)}px | ${cell(row.verdict)} |`)
  }
  lines.push('')
  lines.push('## 양성 대조 (C6) — 알려진 차이를 도구가 잡는가')
  lines.push('')
  lines.push('| # | 알려진 차이 | 도구가 낸 행 | 판정 |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of notes.positiveControls) {
    lines.push(`| ${cell(row.id)} | ${cell(row.claim)} | ${cell(row.evidence)} | ${cell(row.verdict)} |`)
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
        const classification = finding.kind === 'unpaired' ? '보류 — 도구가 못 잰다' : (finding.classification ?? '(초안 미정)')
        lines.push(
          `| ${cell(`${area.area} › ${finding.note ?? finding.id}`)} | ${cell(state.state)} | ${cell(described.orca)} | ${cell(described.corral)} | ${cell(described.diff)} | ${cell(classification)} | ${cell(state.raw)} |`
        )
      }
    }
    lines.push('')
  }

  lines.push('## 재현한 상태 / 재현 못 한 상태 (C7)')
  lines.push('')
  lines.push('| 영역 | 상태 | 재현 | 사유 |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of notes.stateMatrix) {
    lines.push(`| ${cell(row.area)} | ${cell(row.state)} | ${cell(row.reproduced ? '○' : '✗')} | ${cell(row.reason ?? '')} |`)
  }
  lines.push('')
  lines.push('## 실행 회차')
  lines.push('')
  lines.push(`명시 실행 목록: \`${runs}\`. 이 문서의 모든 수치는 그 파일의 행으로 되짚을 수 있다.`)
  lines.push('')
  return `${lines.join('\n')}\n`
}
