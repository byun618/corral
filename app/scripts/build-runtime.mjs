import { build } from 'esbuild'
await build({ entryPoints: ['src/runtime/cli.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'out/runtime/cli.mjs', sourcemap: true })
