// LIFE-729 C9ⓓⓔ — notice-test.sh 의 픽스처. 대조기(app/scripts/verify-notices.mjs · mobile/scripts/verify-notices.mjs)가 읽는 꼴의 작은 앱·APK 를 만든다.
// node notice-fixture.mjs dmg <폴더> <변형> · node notice-fixture.mjs apk <폴더> <변형>
//   dmg: <폴더>/corral.app(asar·herdr·Electron Framework·고지) + <폴더>/build(빌드 트리: out/·숨은 소스맵·node_modules/·src/)
//   apk: <폴더>/app.apk + <폴더>/gradle(GRADLE_USER_HOME) + <폴더>/mobile(--mobile) + <폴더>/work(EAS 작업 폴더)
// 변형 이름이 「drop:<이름>」 이면 그 고지 한 건을 뺀다(누락 양성). 나머지 변형은 아래 switch.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { renderJson, renderText } from '../notices-lib.mjs'

const [kind, dir, variant = 'clean'] = process.argv.slice(2)
const w = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, data)
}
const comp = (k, name, version, extra = {}) => ({ kind: k, name, version, license: 'MIT', source: 'https://example.invalid', texts: [{ file: 'LICENSE', text: `MIT — ${name}` }], textFrom: 'package', ...extra })
const writeNotices = (out, comps) => {
  const keep = comps.filter((c) => !(variant.startsWith('drop:') && c.name === variant.slice(5)))
  const txt = renderText('fixture', keep)
  // txthead — 목록에는 있는데 원문 파일에 그 머리줄이 없다
  w(path.join(out, 'THIRD-PARTY-NOTICES.txt'), variant === 'txthead' ? txt.replace(/\n[^\n]+ \d[^\n]*\nLicense: [^\n]*/, '\n(빠짐)') : txt)
  w(path.join(out, 'third-party.json'), renderJson({ target: kind }, keep))
}

// asar — [4: 4][4: 헤더 pickle 크기][4: 헤더 길이+4][4: JSON 길이][JSON] 뒤 본문
const writeAsar = (file, files) => {
  const header = { files: {} }
  let offset = 0
  const bodies = []
  for (const [p, data] of Object.entries(files)) {
    const parts = p.split('/')
    let node = header
    for (const d of parts.slice(0, -1)) node = node.files[d] ??= { files: {} }
    node.files[parts.at(-1)] = { size: data.length, offset: String(offset) }
    offset += data.length
    bodies.push(data)
  }
  const json = Buffer.from(JSON.stringify(header))
  const pad = (4 - (json.length % 4)) % 4
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(json.length + pad + 8, 4)
  head.writeUInt32LE(json.length + pad + 4, 8)
  head.writeUInt32LE(json.length, 12)
  w(file, Buffer.concat([head, json, Buffer.alloc(pad), ...bodies]))
}

// zip(저장 방식) — APK·aar·jar
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const zip = (files) => {
  const locals = []
  const centrals = []
  let off = 0
  for (const [name, data0] of Object.entries(files)) {
    const data = Buffer.from(data0)
    const n = Buffer.from(name)
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc32(data), 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42)
    locals.push(l, n, data)
    centrals.push(c, n)
    off += 30 + n.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, e])
}

// dex — 대조기가 읽는 칸만: string_ids(0x38·0x3c) · type_ids(0x40·0x44) · class_defs(0x60·0x64)
const dex = (descriptors) => {
  const strs = descriptors.map((d) => Buffer.concat([Buffer.from([d.length]), Buffer.from(d), Buffer.from([0])]))
  const strIdsOff = 0x70
  const typeIdsOff = strIdsOff + 4 * descriptors.length
  const classOff = typeIdsOff + 4 * descriptors.length
  let dataOff = classOff + 32 * descriptors.length
  const head = Buffer.alloc(dataOff)
  head.write('dex\n035\0', 0)
  head.writeUInt32LE(descriptors.length, 0x38); head.writeUInt32LE(strIdsOff, 0x3c)
  head.writeUInt32LE(descriptors.length, 0x40); head.writeUInt32LE(typeIdsOff, 0x44)
  head.writeUInt32LE(descriptors.length, 0x60); head.writeUInt32LE(classOff, 0x64)
  descriptors.forEach((_, i) => {
    head.writeUInt32LE(dataOff, strIdsOff + 4 * i)
    head.writeUInt32LE(i, typeIdsOff + 4 * i)
    head.writeUInt32LE(i, classOff + 32 * i)
    dataOff += strs[i].length
  })
  return Buffer.concat([head, ...strs])
}

if (kind === 'dmg') {
  const app = path.join(dir, 'corral.app/Contents')
  const build = path.join(dir, 'build')
  const js = Buffer.from('console.log("bundled baz")\n')
  const font = Buffer.from('FONTDATA-bar')
  const fooVersion = variant === 'stale' ? '1.1.0' : '1.0.0' // ⓔ — 의존을 올렸는데 고지를 다시 만들지 않음
  const asarFiles = {
    'package.json': Buffer.from('{"name":"corral"}'),
    'node_modules/foo/package.json': Buffer.from(JSON.stringify({ name: 'foo', version: fooVersion })),
    'out/main/index.js': js,
    'out/renderer/assets/a.woff2': font,
    'out/renderer/assets/g.woff2': Buffer.from('GEIST-own-asset'),
    ...(variant === 'unmapped' ? { 'out/renderer/assets/mystery.bin': Buffer.from('nobody') } : {}),
  }
  writeAsar(path.join(app, 'Resources/app.asar'), asarFiles)
  w(path.join(build, 'out/main/index.js'), variant === 'tie' ? Buffer.from('console.log("other build")\n') : js)
  if (variant !== 'nomap') w(path.join(build, 'out/main/index.js.map'), JSON.stringify({ version: 3, sources: ['../../node_modules/baz/index.js', '../../src/main/own.ts'], mappings: '' }))
  w(path.join(build, 'node_modules/baz/package.json'), JSON.stringify({ name: 'baz', version: '2.0.0' }))
  w(path.join(build, 'node_modules/baz/index.js'), 'x')
  w(path.join(build, 'node_modules/bar/package.json'), JSON.stringify({ name: 'bar', version: '3.0.0' }))
  w(path.join(build, 'node_modules/bar/font.woff2'), font)
  w(path.join(build, 'src/main/own.ts'), 'own')
  w(path.join(build, 'src/renderer/src/assets/fonts/Geist-Variable.woff2'), 'GEIST-own-asset')
  // herdr — crate 소스 경로 문자열·Rust(legacy) 심볼·C++ 네임스페이스·ghostty C 심볼을 가진 작은 Mach-O
  const c = path.join(dir, 'herdr.c')
  w(
    c,
    variant === 'nosym'
      ? 'int main(void){return 0;}\n'
      : [
          'const char *p = "/corral-herdr-build/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.2.3/src/lib.rs";',
          'int _ZN5tokio3run17h0123456789abcdefE(void){return 1;}',
          'int _ZN5serde3ser17h0123456789abcdefE(void){return 2;}',
          'int _ZN4core3fmt17h0123456789abcdefE(void){return 3;}',
          'int _ZN7simdutf8validateEv(void){return 4;}',
          'int ghostty_cell_get(void){return 5;}',
          'int main(void){return p[0] + _ZN5tokio3run17h0123456789abcdefE() + _ZN5serde3ser17h0123456789abcdefE() + _ZN4core3fmt17h0123456789abcdefE() + _ZN7simdutf8validateEv() + ghostty_cell_get();}',
          '',
        ].join('\n'),
  )
  fs.mkdirSync(path.join(app, 'Resources/backend'), { recursive: true })
  execFileSync('cc', ['-O0', '-o', path.join(app, 'Resources/backend/herdr'), c])
  if (variant === 'nosym') execFileSync('strip', [path.join(app, 'Resources/backend/herdr')])
  if (variant !== 'nofw') w(path.join(app, 'Frameworks/Electron Framework.framework/Resources/Info.plist'), '<plist><dict><key>CFBundleVersion</key>\n<string>44.3.0</string></dict></plist>\n')
  const ev = variant === 'electron' ? '44.2.0' : '44.3.0'
  const chromium = 'chromium licenses'
  w(path.join(app, 'Resources/licenses/third-party/electron/LICENSES.chromium.html'), variant === 'filesha' ? 'tampered' : chromium)
  writeNotices(path.join(app, 'Resources/licenses/third-party'), [
    comp('electron', 'Electron', ev),
    comp('electron', 'Chromium and its third-party components (in Electron)', ev, { texts: [{ file: 'electron/LICENSES.chromium.html', text: chromium }] }),
    comp('native', 'Rust standard library', '1.96.1'),
    comp('native', 'libghostty-vt (Ghostty)', '1.3.2'),
    comp('native', 'simdutf', '9.0.0'),
    comp('crate', 'tokio', '1.2.3'),
    comp('crate', 'serde', '1.0.0'),
    comp('npm', 'foo', '1.0.0'),
    comp('npm', 'baz', '2.0.0'),
    comp('npm', 'bar', '3.0.0', variant === 'notext' ? { texts: [] } : {}),
    comp('asset', 'Geist (font)', 'Geist-Variable.woff2'),
  ])
} else if (kind === 'apk') {
  const gh = path.join(dir, 'gradle/caches/modules-2/files-2.1')
  const classesJar = zip({ 'com/example/lib/Foo.class': 'cafe', 'com/example/lib/Foo$Inner.class': 'cafe', 'META-INF/LICENSE': 'Apache' })
  w(path.join(gh, 'com.example/closed/2.0/0c1d/closed-2.0.aar'), zip({ 'AndroidManifest.xml': '<manifest package="com.example.closed"/>' }))
  w(path.join(gh, 'com.example/lib/1.0/0a1b/lib-1.0.aar'), zip({ 'classes.jar': classesJar, 'jni/arm64-v8a/libexamplenative.so': 'elf', 'assets/model.bin': 'MODEL', 'AndroidManifest.xml': '<manifest package="com.example.lib"/>' }))
  const mobile = path.join(dir, 'mobile')
  w(path.join(mobile, 'assets/fonts/Geist_400Regular.ttf'), 'GEISTFONT')
  w(path.join(mobile, 'node_modules/npmmod/package.json'), JSON.stringify({ name: 'npmmod', version: '4.0.0' }))
  w(path.join(mobile, 'node_modules/npmmod/android/src/main/java/com/npm/Mod.kt'), 'package com.npm\nclass Mod\n')
  w(path.join(mobile, 'node_modules/npmmod/android/CMakeLists.txt'), 'set(PACKAGE_NAME "npmnative")\nadd_library(${PACKAGE_NAME} SHARED x.cpp)\n')
  const bundle = Buffer.from('HBC-bundle')
  const work = path.join(dir, 'work/build/mobile/android/app/build/generated')
  w(path.join(work, 'assets/createBundleReleaseJsAndAssets/release/index.android.bundle'), variant === 'tie' ? 'HBC-other' : bundle)
  if (variant !== 'nomapfile') w(path.join(work, 'sourcemaps/react/release/index.android.bundle.map'), JSON.stringify({ version: 3, sources: variant === 'emptymap' ? [] : ['../../../../../../../node_modules/jsdep/index.js'], mappings: '' }))
  w(path.join(dir, 'work/build/mobile/node_modules/jsdep/package.json'), JSON.stringify({ name: 'jsdep', version: '1.0.0' }))
  w(path.join(dir, 'work/build/mobile/node_modules/jsdep/index.js'), 'x')
  const classes = ['Lcom/example/lib/Foo;', 'Lcom/example/lib/Foo$Inner;', 'Lcom/example/lib/Foo-IA;', 'Lcom/example/lib/R$string;', 'Lcom/npm/Mod;', 'Lio/github/byun618/corral/mobile/MainActivity;', ...(variant === 'packagelist' ? ['Lcom/facebook/react/PackageList;'] : [])]
  const libVersion = variant === 'stale' ? '1.1' : '1.0' // ⓔ — 의존을 올렸는데 고지를 다시 만들지 않음
  const entries = {
    ...(variant === 'noclass' ? {} : { 'classes.dex': dex(variant === 'class' ? [...classes, 'Lorg/unknown/Thing;'] : classes) }),
    'lib/arm64-v8a/libexamplenative.so': 'elf',
    'lib/arm64-v8a/libnpmnative.so': 'elf',
    'lib/arm64-v8a/libc++_shared.so': 'elf',
    ...(variant === 'so' ? { 'lib/arm64-v8a/libmystery.so': 'elf' } : {}),
    ...(variant === 'appmodules' ? { 'lib/arm64-v8a/libappmodules.so': 'elf' } : {}),
    'META-INF/com.example_lib.version': libVersion,
    'assets/model.bin': 'MODEL',
    'assets/fonts/Geist_400Regular.ttf': 'GEISTFONT',
    ...(variant === 'asset' ? { 'assets/mystery.dat': 'who' } : {}),
    'assets/index.android.bundle': bundle,
  }
  if (variant !== 'nonotice') {
    const tmp = path.join(dir, 'notices')
    writeNotices(tmp, [
      comp('native', 'LLVM libc++ (Android NDK libc++_shared.so)', 'NDK 27'),
      comp('maven', 'com.example:lib', '1.0'),
      comp('npm', 'npmmod', '4.0.0'),
      comp('npm', 'jsdep', '1.0.0'),
      comp('asset', 'Geist (font)', 'assets/fonts'),
      ...(variant === 'notext' ? [comp('maven', 'com.example:closed', '2.0', { texts: [] })] : []),
      ...(variant === 'nocache' ? [comp('maven', 'com.example:ghost', '9.9')] : []),
      ...(variant === 'reason' ? [comp('maven', 'com.example:closed', '2.0', { texts: [], missingReason: 'SPDX 로 옮길 수 없는 라이선스: Closed <https://example.invalid>' })] : []),
    ])
    entries['assets/licenses/third-party/third-party.json'] = fs.readFileSync(path.join(tmp, 'third-party.json'))
    entries['assets/licenses/third-party/THIRD-PARTY-NOTICES.txt'] = fs.readFileSync(path.join(tmp, 'THIRD-PARTY-NOTICES.txt'))
  }
  w(path.join(dir, 'app.apk'), zip(entries))
} else {
  console.error('사용: node notice-fixture.mjs dmg|apk <폴더> <변형>')
  process.exit(2)
}
