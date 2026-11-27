// LIFE-729 C9 — 제3자 고지 공용 함수. dmg 쪽(`build-notices.mjs`·`verify-notices.mjs`)과 APK 쪽(`mobile/scripts/*-notices.mjs`)이 같이 쓴다.
// 고지 한 건 = { kind, name, version, license, source, texts: [{ file, text }], textFrom: 'package' | 'spdx' | 'upstream', copyright? }
//   textFrom 'package' = 패키지 안 LICENSE·COPYING·NOTICE 파일 원문. 'spdx' = 패키지에 파일이 없어 `spdx/<id>.txt` 표준 원문 + copyright(메타데이터의 저작권자 출처).
//   'upstream' = 아티팩트에 파일이 없어 상류 레포의 원문 사본(mobile/scripts/notice-texts/).
//   원문을 어느 쪽으로도 못 만든 건은 texts 가 비고 missingReason 이 붙는다 — 생성기는 그 목록을 따로 내고, 대조기는 빈 원문을 실패로 센다.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

const here = path.dirname(new URL(import.meta.url).pathname)
export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// 패키지 폴더 맨 위의 라이선스 파일 — LICENSE·LICENCE·COPYING·NOTICE·UNLICENSE·COPYRIGHT 로 시작하는 파일(대소문자 무시, 폴더 제외)
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright|thirdpartynotices)/i
export function licenseFiles(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => LICENSE_FILE.test(name) && fs.statSync(path.join(dir, name)).isFile())
    .sort()
    .map((file) => ({ file, text: fs.readFileSync(path.join(dir, file), 'utf8') }))
}

// SPDX 식 안의 id — 괄호·AND·OR·WITH 를 걷어낸다. 옛 cargo 꼴 「MIT/Apache-2.0」 도 나눈다
export function spdxIds(expr) {
  return [...new Set(String(expr ?? '').split(/[\s()/]+/).filter((t) => t && !/^(AND|OR|WITH)$/i.test(t)))]
}

// SPDX 표준 원문의 저작권 자리표시자 줄(MIT 「Copyright (c) <year> <copyright holders>」·BSD 「Copyright (c) <year> <owner>.」) — 고지에는 빼고,
// 저작권자는 그 건의 머리줄 「Copyright:」(패키지 메타데이터 출처)가 맡는다. 대조기는 고지의 SPDX 원문 구간에 이 꼴이 남으면 실패로 센다
export const SPDX_PLACEHOLDER = /^Copyright \(c\) <year> <[^>\n]+>\.? *$/m
export function spdxText(id) {
  const file = path.join(here, 'spdx', `${id}.txt`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(new RegExp(`${SPDX_PLACEHOLDER.source}\\n?`, 'm'), '').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n') : null
}

// 패키지 파일이 있으면 그 원문, 없으면 SPDX 표준 원문 + 저작권 줄 출처. 둘 다 안 되면 missingReason
export function resolveTexts({ dir, license, copyright }) {
  const own = licenseFiles(dir)
  if (own.length) return { texts: own, textFrom: 'package' }
  const ids = spdxIds(license)
  const texts = ids.map((id) => ({ file: `SPDX:${id}`, text: spdxText(id) }))
  const lacking = texts.filter((t) => t.text === null).map((t) => t.file.slice(5))
  if (!ids.length) return { texts: [], textFrom: 'spdx', copyright, missingReason: '패키지에 라이선스 파일도 라이선스 식도 없다' }
  if (lacking.length) return { texts: [], textFrom: 'spdx', copyright, missingReason: `패키지에 라이선스 파일이 없고 SPDX 원문이 레포에 없다: ${lacking.join(', ')}` }
  return { texts, textFrom: 'spdx', copyright: copyright || '저작권자 표기 없음 — 패키지 메타데이터(author·authors)가 비었다. 출처는 source 줄' }
}

export const key = (c) => `${c.kind}:${c.name}@${c.version}`
// 저작권 고지 복제가 조건인 라이선스(MIT·ISC·BSD 계열) — SPDX 표준 원문으로 실을 때 저작권자 줄이 있어야 한다
export const HOLDER_FALLBACK = '저작권자 표기 없음'
export const needsHolder = (c) => c.textFrom === 'spdx' && c.texts.length > 0 && /(^|[\s(])(MIT|ISC|BSD-[234]-Clause[\w-]*)\b/.test(c.license ?? '') && (!c.copyright || c.copyright.startsWith(HOLDER_FALLBACK))

// 고지 원문 — 사람이 읽는 한 파일. 건마다 머리줄(이름·버전·라이선스·출처) 뒤에 원문
export function renderText(title, components) {
  const out = [title, '', `${components.length} components. Each entry: name, version, license, source, then the license text.`, '']
  for (const c of components) {
    out.push('='.repeat(78), `${c.name} ${c.version}`, `License: ${c.license ?? 'UNKNOWN'}`, `Source: ${c.source ?? '-'}`)
    if (c.copyright) out.push(`Copyright: ${c.copyright}`)
    if (c.textFrom === 'spdx' && c.texts.length) out.push('(No license file in the package — SPDX standard text below; the copyright holder is the Copyright line above.)')
    if (c.textFrom === 'upstream') out.push('(No license file in the artifact — text copied from the upstream repository named in Source.)')
    if (c.missingReason) out.push(`(License text not found: ${c.missingReason})`)
    out.push('')
    for (const t of c.texts) out.push(`--- ${t.file} ---`, t.text.trimEnd(), '')
  }
  return out.join('\n') + '\n'
}

// 기계용 목록 — 원문 대신 sha256. 대조기가 읽는다
export function renderJson(meta, components) {
  return (
    JSON.stringify(
      {
        ...meta,
        components: components.map(({ texts, ...c }) => ({ ...c, texts: texts.map((t) => ({ file: t.file, sha256: sha256(t.text) })) })),
      },
      null,
      1,
    ) + '\n'
  )
}

// 패키지에 LICENSE 파일도 author 도 없을 때 — package.json repository 가 가리키는 상류 레포 LICENSE 의 저작권 줄(그 레포 원문에서 확인한 줄만, 확인한 ref 를 같이 적는다).
// MIT·BSD 는 저작권 고지 복제가 조건이라 SPDX 표준 원문만으로는 모자란다. 레포를 더하려면 상류 LICENSE 원문을 먼저 확인한다
export const UPSTREAM_COPYRIGHT = {
  'facebook/react-native': 'Copyright (c) Meta Platforms, Inc. and affiliates. (upstream LICENSE, github.com/facebook/react-native @ v0.81.5)',
  'facebook/metro': 'Copyright (c) Meta Platforms, Inc. and affiliates. (upstream LICENSE, github.com/facebook/metro @ v0.83.3·v0.83.8)',
  'react/metro': 'Copyright (c) Meta Platforms, Inc. and affiliates. (upstream LICENSE, github.com/facebook/metro @ v0.83.3·v0.83.8 — repository 가 옮긴 이름 react/metro)',
  'facebook/react': 'Copyright (c) Meta Platforms, Inc. and affiliates. (upstream LICENSE, github.com/facebook/react @ v19.1.0·main)',
  'radix-ui/primitives': 'Copyright (c) 2022 WorkOS (upstream LICENSE, github.com/radix-ui/primitives @ main — 2022-06 뒤 무변경)',
  'expo/expo': 'Copyright (c) 2015-present 650 Industries, Inc. (aka Expo) (upstream LICENSE, github.com/expo/expo @ sdk-54)',
}
export function repoSlug(repo) {
  const m = String(repo ?? '').match(/github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:[/#]|$)/) ?? String(repo ?? '').match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

// npm 패키지 한 건 — 폴더의 package.json 에서
export function npmComponent(kind, dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(' OR ') : null)
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const source = repo ?? pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`
  const copyright = author ? `${author} (package.json author)` : UPSTREAM_COPYRIGHT[repoSlug(repo)] ?? ''
  return { kind, name: pkg.name, version: pkg.version, license, source, ...resolveTexts({ dir, license, copyright }) }
}

// 모듈 파일 경로 → 그 파일이 든 npm 패키지 폴더(마지막 node_modules/<이름> 또는 node_modules/@범위/<이름>). node_modules 밖이면 null
export function packageDirOf(file) {
  const m = file.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/)
  return m ? m[1] : null
}

// 패키지 폴더 안에서 가장 가까운 package.json 이 name 을 가진 곳 — 하위 폴더 package.json({ "type": "module" } 따위)은 건너뛴다
export function packageRootOf(file) {
  const dir = packageDirOf(file)
  return dir && fs.existsSync(path.join(dir, 'package.json')) ? dir : null
}

// 소스맵 source 한 줄 → 그 파일이 든 npm 패키지 폴더. 대조기(dmg·APK)가 같이 쓴다
//   { outside: true } = node_modules 밖(앱 자신의 소스) · { dir, via: 'map' } = 맵 위치(+sourceRoot) 기준으로 찾음
//   { dir, via: 'ancestor' } = 맵 위치 기준으로는 없고, 맵 폴더의 조상(stopAt 까지)에 source 의 「node_modules/…」 꼬리 경로가 실제 파일로 있다
//     (번들러가 다른 기준 폴더로 쓴 맵 — vite worker 번들의 맵은 sources 가 출력 폴더가 아니라 한 단계 위 기준이다)
//   null = node_modules 아래인데 어디서도 못 찾음 — 대조기는 건너뛰지 않고 실패로 센다
export function sourcePackage({ mapDir, sourceRoot, source, stopAt }) {
  const abs = path.resolve(mapDir, sourceRoot ?? '', source)
  if (!/\/node_modules\//.test(abs)) return { outside: true }
  const direct = packageRootOf(abs)
  if (direct) return { dir: direct, via: 'map' }
  const i = source.indexOf('node_modules/')
  if (i < 0) return null
  const tail = source.slice(i)
  const stop = path.resolve(stopAt)
  for (let anc = path.resolve(mapDir); ; anc = path.dirname(anc)) {
    const cand = path.join(anc, tail)
    const dir = fs.existsSync(cand) && fs.statSync(cand).isFile() ? packageRootOf(cand) : null
    if (dir) return { dir, via: 'ancestor' }
    if (anc === stop || anc === path.dirname(anc) || !anc.startsWith(stop)) return null
  }
}

// zip 읽기(APK·aar·jar) — 중앙 디렉터리만 보고 본문은 꺼낼 때 푼다(stored·deflate). 의존 패키지 없이
export function readZip(buf) {
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('zip 끝 레코드가 없다')
  const count = buf.readUInt16LE(eocd + 10)
  let o = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error('zip 중앙 디렉터리가 깨졌다')
    const method = buf.readUInt16LE(o + 10)
    const csize = buf.readUInt32LE(o + 20)
    const nlen = buf.readUInt16LE(o + 28)
    const xlen = buf.readUInt16LE(o + 30)
    const clen = buf.readUInt16LE(o + 32)
    const local = buf.readUInt32LE(o + 42)
    const name = buf.toString('utf8', o + 46, o + 46 + nlen)
    entries.set(name, { method, csize, local })
    o += 46 + nlen + xlen + clen
  }
  const read = (name) => {
    const e = entries.get(name)
    if (!e) return null
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28)
    const raw = buf.subarray(start, start + e.csize)
    if (e.method === 0) return Buffer.from(raw)
    if (e.method === 8) return zlib.inflateRawSync(raw)
    throw new Error(`zip 압축 방식 ${e.method} 를 못 푼다: ${name}`)
  }
  return { entries, read }
}

// asar 읽기 — 형식: [4 크기][4 헤더 크기][4][4 JSON 길이][JSON] 뒤가 파일 본문. 의존 패키지 없이 목록·본문만 꺼낸다
export function readAsar(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(12)
  const json = Buffer.alloc(jsonSize)
  fs.readSync(fd, json, 0, jsonSize, 16)
  const header = JSON.parse(json.toString('utf8'))
  const base = 8 + headerSize
  const entries = new Map()
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name
      if (child.files) walk(child, p)
      else entries.set(p, child)
    }
  }
  walk(header, '')
  const read = (p) => {
    const e = entries.get(p)
    if (!e) return null
    if (e.unpacked) return fs.readFileSync(path.join(`${file}.unpacked`, p))
    const buf = Buffer.alloc(Number(e.size))
    fs.readSync(fd, buf, 0, buf.length, base + Number(e.offset))
    return buf
  }
  return { entries, read, close: () => fs.closeSync(fd) }
}
