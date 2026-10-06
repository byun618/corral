// LIFE-527 fix2 H3 — 소유자 판정 단위 시험. 실행: node --test app/scripts/l527/os-owner.nodetest.mjs (vitest 패턴 *.test.* 밖 — node:test 파일)
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownerVerdict } from './os-owner.mjs'

const corral = { owner: 'Electron', bundle: '/Users/u/repos/corral/.claude/worktrees/x/app/node_modules/electron/dist/Electron.app' }
const orcaDev = { owner: 'Orca Dev', bundle: '/private/tmp/l443/orca-198/out/electron-dev/06a006d5b3a0/Orca: e0826956.app' }

test('격리·네이티브 corral 과 Orca 198 개발 인스턴스(node_modules Electron)는 허용', () => {
  assert.equal(ownerVerdict(corral), null)
  assert.equal(ownerVerdict(orcaDev), null)
})

test('설치본 Orca 는 pid 와 무관하게 거절 — 번들 경로로도, 이름으로도', () => {
  assert.match(ownerVerdict({ owner: 'Orca', bundle: '/Applications/Orca.app', pid: 99999 }), /설치본 Orca/)
  assert.match(ownerVerdict({ owner: 'Orca', bundle: '' }), /설치본 Orca/)
  assert.match(ownerVerdict({ owner: 'Electron', bundle: '/Applications/Orca.app/Contents/Frameworks/x' }), /설치본 Orca/)
})

test('그 밖의 앱(Finder·터미널·번들 모름)은 거절', () => {
  assert.match(ownerVerdict({ owner: 'Finder', bundle: '/System/Library/CoreServices/Finder.app' }), /허용 밖/)
  assert.match(ownerVerdict({ owner: 'Electron', bundle: '' }), /허용 밖/)
  assert.match(ownerVerdict({ owner: 'Orca Dev', bundle: '/tmp/other/out/electron-dev/x/Orca.app' }), /허용 밖/)
  assert.equal(ownerVerdict(null), '창 없음')
})
