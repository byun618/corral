// LIFE-729 C9ⓑ — APK 제3자 고지를 android 프로젝트의 assets 에 만든다(→ APK `assets/licenses/third-party/`).
// EAS 빌드 훅 `eas-build-post-install`(prebuild 뒤·gradle 빌드 앞)이 부른다 — `scripts/release-apk.sh` 의 로컬 빌드도 같은 길을 탄다.
// 입력(이 빌드의 실물):
//   - npm: package-lock 의 dev 아닌 패키지(JS 번들·네이티브 모듈 소스가 여기서 온다)
//   - Android 런타임 의존: `gradlew :app:dependencies --configuration releaseRuntimeClasspath` 가 해석한 maven 좌표 → gradle 캐시의 POM(라이선스·저작권자)·아티팩트 안 LICENSE/NOTICE
//   - NDK libc++(libc++_shared.so) · 반입 글꼴(assets/fonts/*-OFL.txt)
// 끝나면 `verify-notices.mjs` 가 만든 APK 안 실물(dex 클래스·.so·assets·JS 소스맵)과 따로 대조한다.
// node scripts/build-notices.mjs [--android <android 폴더, 기본 ./android>] [--inputs <notices.init.gradle 출력 파일 — 주면 gradle 을 돌리지 않는다>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { key, licenseFiles, npmComponent, readZip, renderJson, renderText, spdxText } from '../../app/scripts/notices-lib.mjs'

const mobile = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const fail = (m) => {
  console.error(`build-notices(mobile): ${m}`)
  process.exit(1)
}
const android = path.resolve(opt('--android', path.join(mobile, 'android')))
if (!fs.existsSync(path.join(android, 'app/build.gradle'))) fail(`android 프로젝트가 없다: ${android} — prebuild 뒤에 부른다`)

// ── gradle 해석 — notices.init.gradle 이 해석 결과·POM 경로를 낸다 ──
const inputsText = opt('--inputs', null)
  ? fs.readFileSync(opt('--inputs'), 'utf8')
  : execFileSync(path.join(android, 'gradlew'), ['-q', '-I', path.join(mobile, 'scripts/notices.init.gradle'), ':app:corralNoticeInputs'], { cwd: android, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] })
const coords = new Set()
const projects = new Set()
const poms = new Map()
let gradleHome = process.env.GRADLE_USER_HOME ?? path.join(os.homedir(), '.gradle')
for (const line of inputsText.split('\n')) {
  const [t, a] = line.split(' ')
  if (t === 'COMP') coords.add(a)
  else if (t === 'PROJ') projects.add(a)
  else if (t === 'POM') poms.set(a, line.slice(t.length + a.length + 2))
  else if (t === 'HOME') gradleHome = line.slice(5)
}
if (!coords.size) fail('gradle 해석 결과에 maven 좌표가 하나도 없다')
const cache = path.join(gradleHome, 'caches/modules-2/files-2.1')
const cacheFiles = (g, a, v) => {
  const d = path.join(cache, g, a, v)
  if (!fs.existsSync(d)) return []
  return fs.readdirSync(d).flatMap((h) => fs.readdirSync(path.join(d, h)).map((f) => path.join(d, h, f)))
}
// POM 을 저장소에서 못 받는 모듈 — react-native 저장소에서 빌드돼 같은 npm 패키지 안 원문을 쓴다
const NO_POM = {
  'com.facebook.react:react-android': { license: 'MIT', source: 'https://github.com/facebook/react-native', npm: 'react-native' },
  'com.facebook.react:hermes-android': { license: 'MIT', source: 'https://github.com/facebook/hermes', copyright: 'Meta Platforms, Inc. and affiliates (hermes LICENSE — not in the aar)' },
}
// 아티팩트에 원문이 없고 POM 이 SPDX 로 옮길 수 없는 「BSD License」 URL 만 주는 모듈 — 그 URL 이 가리키는 상류 레포의 원문 사본(scripts/notice-texts/).
// 사본은 POM 의 license URL 레포에서 그 버전 시점(태그 또는 LICENSE 마지막 변경 커밋)의 LICENSE·PATENTS 를 그대로 옮긴 것. 버전이 바뀌면 원문을 다시 확인한다
const UPSTREAM_TEXT = {
  'com.facebook.device.yearclass:yearclass@2.1.0': { license: 'BSD-3-Clause', files: ['yearclass-LICENSE.txt', 'yearclass-PATENTS.txt'], copyright: 'Facebook, Inc. (upstream LICENSE)', source: 'https://github.com/facebook/device-year-class' },
  'com.parse.bolts:bolts-tasks@1.4.0': { license: 'BSD-3-Clause', files: ['bolts-tasks-LICENSE.txt', 'bolts-tasks-PATENTS.txt'], copyright: 'Facebook, Inc. (upstream LICENSE)', source: 'https://github.com/BoltsFramework/Bolts-Android (tag 1.4.0)' },
}
const tag = (xml, t) => [...xml.matchAll(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'g'))].map((m) => m[1].trim())
const pomOf = (g, a, v, depth = 0) => {
  const file = poms.get(`${g}:${a}:${v}`)
  if (!file) return null
  const xml = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const licenses = tag(tag(xml, 'licenses')[0] ?? '', 'license').map((l) => ({ name: tag(l, 'name')[0] ?? '', url: tag(l, 'url')[0] ?? '' }))
  const developers = tag(tag(xml, 'developers')[0] ?? '', 'developer').map((d) => tag(d, 'name')[0] ?? tag(d, 'id')[0]).filter(Boolean)
  const org = tag(tag(xml, 'organization')[0] ?? '', 'name')[0]
  const self = { licenses, developers, org, url: tag(xml.replace(/<parent>[\s\S]*?<\/parent>|<licenses>[\s\S]*?<\/licenses>|<developers>[\s\S]*?<\/developers>|<organization>[\s\S]*?<\/organization>|<scm>[\s\S]*?<\/scm>|<distributionManagement>[\s\S]*?<\/distributionManagement>|<dependencies>[\s\S]*?<\/dependencies>/g, ''), 'url')[0] }
  const parent = tag(xml, 'parent')[0]
  if (parent && depth < 5 && (!licenses.length || (!developers.length && !org))) {
    const p = pomOf(tag(parent, 'groupId')[0], tag(parent, 'artifactId')[0], tag(parent, 'version')[0], depth + 1)
    if (p) return { licenses: licenses.length ? licenses : p.licenses, developers: developers.length ? developers : p.developers, org: org ?? p.org, url: self.url ?? p.url }
  }
  return self
}
// POM 라이선스 이름·URL → SPDX id (모르면 null — 원문 없음 사유로 남긴다)
const SPDX_OF = [
  [/apache.*2|apache\.org\/licenses\/license-2\.0/i, 'Apache-2.0'],
  [/\bmit\b|opensource\.org\/licenses\/mit/i, 'MIT'],
  [/bsd.?3|new bsd|bsd-3-clause|revised bsd/i, 'BSD-3-Clause'],
  [/bsd.?2|simplified bsd|bsd-2-clause/i, 'BSD-2-Clause'],
  [/eclipse public license.*2|epl-2\.0/i, 'EPL-2.0'],
]
const spdxOf = (l) => SPDX_OF.find(([re]) => re.test(`${l.name} ${l.url}`))?.[1] ?? null
const LICENSE_ENTRY = /^(META-INF\/)?([^/]+\/)*(LICEN[CS]E|NOTICE|COPYING)[^/]*$/i
const artifactTexts = (files) => {
  const out = []
  for (const f of files.filter((x) => /\.(aar|jar)$/.test(x))) {
    const zip = readZip(fs.readFileSync(f))
    const scan = (z, prefix) => {
      for (const name of z.entries.keys()) if (LICENSE_ENTRY.test(name) && (name.startsWith('META-INF/') || !name.includes('/'))) out.push({ file: `${prefix}${name}`, text: z.read(name).toString('utf8') })
    }
    scan(zip, '')
    if (zip.entries.has('classes.jar')) scan(readZip(zip.read('classes.jar')), 'classes.jar!/')
  }
  return out
}
const maven = []
const skipped = []
for (const c of [...coords].sort()) {
  const [g, a, v] = c.split(':')
  const files = cacheFiles(g, a, v)
  const hasBinary = files.some((f) => /\.(aar|jar)$/.test(f))
  if (!hasBinary) {
    // 아티팩트 없는 모듈 — BOM(platform)·Kotlin 멀티플랫폼 우산·다른 좌표로 옮겨 둔 모듈(Gradle 모듈 메타데이터 available-at). 실물 좌표가 따로 고지된다
    skipped.push(`${c} — 아티팩트 없음(${a.endsWith('-bom') ? 'BOM' : '메타데이터 모듈'})`)
    continue
  }
  const pom = pomOf(g, a, v)
  const own = artifactTexts(files)
  const known = NO_POM[`${g}:${a}`]
  if (!pom && known) {
    const texts = known.npm ? licenseFiles(path.join(mobile, 'node_modules', known.npm)) : [{ file: 'SPDX:MIT', text: spdxText('MIT') }]
    maven.push({ kind: 'maven', name: `${g}:${a}`, version: v, license: known.license, source: known.source, copyright: known.copyright ?? '', texts: own.length ? own : texts, textFrom: own.length || known.npm ? 'package' : 'spdx' })
    continue
  }
  const licenses = pom?.licenses ?? []
  const license = licenses.map((l) => spdxOf(l) ?? (l.name || l.url)).join(' OR ') || null
  const copyright = pom ? [pom.org, ...pom.developers].filter(Boolean).join(', ') : ''
  const comp = { kind: 'maven', name: `${g}:${a}`, version: v, license, source: pom?.url ?? `https://mvnrepository.com/artifact/${g}/${a}/${v}`, copyright: copyright ? `${copyright} (POM)` : '' }
  const upstream = UPSTREAM_TEXT[`${g}:${a}@${v}`]
  if (own.length) Object.assign(comp, { texts: own, textFrom: 'package' })
  else if (upstream) Object.assign(comp, { license: upstream.license, source: upstream.source, copyright: upstream.copyright, textFrom: 'upstream', texts: upstream.files.map((f) => ({ file: f, text: fs.readFileSync(path.join(mobile, 'scripts/notice-texts', f), 'utf8') })) })
  else {
    const ids = licenses.map(spdxOf)
    const texts = ids.filter(Boolean).map((id) => ({ file: `SPDX:${id}`, text: spdxText(id) }))
    if (!licenses.length) Object.assign(comp, { texts: [], textFrom: 'spdx', missingReason: pom ? 'POM 에 라이선스가 없다' : '저장소에서 POM 을 받지 못했다' })
    else if (ids.includes(null)) Object.assign(comp, { texts: [], textFrom: 'spdx', missingReason: `SPDX 로 옮길 수 없는 라이선스: ${licenses.filter((l) => !spdxOf(l)).map((l) => `${l.name} <${l.url}>`).join(', ')}` })
    else if (texts.some((t) => t.text === null)) Object.assign(comp, { texts: [], textFrom: 'spdx', missingReason: `SPDX 원문이 레포에 없다: ${texts.filter((t) => t.text === null).map((t) => t.file).join(', ')}` })
    else Object.assign(comp, { texts, textFrom: 'spdx', copyright: comp.copyright || '저작권자 표기 없음 — POM 에 developers·organization 이 없다. 출처는 source 줄' })
  }
  maven.push(comp)
}

// ── npm ──
const lock = JSON.parse(fs.readFileSync(path.join(mobile, 'package-lock.json'), 'utf8'))
const npm = new Map()
for (const [p, entry] of Object.entries(lock.packages)) {
  if (!p.startsWith('node_modules/') || entry.dev || entry.link) continue
  const dir = path.join(mobile, p)
  if (!fs.existsSync(path.join(dir, 'package.json'))) continue
  const c = npmComponent('npm', dir)
  if (!npm.has(key(c))) npm.set(key(c), c)
}

// ── NDK libc++ · 반입 글꼴 ──
// NDK 버전 — RN 기본값(react-native/gradle/libs.versions.toml). ExpoRootProject 가 이 값을 쓴다(gradle 출력 「ndk: …」)
const ndkVersion = fs.readFileSync(path.join(mobile, 'node_modules/react-native/gradle/libs.versions.toml'), 'utf8').match(/^ndkVersion = "([^"]+)"/m)?.[1] ?? fail('react-native libs.versions.toml 에 ndkVersion 이 없다')
const llvm = ['Apache-2.0', 'LLVM-exception'].map((id) => ({ file: `SPDX:${id}`, text: spdxText(id) ?? fail(`app/scripts/spdx/${id}.txt 가 없다`) }))
const fonts = path.join(mobile, 'assets/fonts')
const native = [{ kind: 'native', name: 'LLVM libc++ (Android NDK libc++_shared.so)', version: `NDK ${ndkVersion}`, license: 'Apache-2.0 WITH LLVM-exception', source: 'https://github.com/llvm/llvm-project', copyright: 'The LLVM Project contributors (NDK NOTICE.toolchain)', texts: llvm, textFrom: 'spdx' }]
const vendored = fs
  .readdirSync(fonts)
  .filter((f) => f.endsWith('-OFL.txt'))
  .sort()
  .map((f) => ({ kind: 'asset', name: `${f.replace(/-OFL\.txt$/, '')} (font)`, version: 'assets/fonts', license: 'OFL-1.1', source: 'mobile/assets/fonts', texts: [{ file: f, text: fs.readFileSync(path.join(fonts, f), 'utf8') }], textFrom: 'package' }))

// ── 쓰기 ──
const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
const components = [...native, ...maven.sort(byName), ...[...npm.values()].sort(byName), ...vendored]
const out = path.join(android, 'app/src/main/assets/licenses/third-party')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
const appVersion = JSON.parse(fs.readFileSync(path.join(mobile, '../app/package.json'), 'utf8')).version
fs.writeFileSync(path.join(out, 'THIRD-PARTY-NOTICES.txt'), renderText(`corral mobile ${appVersion} (Android) — third-party notices`, components))
fs.writeFileSync(path.join(out, 'third-party.json'), renderJson({ target: 'apk', appVersion, gradleProjects: [...projects].sort(), skippedCoordinates: skipped }, components))
const missing = components.filter((c) => c.missingReason)
for (const c of missing) console.error(`build-notices(mobile): 원문 없음 ${key(c)} — ${c.missingReason}`)
const count = (k) => components.filter((c) => c.kind === k).length
console.log(`build-notices(mobile): <android>/${path.relative(android, out)} — maven ${count('maven')} · npm ${count('npm')} · native ${count('native')} · asset ${count('asset')} · 건너뛴 좌표 ${skipped.length} · 원문 없음 ${missing.length}`)
