// LIFE-511 K1ⓑ — ⌘,(Mod+,) 충돌 목록 원자료. 기존 기본값 중 Mod+, 를 쓰는 액션 · 사용자 실제 keybindings.json(있으면)의 재정의 중 Mod+, 를 쓰는 것.
// 사용: node scripts/l511/comma-conflicts.mts <사용자 userData>
import fs from 'node:fs'
import path from 'node:path'
import { ACTIONS, validateOverrides, matchBinding } from '../../src/shared/keybindings.ts'

const userData = process.argv[2]
const file = path.join(userData, 'keybindings.json')
const exists = fs.existsSync(file)
const raw = exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
const defaultsUsingComma = ACTIONS.filter((action) => action.id !== 'settings.open' && action.defaultBinding.some((binding) => /\+,$/.test(binding))).map((action) => action.id)
const overridesUsingComma = raw ? Object.entries(raw).filter(([, bindings]) => Array.isArray(bindings) && bindings.some((binding) => typeof binding === 'string' && /\+,$/.test(binding))).map(([id, bindings]) => ({ id, bindings })) : []
const overrides = raw ? validateOverrides(raw) : {}
console.log(JSON.stringify({
  userKeybindings: { file, exists },
  defaultsUsingModComma: defaultsUsingComma,
  userOverridesUsingComma: overridesUsingComma,
  // 양보 실측 — 다른 액션 재정의가 ⌘, 를 쓰면 그 재정의가 이긴다(settings.open 이 비켜 선다).
  yieldProbe: { overrides: { 'palette.open': ['Mod+,'] }, modCommaResolvesTo: matchBinding('Mod+,', validateOverrides({ 'palette.open': ['Mod+,'] })) },
  modCommaResolvesTo: matchBinding('Mod+,', overrides),
}, null, 2))
