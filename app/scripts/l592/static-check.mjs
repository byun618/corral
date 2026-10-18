// LIFE-592 최종 관문 — 정적 검사(E9ⓓⓔ·E10ⓒⓔ) 한 번. 기준 commit 대비 git diff·grep 으로만 본다(실행 앱 무접촉).
// 사용(app/ 에서): node scripts/l592/static-check.mjs <기준 commit> <OUT.json>
// 검사마다 양성 대조(같은 판별식이 위반을 넣은 문자열에서는 잡는다)를 함께 돌린다 — 빈 결과가 「못 봄」 이 아님을 보인다.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const [base, out] = process.argv.slice(2)
if (base === undefined || out === undefined) throw new Error('사용: static-check.mjs <base> <OUT.json>')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const result = { at: new Date().toISOString(), base, head: git('rev-parse', '--short', 'HEAD').trim(), checks: [] }
const check = (name, ok, data) => {
  result.checks.push({ name, ok, data })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(data).slice(0, 300)}`}`)
}

// ⓓ 새 IPC 핸들러는 전부 fromOurWindow — 기준 대비 더해진 ipcMain.handle/on 줄과 그 본문 첫 줄들
const unguarded = (source, added) =>
  added.filter((channel) => {
    const at = source.indexOf(`'${channel}'`)
    const body = source.slice(at, at + 400)
    return !/fromOurWindow\(event\)/.test(body)
  })
const indexNow = fs.readFileSync('src/main/index.ts', 'utf8')
const addedChannels = [...git('diff', base, '--', 'src/main/index.ts').matchAll(/^\+.*ipcMain\.(?:handle|on)\('([^']+)'/gm)].map((m) => m[1])
check('ⓓ 새 IPC 핸들러 전부 fromOurWindow', addedChannels.length > 0 && unguarded(indexNow, addedChannels).length === 0, { addedChannels, unguarded: unguarded(indexNow, addedChannels) })
check('ⓓ 양성 대조 — fromOurWindow 없는 핸들러는 잡힌다', unguarded(`ipcMain.handle('x:probe', async (event) => { return 1 })`, ['x:probe']).length === 1, null)

// ⓓ contextIsolation·sandbox·nodeIntegration 줄 변화 0
const webPrefDiff = git('diff', base, '--', 'src/main/index.ts').split('\n').filter((line) => /^[+-](?![+-])/.test(line) && /contextIsolation|sandbox\s*:|nodeIntegration|webSecurity/.test(line))
check('ⓓ contextIsolation·sandbox·nodeIntegration·webSecurity 변화 0', webPrefDiff.length === 0, webPrefDiff)
check('ⓓ 양성 대조 — 바뀐 줄은 잡힌다', ['-      sandbox: true,', '+      sandbox: false,'].filter((line) => /^[+-](?![+-])/.test(line) && /contextIsolation|sandbox\s*:|nodeIntegration|webSecurity/.test(line)).length === 2, null)

// ⓓ 렌더러 Node fs 직접 사용 0 — src/renderer 의 import/require 에 fs·node:fs·fs/promises·child_process
const fsPattern = /(?:from\s+['"](?:node:)?(?:fs|fs\/promises|child_process)['"]|require\(\s*['"](?:node:)?(?:fs|fs\/promises|child_process)['"]\s*\))/
const rendererFiles = git('ls-files', 'src/renderer').split('\n').filter((file) => /\.(ts|tsx|js|mjs)$/.test(file) && !/\.test\.(ts|tsx|js|mjs)$/.test(file))
const fsHits = rendererFiles.filter((file) => fsPattern.test(fs.readFileSync(file, 'utf8')))
check('ⓓ 렌더러(시험 파일 밖) Node fs·child_process 직접 사용 0', fsHits.length === 0, { files: rendererFiles.length, fsHits })
check('ⓓ 양성 대조 — fs import 는 잡힌다', fsPattern.test(`import fs from 'node:fs'`) && fsPattern.test(`const x = require('fs')`), null)

// ⓓ CSP diff 0
const cspDiff = git('diff', base, '--', 'src/renderer/index.html')
check('ⓓ CSP(src/renderer/index.html) diff 0', cspDiff.trim() === '', cspDiff.slice(0, 400))

// ⓓ preload 가 렌더러에 shell 을 내놓지 않음
const preload = fs.readFileSync('src/preload/index.ts', 'utf8')
const shellPattern = /\bshell\b/
check('ⓓ preload 에 shell 노출 0', !shellPattern.test(preload.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), null)
check('ⓓ 양성 대조 — shell 은 잡힌다', shellPattern.test(`import { shell } from 'electron'`), null)

// ⓔ 휴지통 경로는 shell.trashItem 만 — 영구 삭제 API 호출 0(탐색기 조작 코드)
const deletePattern = /\b(?:unlink|unlinkSync|rmdir|rmdirSync|rmSync|rm)\(/
const opFiles = ['src/main/explorer-ops.ts', 'src/shared/explorer-ops.ts', 'src/renderer/src/hooks/useFileOps.ts']
const deleteHits = opFiles.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').map((line, index) => ({ file, line: index + 1, text: line.trim() })).filter((row) => !row.text.startsWith('//') && !row.text.startsWith('*') && deletePattern.test(row.text)))
const trashCalls = indexNow.split('\n').filter((line) => /trashItem/.test(line)).map((line) => line.trim())
check('ⓔ 탐색기 조작 코드 영구 삭제 API 호출 0 · 휴지통 = shell.trashItem', deleteHits.length === 0 && trashCalls.some((line) => line.includes('shell.trashItem')), { deleteHits, trashCalls })
check('ⓔ 양성 대조 — fs.rm( 은 잡힌다', deletePattern.test(`await fs.rm(target, { recursive: true })`) && deletePattern.test(`fs.unlinkSync(p)`), null)

// E10ⓔ quit-gate.ts diff 0 · E10ⓒ 새 의존성 0(package.json·package-lock.json diff 0)
const quit = git('diff', '--stat', base, '--', 'src/main/quit-gate.ts', 'src/renderer/src/quit-gate.ts').trim()
const quitFiles = git('ls-files', '--', '*quit-gate*').trim()
check('E10ⓔ quit-gate.ts diff 0', quit === '' && quitFiles !== '', { quitFiles, quit })
const deps = git('diff', '--stat', base, '--', 'package.json', 'package-lock.json').trim()
check('E10ⓒ 새 의존성 0(package.json·package-lock.json diff 0)', deps === '', deps)
// 제품 코드 무변경 — 최종 관문 대상 HEAD(제품) 이후 app/src diff 0
const product = process.env.L592_PRODUCT_HEAD ?? null
if (product !== null) check(`최종 관문 동안 제품 코드 무변경(app/src diff ${product}..HEAD = 0)`, git('diff', '--stat', product, '--', 'src').trim() === '', null)

result.pass = result.checks.every((row) => row.ok)
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
console.log(`결과 ${result.pass ? '통과' : '미달'} — ${result.checks.length}건`)
process.exitCode = result.pass ? 0 : 1
