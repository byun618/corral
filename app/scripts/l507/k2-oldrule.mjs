// LIFE-507 fix1 R1-M2 — k2 원자료 한 파일의 ⌘W STEP·HOLD 줄에서 옛 규칙(6d1273db `panes.find((pane) => pane.focused)`, 탭 순서로 첫 focused)이
// 고를 pane 을 다시 계산한다. R047 은 판정식을 고치기 전(focusInOtherTab) 회차라 VERDICT 에 oldRulePick 칸이 없다. 집계기가 아니다 — 파일 하나, 줄 하나.
// 사용: node k2-oldrule.mjs <k2 원자료>
import fs from 'node:fs'

const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n')
const stepW = JSON.parse(lines.find((line) => line.startsWith('STEP {"label":"⌘W"')).slice(5))
const hold = JSON.parse(lines.find((line) => line.startsWith('HOLD ')).slice(5))
const starred = stepW.herdrPanes.flatMap((row) => { const [w, t, ...rest] = row.split(':'); return rest.join(':').split('|').filter((pane) => pane.endsWith('*')).map((pane) => ({ tab: `${w}:${t}`, pane: pane.replace('*', '') })) })
const front = hold[0]?.replace('*', '') ?? null
const verdict = { screenAfterW: stepW.screen.pane, herdrPanesAtW: stepW.herdrPanes, oldRulePick: starred[0]?.pane ?? null, oldRulePickTab: starred[0]?.tab ?? null, mruFront: front }
verdict.oldRuleDiffers = verdict.oldRulePick !== verdict.screenAfterW
verdict.frontIsScreen = front === verdict.screenAfterW
console.log('VERDICT', JSON.stringify(verdict))
process.exit(verdict.oldRuleDiffers && verdict.frontIsScreen ? 0 : 2)
