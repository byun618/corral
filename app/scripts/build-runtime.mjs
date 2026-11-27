import fs from 'node:fs'
import { build } from 'esbuild'
// `corral --version` 의 값 — 번들(`CFBundleShortVersionString`)과 같은 출처(LIFE-555 G1)
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const result = await build({ entryPoints: ['src/runtime/cli.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'out/runtime/cli.mjs', sourcemap: true, metafile: true, define: { __CORRAL_VERSION__: JSON.stringify(version) } })
// LIFE-729 C9 — 번들 입력 목록(제3자 고지 생성기 입력). out/ 밖이라 패키지에 들지 않는다 — electron.vite.config.ts 의 moduleList 와 같은 자리
fs.mkdirSync(new URL('../build/notices-input/', import.meta.url), { recursive: true })
fs.writeFileSync(new URL('../build/notices-input/runtime.json', import.meta.url), JSON.stringify(Object.keys(result.metafile.inputs).sort(), null, 1) + '\n')
