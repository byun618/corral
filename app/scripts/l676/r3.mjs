// LIFE-676 R3 캡처 회차 — app/ 에서: node scripts/l676/r3.mjs <root> <out 접두사>
// D pane 에 setuid-root 자식(top)을 띄워 하한 행을 만들고, 패널을 CDP 클릭으로 열어 dom-check.js 로 IPC 계산과 맞춘 뒤 세그먼트·패널 캡처.
// 분모 cpuCoreCount 원값은 main 의 os.cpus().length 로 따로 읽어 스냅샷 값과 맞춘다. 끝에 Esc 로 패널을 닫고 top 을 Ctrl-C.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const [root, out] = process.argv.slice(2)
const APP = process.cwd()
const handles = JSON.parse(fs.readFileSync(`${root}/final/handles.json`, 'utf8'))
const env = { ...process.env, CORRAL_RUNTIME_SOCKET: `${root}/ud/runtime/rpc.sock` }
const cli = (...args) => execFileSync('node', [`${APP}/cli/corral.mjs`, ...args], { encoding: 'utf8', env })
const cdp = (...args) => execFileSync('node', [`${APP}/scripts/l676/cdp.mjs`, root, ...args], { encoding: 'utf8' }).trim()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

cli('terminal', 'send', '--terminal', handles.D, '--text', 'top -l 0 -s 2 > /dev/null', '--enter')
await sleep(5000)
const mainCpus = JSON.parse(cdp('main', `globalThis.__l676.require('os').cpus().length`))
cdp('click', '[data-statusbar-resource]')
await sleep(300)
const dom = JSON.parse(cdp('eval', fs.readFileSync(`${APP}/scripts/l676/dom-check.js`, 'utf8')))
const shots = [JSON.parse(cdp('shot', `${out}-window.png`)), JSON.parse(cdp('shot', `${out}-panel.png`, '[data-statusbar-resource-panel]')), JSON.parse(cdp('shot', `${out}-segment.png`, '[data-statusbar-resource]'))]
cdp('key', 'Escape', 'Escape', '27')
cli('terminal', 'send', '--terminal', handles.D, '--interrupt')
const result = { mainCpus, coresMatch: dom.cpuCoreCount === mainCpus, dom, shots, pass: dom.panel !== false && dom.mismatches.length === 0 && dom.oneLine && dom.cpuCoreCount === mainCpus && dom.titles.some((t) => t.reason !== null) }
fs.writeFileSync(`${out}.json`, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ pass: result.pass, mainCpus, cores: dom.cpuCoreCount, mismatches: dom.mismatches, oneLine: dom.oneLine, label: dom.expectLabel, reasonRows: dom.titles.filter((t) => t.reason !== null).map((t) => t.label) }))
