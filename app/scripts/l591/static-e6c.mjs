// LIFE-591 E6ⓒ 정적 검사 — 기준 `4fc88fec6` 대비 새로 생긴 IPC 핸들러가 전부 `fromOurWindow` 를 거치는가 · BrowserWindow webPreferences(contextIsolation·sandbox·nodeIntegration) diff 0 ·
// CSP(index.html meta) diff 0 · 렌더러 소스에 Node fs/child_process 사용 0. 실패가 하나라도 있으면 exit 1.
// 사용(app/ 에서): node scripts/l591/static-e6c.mjs [기준 commit]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const base = process.argv[2] ?? '4fc88fec6'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const show = (file) => git('show', `${base}:app/${file}`)
const checks = []
const check = (id, pass, value) => {
  checks.push({ id, pass: Boolean(pass), value })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(value).slice(0, 600)}`)
}

// ① 새 IPC 핸들러 — 채널 이름을 기준과 비교해 새 것만, 각 등록문 뒤 본문 첫 15줄 안에 fromOurWindow 가 있는가
const handlerRe = /ipcMain\.(handle|on)\('([^']+)'/g
const mainFiles = git('ls-files', 'src/main').split('\n').filter((file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file)).map((file) => file.replace(/^app\//, ''))
const channelsNow = new Map()
for (const file of mainFiles) {
  const text = fs.readFileSync(file, 'utf8')
  for (const match of text.matchAll(handlerRe)) {
    const body = text.slice(match.index, match.index + 1200).split('\n').slice(0, 15).join('\n')
    channelsNow.set(match[2], { file, kind: match[1], guarded: body.includes('fromOurWindow(event)') })
  }
}
const baseMainFiles = git('ls-tree', '-r', '--name-only', base, 'src/main').split('\n').filter((file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file)).map((file) => file.replace(/^app\//, ''))
const channelsBase = new Set()
for (const file of baseMainFiles) for (const match of show(file).matchAll(handlerRe)) channelsBase.add(match[2])
const added = [...channelsNow.entries()].filter(([channel]) => !channelsBase.has(channel)).map(([channel, value]) => ({ channel, ...value }))
check('E6c-new-handlers-listed', added.length > 0, added.map((row) => row.channel))
check('E6c-new-handlers-fromOurWindow', added.every((row) => row.guarded), added)

// ② webPreferences — BrowserWindow 생성 옵션의 contextIsolation·sandbox·nodeIntegration·webSecurity 줄 diff
const prefLines = (text) => text.split('\n').filter((line) => /contextIsolation|sandbox\s*:|nodeIntegration|webSecurity|preload\s*:/.test(line)).map((line) => line.trim())
const indexNow = prefLines(fs.readFileSync('src/main/index.ts', 'utf8'))
const indexBase = prefLines(show('src/main/index.ts'))
check('E6c-webPreferences-diff0', JSON.stringify(indexNow) === JSON.stringify(indexBase), { now: indexNow, base: indexBase })

// ③ CSP — 렌더러 index.html 의 Content-Security-Policy meta
const csp = (text) => text.match(/Content-Security-Policy"[^>]*content="([^"]+)"/)?.[1] ?? null
const cspNow = csp(fs.readFileSync('src/renderer/index.html', 'utf8'))
const cspBase = csp(show('src/renderer/index.html'))
check('E6c-csp-diff0', cspNow !== null && cspNow === cspBase, { now: cspNow, base: cspBase })
// main 이 응답 헤더로 CSP 를 바꾸는 코드가 새로 생기지 않았는가
// git grep 은 일치가 없으면 exit 1 — 0 줄로 센다
const grepCount = (...rev) => {
  try {
    return git('grep', '-n', '-e', 'onHeadersReceived', '-e', 'Content-Security-Policy', ...rev, '--', 'src/main').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}
const headerNow = grepCount()
const headerBase = grepCount(base)
check('E6c-csp-header-code-same', headerNow === headerBase, { now: headerNow, base: headerBase })

// ④ 렌더러 Node 사용 0 — fs·child_process·require·process. 접근
const rendererFiles = git('ls-files', 'src/renderer/src').split('\n').filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file)).map((file) => file.replace(/^app\//, ''))
const nodeUse = []
for (const file of rendererFiles) {
  const text = fs.readFileSync(file, 'utf8')
  text.split('\n').forEach((line, index) => {
    if (/from ['"](node:)?(fs|fs\/promises|child_process|path|os)['"]|require\(/.test(line)) nodeUse.push(`${file}:${index + 1}: ${line.trim()}`)
  })
}
check('E6c-renderer-node-fs-0', nodeUse.length === 0, nodeUse)

// ⑤ preload — 새로 내놓은 함수는 ipcRenderer 를 통째로 내놓지 않는다
const preload = fs.readFileSync('src/preload/index.ts', 'utf8')
check('E6c-preload-no-raw-ipcRenderer', !/exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/.test(preload) && !/:\s*ipcRenderer\s*[,}]/.test(preload), path.basename('src/preload/index.ts'))

const failed = checks.filter((row) => !row.pass)
console.log(failed.length === 0 ? 'ALL PASS' : `FAILED ${failed.map((row) => row.id).join(' ')}`)
process.exitCode = failed.length === 0 ? 0 : 1
