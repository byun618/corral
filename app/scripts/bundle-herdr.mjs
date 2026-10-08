// LIFE-556 — release 동봉 herdr 를 패키징 자리(`build/backend/`)에 놓는다. `npm run package:mac` 이 electron-builder 직전에 부른다.
//
// 입력은 `CORRAL_BACKEND_PROFILE=release sh scripts/build-terminal-backend.sh` 의 build root(`CORRAL_BACKEND_BUILD_ROOT`) 하나다.
// 영수증(`target/release/herdr.json`)이 release 이고, 패치 목록·sha256 이 지금 `backend/source.json` 과 같고, 바이너리 sha256 이
// 영수증과 같을 때만 복사한다 — 낡은 빌드·debug 빌드가 번들에 들어가지 않게. 놓는 것:
//   build/backend/herdr            동봉 바이너리 (→ Contents/Resources/backend/herdr)
//   build/backend/LICENSE-herdr    상류 LICENSE 사본 (Apache-2.0 §4(a))
//   build/backend/NOTICE-herdr.md  상류·commit·수정 사실(패치별 수정 파일) 고지 (§4(b)(c))
//   build/backend/herdr.json       번들 영수증 — 경로 없이 sha256·패치·프로필만
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const app = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const work = process.env.CORRAL_BACKEND_BUILD_ROOT
const fail = (message) => {
  console.error(`bundle-herdr: ${message}`)
  process.exit(1)
}
if (!work) fail('CORRAL_BACKEND_BUILD_ROOT 가 필요하다 — CORRAL_BACKEND_PROFILE=release sh scripts/build-terminal-backend.sh 의 build root')
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const source = JSON.parse(fs.readFileSync(path.join(app, 'backend/source.json'), 'utf8'))
const tree = path.join(work, 'herdr-0.9.0')
const binary = path.join(tree, 'target/release/herdr')
let receipt
try {
  receipt = JSON.parse(fs.readFileSync(`${binary}.json`, 'utf8'))
} catch {
  fail('release 영수증(target/release/herdr.json)이 없다 — release 빌드를 먼저 돌린다')
}
if (receipt.profile !== 'release') fail(`영수증 프로필이 release 가 아니다 (${String(receipt.profile)})`)
const expected = source.patches.map((name) => ({ name, sha256: source.patchSHA256[name] }))
for (const patch of expected) if (hash(path.join(app, 'backend', patch.name)) !== patch.sha256) fail(`${patch.name} 가 source.json 의 sha256 과 다르다`)
if (JSON.stringify(receipt.patches) !== JSON.stringify(expected)) fail('영수증의 패치 목록이 지금 source.json 과 다르다 — 새 build root 로 다시 빌드한다')
if (receipt.commit !== source.commit || receipt.archiveSHA256 !== source.archiveSHA256) fail('영수증의 상류 commit·archive 가 source.json 과 다르다')
const binarySHA256 = hash(binary)
if (binarySHA256 !== receipt.binarySHA256) fail('바이너리 sha256 이 영수증과 다르다')

const out = path.join(app, 'build/backend')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
fs.copyFileSync(binary, path.join(out, 'herdr'))
fs.chmodSync(path.join(out, 'herdr'), 0o755)
fs.copyFileSync(path.join(tree, 'LICENSE'), path.join(out, 'LICENSE-herdr'))

const modified = (name) =>
  [...new Set(fs.readFileSync(path.join(app, 'backend', name), 'utf8').split('\n').filter((line) => line.startsWith('+++ b/')).map((line) => line.slice(6)))].sort()
const notice = [
  '# herdr — bundled with corral',
  '',
  'corral.app 에는 herdr 터미널 백엔드가 들어 있다 (`Contents/Resources/backend/herdr`). corral 전용이며 PATH 에 올리지 않는다.',
  '',
  `- 상류: ${source.upstream} — 태그 ${source.tag}, commit ${source.commit}`,
  `- 라이선스: Apache License 2.0 — 같은 폴더의 \`LICENSE-herdr\` 가 상류 LICENSE 원문 사본이다. 상류에는 NOTICE 파일이 없다.`,
  '- 저작권: 상류 소스의 저작권 고지는 그대로 두었다.',
  '- **수정 사실**: 이 바이너리는 상류 소스에 corral 이 만든 아래 패치를 순서대로 적용해 release 로 빌드한 것이다. 패치 원문은 corral 저장소 `app/backend/` 에 있다.',
  '',
  ...source.patches.flatMap((name) => [`  - \`${name}\` (sha256 ${source.patchSHA256[name]}) — 수정한 파일:`, ...modified(name).map((file) => `    - \`${file}\``)]),
  '',
  '- 의존 crate 의 고지는 이 빌드에 싣지 않았다 — 공개 배포(LIFE-446 T3)에서 다룬다.',
  '',
].join('\n')
fs.writeFileSync(path.join(out, 'NOTICE-herdr.md'), notice)
fs.writeFileSync(
  path.join(out, 'herdr.json'),
  JSON.stringify({ upstream: source.upstream, tag: source.tag, commit: source.commit, profile: receipt.profile, buildBinarySHA256: binarySHA256, note: 'buildBinarySHA256 is the cargo output before electron-builder re-signs the bundle; the signed binary differs', patches: expected }, null, 2) + '\n',
)
console.log(`bundle-herdr: build/backend/herdr ${binarySHA256} (${source.patches.length} patches, release)`)
