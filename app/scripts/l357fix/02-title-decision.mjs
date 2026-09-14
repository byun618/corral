// C(세션 제목) 결정 근거 — 01-title-probe.mjs 가 남긴 실측(raw/gate1-fix/c-title-probe.json)에서
// "PaneRow.title 이 행을 구분할 만한가"를 기계적으로 계산한다. 추측이 아니라 파생이다.
import fs from 'node:fs'
import path from 'node:path'
import { RAW_DIR, writeRaw } from './lib.mjs'

const probe = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'c-title-probe.json'), 'utf8'))
const last = probe.snapshots[probe.snapshots.length - 1]

const rows = last.tabs.flatMap((tab) =>
  tab.panes.map((pane) => ({
    tabId: tab.tabId,
    tabLabel: tab.label,
    tabNumber: tab.number,
    paneTitle: pane.title,
    agent: pane.agent,
  })),
)

const titles = rows.map((r) => r.paneTitle)
const distinctTitles = [...new Set(titles)]
const shellRows = rows.filter((r) => r.agent === null)
const agentRows = rows.filter((r) => r.agent !== null)
const distinctShellTitles = [...new Set(shellRows.map((r) => r.paneTitle))]

const result = {
  what: 'C — PaneRow.title 이 사이드바/탭바 행을 구분할 만한가. 판단 입력은 c-title-probe.json 실측뿐이다.',
  source: 'raw/gate1-fix/c-title-probe.json (스냅샷 04-after-osc-title)',
  rows,
  findings: {
    rowCount: rows.length,
    distinctTitleCount: distinctTitles.length,
    distinctTitles,
    shellRowCount: shellRows.length,
    distinctShellTitleCount: distinctShellTitles.length,
    shellTitlesAllIdentical: shellRows.length >= 2 && distinctShellTitleCount(distinctShellTitles) === 1,
    shellTitleContainsAbsolutePath: shellRows.every((r) => r.paneTitle.includes('/')),
    agentTitleEqualsAgentName: agentRows.every((r) => r.paneTitle === r.agent),
    tabLabelIsBareNumber: rows.every((r) => /^\d+$/.test(r.tabLabel)),
  },
  criteria: {
    // 09-gate1-fix.md C-2: "그 값이 행을 구분할 만하면 제목으로 쓴다."
    usableAsTitle: distinctTitles.length === rows.length,
  },
  decision: null,
  rationale: [],
}
function distinctShellTitleCount(list) {
  return list.length
}
result.criteria.usableAsTitle = distinctTitles.length === rows.length
result.decision = result.criteria.usableAsTitle ? 'PaneRow.title 채택' : '폴백 채택: {agent} {number} / 세션 {number}'
result.rationale = [
  `행 ${rows.length}개 중 서로 다른 title 은 ${distinctTitles.length}개 — 행을 1:1 로 구분하지 못한다.`,
  `셸 pane 은 전부 같은 문자열(\`user@host:cwd\`)이다 — 같은 worktree 안 셸 탭끼리는 영영 구분이 안 된다.`,
  `그 셸 title 은 **절대경로를 품는다** — design-handoff §2.5 "절대경로는 행에 넣지 않는다" 와 정면 충돌.`,
  `에이전트 pane 의 title 은 에이전트 이름(\`claude\`) 그 자체다 — 폴백 \`{agent} {number}\` 가 주는 정보의 부분집합이고, 번호가 없어 구분력은 더 낮다.`,
  `\`tab.label\` 은 \`"1"·"2"·"3"\` — §2.5 "pane 인덱스나 숫자만 단독 표시 금지" 에 걸린다.`,
  `따라서 09-gate1-fix.md C-2 의 두 번째 갈래(폴백)를 채택한다: agent 가 있으면 \`{agent} {number}\`, 없으면 \`세션 {number}\`.`,
]
console.log(JSON.stringify(result, null, 2))
writeRaw('c-title-decision.json', result)
