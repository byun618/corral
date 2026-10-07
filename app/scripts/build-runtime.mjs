import fs from 'node:fs'
import { build } from 'esbuild'
// `corral --version` 의 값 — 번들(`CFBundleShortVersionString`)과 같은 출처(LIFE-555 G1)
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
await build({ entryPoints: ['src/runtime/cli.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'out/runtime/cli.mjs', sourcemap: true, define: { __CORRAL_VERSION__: JSON.stringify(version) } })
