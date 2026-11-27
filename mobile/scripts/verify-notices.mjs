// LIFE-729 C9ⓓ — 만든 APK 안에 실제로 든 것 ⊆ 실은 고지 목록(assets/licenses/third-party/third-party.json)인지 대조한다.
// 고지 생성기(build-notices.mjs — package-lock·gradle 해석 결과)와 다른 쪽, APK 엔트리에서 뽑는다:
//   ① dex 의 클래스 → 그 클래스를 가진 아티팩트(고지된 maven 모듈의 aar·jar 내용) 또는 그 패키지를 선언한 npm 네이티브 모듈 소스
//   ② lib/<abi>/*.so → 그 이름을 가진 aar jni 엔트리 · npm 패키지의 CMake add_library · NDK libc++
//   ③ META-INF/<그룹>_<이름>.version → 그 maven 모듈·버전
//   ④ assets/* → 내용 sha256 이 같은 aar 엔트리·반입 글꼴
//   ⑤ assets/index.android.bundle → 같은 빌드의 소스맵(번들 바이트가 같을 때만)의 sources → npm 패키지
// 그리고 고지마다 원문이 있거나 「원문 없음」 사유가 있는지(C9ⓒ). res/ 는 aapt 가 이름·내용을 바꿔 대조 공백으로 보고한다.
// node scripts/verify-notices.mjs <apk> [--work <EAS 작업 폴더 — 번들·소스맵을 찾는다>] [--no-js] [--mobile <mobile 폴더>] [--report <파일>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readZip, sha256 } from '../../app/scripts/notices-lib.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const apkFile = args[0]
if (!apkFile || apkFile.startsWith('--')) {
  console.error('사용: node scripts/verify-notices.mjs <apk> [--work <EAS 작업 폴더>] [--no-js] [--mobile <mobile 폴더>] [--report <파일>]')
  process.exit(2)
}
const mobile = path.resolve(opt('--mobile', path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')))
const problems = []
const notes = []
const bad = (m) => problems.push(m)
const apk = readZip(fs.readFileSync(apkFile))
const NOTICE = 'assets/licenses/third-party/'
const listBuf = apk.read(`${NOTICE}third-party.json`)
if (!listBuf || !apk.read(`${NOTICE}THIRD-PARTY-NOTICES.txt`)) {
  console.error(`✖ APK 에 고지가 없다: ${NOTICE}third-party.json·THIRD-PARTY-NOTICES.txt`)
  process.exit(1)
}
const list = JSON.parse(listBuf.toString('utf8'))
const text = apk.read(`${NOTICE}THIRD-PARTY-NOTICES.txt`).toString('utf8')
const comps = list.components
const has = (kind, name, version) => comps.some((c) => c.kind === kind && c.name === name && (version === undefined || c.version === version))

// C9ⓒ — 원문 또는 「원문 없음」 사유
for (const c of comps) {
  if (!c.texts?.length && !c.missingReason) bad(`원문도 사유도 없다: ${c.kind} ${c.name}@${c.version}`) // # guard:av-text
  if (!c.texts?.length) notes.push(`원문 없음(사유 기록): ${c.name}@${c.version} — ${c.missingReason}`)
  if (!text.includes(`\n${c.name} ${c.version}\nLicense: `)) bad(`THIRD-PARTY-NOTICES.txt 에 머리줄이 없다: ${c.name} ${c.version}`)
}

// 고지된 maven 모듈의 아티팩트 내용 — 클래스·jni·assets 색인
const gradleHome = process.env.GRADLE_USER_HOME ?? path.join(os.homedir(), '.gradle')
const cache = path.join(gradleHome, 'caches/modules-2/files-2.1')
const classOwner = new Map() // 'com/foo/Bar' → 고지 이름
const soOwner = new Map() // 'libfoo.so' → 고지 이름
const assetOwner = new Map() // sha256 → 고지 이름
const rOwner = new Map() // aar namespace → 고지 이름
const indexZip = (zip, owner) => {
  for (const name of zip.entries.keys()) {
    if (name.endsWith('.class')) classOwner.set(name.slice(0, -6), owner)
    else if (/^jni\/[^/]+\/[^/]+\.so$/.test(name)) soOwner.set(path.basename(name), owner)
    else if (name.startsWith('assets/') && !name.endsWith('/')) assetOwner.set(sha256(zip.read(name)), owner)
    else if (/^libs\/[^/]+\.jar$/.test(name) || name === 'classes.jar') indexZip(readZip(zip.read(name)), owner)
    // aar 의 리소스 클래스 R 은 앱 빌드가 aar 매니페스트 package(namespace) 아래에 만든다
    else if (name === 'AndroidManifest.xml') { const m = zip.read(name).toString('utf8').match(/package="([\w.]+)"/); if (m) rOwner.set(m[1].replace(/\./g, '/'), owner) }
  }
}
let indexed = 0
for (const c of comps.filter((x) => x.kind === 'maven')) {
  const [g, a] = c.name.split(':')
  const d = path.join(cache, g, a, c.version)
  if (!fs.existsSync(d)) { bad(`고지된 maven 모듈의 아티팩트가 gradle 캐시에 없다 — 대조 불가: ${c.name}@${c.version}`); continue }
  for (const h of fs.readdirSync(d)) for (const f of fs.readdirSync(path.join(d, h))) if (/\.(aar|jar)$/.test(f)) { indexZip(readZip(fs.readFileSync(path.join(d, h, f))), c.name); indexed++ }
}
// 고지된 npm 패키지의 네이티브 모듈 — android/ 소스의 package 선언·build.gradle namespace·CMake add_library
const pkgDecl = new Map() // 'com/foo' → npm 이름
const walk = (dir, fn) => {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'build' && e.name !== 'node_modules') walk(f, fn) }
    else fn(f)
  }
}
for (const c of comps.filter((x) => x.kind === 'npm')) {
  const dir = path.join(mobile, 'node_modules', c.name)
  walk(path.join(dir, 'android'), (f) => {
    if (/\.(kt|java)$/.test(f)) {
      const m = fs.readFileSync(f, 'utf8').match(/^\s*package\s+([\w.]+)/m)
      if (m) pkgDecl.set(m[1].replace(/\./g, '/'), c.name)
      // package 선언이 없는 파일 — 기본 패키지 클래스(파일 이름·Kotlin 파일 클래스 <이름>Kt)
      else { const base = path.basename(f).replace(/\.(kt|java)$/, ''); classOwner.set(base, c.name); classOwner.set(`${base}Kt`, c.name) }
    } else if (/build\.gradle(\.kts)?$/.test(f)) {
      const m = fs.readFileSync(f, 'utf8').match(/namespace\s*=?\s*["']([\w.]+)["']/)
      if (m) pkgDecl.set(m[1].replace(/\./g, '/'), c.name)
    } else if (path.basename(f) === 'CMakeLists.txt') {
      const cm = fs.readFileSync(f, 'utf8')
      const vars = Object.fromEntries([...cm.matchAll(/set\(\s*(\w+)\s+"?([\w-]+)"?\s*\)/g)].map((m) => [m[1], m[2]]))
      for (const m of cm.matchAll(/add_library\(\s*(\$\{\w+\}|[\w-]+)/g)) {
        const name = m[1].startsWith('${') ? vars[m[1].slice(2, -1)] : m[1]
        if (name && !soOwner.has(`lib${name}.so`)) soOwner.set(`lib${name}.so`, c.name)
      }
    }
  })
}

// ① dex 클래스
const uleb = (b, o) => {
  let r = 0, s = 0, x
  do { x = b[o++]; r |= (x & 0x7f) << s; s += 7 } while (x & 0x80)
  return [r >>> 0, o]
}
const dexClasses = (buf) => {
  const u32 = (o) => buf.readUInt32LE(o)
  const strOff = u32(0x3c), typeOff = u32(0x44), n = u32(0x60), classOff = u32(0x64)
  const str = (i) => { let [, o] = uleb(buf, u32(strOff + i * 4)); let e = o; while (buf[e]) e++; return buf.toString('utf8', o, e) }
  return Array.from({ length: n }, (_, i) => str(u32(typeOff + u32(classOff + i * 32) * 4)).slice(1, -1))
}
const appPackage = 'io/github/byun618/corral/mobile'
const unowned = new Map()
let classes = 0
function ownerOfClass(cls) {
  // RN gradle 플러그인(autolinking)이 앱 빌드에서 만드는 클래스 — react-native 고지
  if (cls === 'com/facebook/react/PackageList' || cls === 'com/facebook/react/ReactNativeApplicationEntryPoint') return 'react-native'
  // D8 이 만든 합성 클래스(Foo-IA·Foo-$$ExternalSynthetic…) — 바탕 클래스의 주인
  if (/-[A-Za-z0-9$]+$/.test(cls)) { const base = cls.replace(/-[A-Za-z0-9$]+$/, ''); if (base !== cls) { const o = ownerOfClass(base); if (o) return o } }
  // 안쪽 클래스(A$B$1)는 바깥으로 줄여 가며 찾는다 — 이름 자체에 $ 가 든 클래스(ComposableSingletons$FooKt)가 있어 첫 $ 로 자르지 않는다
  for (let c = cls; ; c = c.slice(0, c.lastIndexOf('$'))) {
    if (classOwner.has(c)) return classOwner.get(c)
    if (!c.includes('$')) break
  }
  const top = cls.split('$')[0]
  const r = top.match(/^(.*)\/R$/)
  if (r && rOwner.has(r[1])) return rOwner.get(r[1])
  // 소스에서 선언한 패키지(또는 namespace 아래의 생성 클래스 R·BuildConfig) — 가장 긴 접두
  let best = null
  for (const [p, n] of pkgDecl) if (cls.startsWith(`${p}/`) && (!best || p.length > best[0].length)) best = [p, n]
  return best ? best[1] : null
}
for (const name of [...apk.entries.keys()].filter((n) => /^classes\d*\.dex$/.test(n))) {
  for (const cls of dexClasses(apk.read(name))) {
    classes++
    if (cls.startsWith(`${appPackage}/`)) continue // 앱 자신(MainActivity·생성 R/BuildConfig)
    const owner = ownerOfClass(cls)
    if (owner === null) { const k = cls.includes('/') ? cls.slice(0, cls.lastIndexOf('/')).replace(/\//g, '.') : '(기본 패키지)'; unowned.set(k, (unowned.get(k) ?? 0) + 1); continue }
    if (!comps.some((c) => c.name === owner)) bad(`클래스 주인이 고지에 없다: ${owner} (${cls})`)
  }
}
for (const [k, n] of unowned) bad(`주인을 못 찾은 dex 클래스: ${k}.* ${n}개`) // # guard:av-class
if (classes === 0 || indexed === 0) bad('dex 클래스·고지 아티팩트를 하나도 못 읽었다 — 대조 불가') // # guard:av-noclass

// ② 네이티브 라이브러리
const LIBCXX = 'LLVM libc++ (Android NDK libc++_shared.so)'
for (const name of [...apk.entries.keys()].filter((n) => /^lib\/[^/]+\/[^/]+\.so$/.test(n))) {
  const so = path.basename(name)
  if (so === 'libc++_shared.so') { if (!comps.some((c) => c.name === LIBCXX)) bad(`NDK libc++ 고지 누락 (${name})`); continue }
  // RN 앱 템플릿 CMake(react-native/ReactAndroid/cmake-utils)가 앱 빌드에서 만드는 라이브러리 — react-native 고지
  const owner = soOwner.get(so) ?? (so === 'libappmodules.so' || so.startsWith('libreact_codegen_') ? 'react-native' : null)
  if (!owner) bad(`주인을 못 찾은 네이티브 라이브러리: ${name}`) // # guard:av-so
  else if (!comps.some((c) => c.name === owner)) bad(`네이티브 라이브러리 주인이 고지에 없다: ${owner} (${name})`)
}

// ③ META-INF/*.version
for (const name of [...apk.entries.keys()].filter((n) => /^META-INF\/[^/]+\.version$/.test(n))) {
  const [g, a] = path.basename(name, '.version').split('_')
  const v = apk.read(name).toString('utf8').trim()
  if (!/^\d+(\.\d+)*([-.+][\w.]+)?$/.test(v)) { notes.push(`버전 꼴이 아닌 .version — 대조 공백: ${name} (${v.slice(0, 60)})`); continue }
  // 멀티플랫폼 모듈은 우산 이름으로 .version 을 쓰고 실물은 -android·-jvm 좌표다. kotlinx 는 「kotlinx_coroutines_core」 꼴(이름의 - → _)
  const base = path.basename(name, '.version')
  const match = comps.some((c) => c.kind === 'maven' && c.version === v && ['', '-android', '-jvm'].some((sfx) => { const [cg, ca] = c.name.split(':'); return `${cg}_${ca}` === `${base}${sfx}` || ca.replace(/-/g, '_') === `${base}${sfx}`.replace(/-/g, '_') }))
  if (!match) bad(`maven 고지 누락·버전 다름: ${g}:${a}@${v} (${name})`) // # guard:av-version
}

// ④ assets
const fontOwner = new Map()
const fonts = path.join(mobile, 'assets/fonts')
for (const f of fs.readdirSync(fonts)) if (f.endsWith('.ttf')) fontOwner.set(sha256(fs.readFileSync(path.join(fonts, f))), `${f.split('_')[0]} (font)`)
for (const name of [...apk.entries.keys()].filter((n) => n.startsWith('assets/') && !n.endsWith('/'))) {
  if (name.startsWith(NOTICE) || name === 'assets/index.android.bundle' || name === 'assets/app.config' || name.startsWith('assets/dexopt/')) continue
  const h = sha256(apk.read(name))
  const owner = assetOwner.get(h) ?? fontOwner.get(h)
  if (!owner) bad(`주인을 못 찾은 asset: ${name}`) // # guard:av-asset
  else if (!comps.some((c) => c.name === owner)) bad(`asset 주인이 고지에 없다: ${owner} (${name})`)
}

// ⑤ JS 번들
const work = opt('--work', null)
let mapped = 0
if (args.includes('--no-js')) notes.push('JS 번들 대조 건너뜀(--no-js) — 소스맵 없이 돌린 회차')
else if (!work) bad('JS 번들 대조에 --work(EAS 작업 폴더)가 필요하다 — 생략하려면 --no-js')
else {
  const found = { map: [], bundle: [] }
  walk(work, (f) => {
    if (f.endsWith('/sourcemaps/react/release/index.android.bundle.map')) found.map.push(f)
    if (/\/generated\/assets\/[^/]+\/release\/index\.android\.bundle$/.test(f)) found.bundle.push(f)
  })
  if (found.map.length !== 1 || found.bundle.length !== 1) bad(`작업 폴더에서 번들·소스맵을 하나씩 찾지 못했다(번들 ${found.bundle.length} · 소스맵 ${found.map.length})`)
  else if (sha256(fs.readFileSync(found.bundle[0])) !== sha256(apk.read('assets/index.android.bundle'))) bad('작업 폴더의 번들이 APK 의 assets/index.android.bundle 과 다르다 — 다른 빌드의 소스맵으로 대조하지 않는다') // # guard:av-tie
  else {
    const map = JSON.parse(fs.readFileSync(found.map[0], 'utf8'))
    const root = path.dirname(found.map[0])
    for (const s of map.sources) {
      mapped++
      const abs = path.resolve(root, map.sourceRoot ?? '', s)
      const m = abs.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//)
      if (!m || !fs.existsSync(path.join(m[1], 'package.json'))) continue
      const pkg = JSON.parse(fs.readFileSync(path.join(m[1], 'package.json'), 'utf8'))
      if (!has('npm', pkg.name, pkg.version)) bad(`npm 고지 누락: ${pkg.name}@${pkg.version} (JS 번들 소스맵)`) // # guard:av-npm
    }
    if (mapped === 0) bad('소스맵 sources 가 비었다 — 대조 불가')
  }
}
const resCount = [...apk.entries.keys()].filter((n) => n.startsWith('res/')).length
notes.push(`res/ ${resCount}개 — aapt 가 이름·내용을 바꿔 출처 대조 공백`)

const summary = [
  `고지 ${comps.length}건 · dex 클래스 ${classes} · 색인 아티팩트 ${indexed} · 소스맵 sources ${mapped}`,
  ...notes.map((n) => `· ${n}`),
  ...problems.map((p) => `✖ ${p}`),
  problems.length ? `✖ 고지 대조 실패 ${problems.length}건` : '✔ 고지 대조 통과 — APK 안에서 본 것 ⊆ 고지 목록',
].join('\n')
const report = opt('--report', null)
if (report) fs.writeFileSync(report, summary + '\n')
console.log(summary)
process.exit(problems.length ? 1 : 0)
