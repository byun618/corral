// electron-vite 5 는 `externalizeDepsPlugin` 을 deprecated 하고 `build.externalizeDeps` 를
// **기본 활성**으로 바꿨다 (수정 1회차 L10 — grok L1). 그래서 플러그인을 걷어냈다.
// 1회차에도 빌드는 통과했지만(N1 exit 0), 5.x 안에서 경고 대상이고 차기 메이저 제거 후보다.

import fs from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * LIFE-729 C9 — 번들에 든 모듈 id 목록을 `build/notices-input/<이름>.json` 에 쓴다(제3자 고지 생성기 `scripts/build-notices.mjs` 의 입력).
 * out/ 밖이라 패키지에 들지 않는다. 대조기(`scripts/verify-notices.mjs`)는 이 목록이 아니라 숨은 소스맵(`sourcemap: 'hidden'` — 아래 세 곳)과
 * 패키지 안 자산 해시로 따로 뽑는다. 소스맵은 `electron-builder.yml` 의 `!out/**\/*.map` 으로 패키지에서 빠진다.
 */
function moduleList(name: string): Plugin {
  return {
    name: 'corral-module-list',
    apply: 'build',
    generateBundle() {
      const dir = resolve(__dirname, 'build/notices-input')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(resolve(dir, `${name}.json`), JSON.stringify([...this.getModuleIds()].sort(), null, 1) + '\n')
    },
  }
}

export default defineConfig({
  main: {
    plugins: [moduleList('main')],
    // LIFE-589 — 탐색기 감시 프로세스(utility process) 입구를 같은 폴더에 따로 낸다(`out/main/explorer-watcher.js`).
    build: { sourcemap: 'hidden', rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts'), 'explorer-watcher': resolve(__dirname, 'src/main/explorer-watcher.ts') } } },
  },
  preload: {
    plugins: [moduleList('preload')],
    // sandbox:true 인 렌더러의 preload 는 **단일 CJS 번들**이어야 로드된다 (ESM preload 는 조용히 실패).
    // 분석 §5 U2 가 확인한 현행 제약이다.
    build: {
      sourcemap: 'hidden',
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), moduleList('renderer')],
    // Monaco 편집기 worker(`?worker`)는 따로 번들된다 — 모듈 목록을 거기서도 낸다(소스맵은 build.sourcemap 을 따른다, LIFE-729 C9)
    worker: { plugins: () => [moduleList('renderer-worker')] },
    build: {
      sourcemap: 'hidden',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
      /**
       * xterm #5800 (열림) 회피 — R2 (LIFE-353).
       *
       * `@xterm/xterm` 의 ESM(`xterm.mjs`)은 **이미 minify 돼서** 배포된다. Vite 프로덕션이
       * 기본 target(es2020 이하 다운레벨)으로 그걸 **재-minify** 하면 `InputHandler.requestMode`
       * 의 클로저가 깨져 프로덕션 빌드에서만 `ReferenceError` 가 난다 — vim 처럼 DECRQM 을
       * 쓰는 TUI 입력이 죽는다. 정석 우회는 target 을 es2021 이상으로 올려 `||=` 다운레벨을
       * 없애는 것 (grok 서치 §3 — 이슈 댓글에서 효과 검증 1순위). Electron 44 의 Chromium 은
       * es2022 를 훨씬 넘으므로 여유가 크다. 실증은 기준 S7ⓕ (프로덕션 빌드 vim 생존).
       */
      target: 'es2022',
      /**
       * 자산을 **인라인하지 않는다** (LIFE-357 J-3). Vite 기본값(4 KB 미만 → base64 data: URI)
       * 이면 590 B 짜리 `grok.png` 가 `data:image/png;…` 로 들어가는데, 이 앱의 CSP 는
       * `index.html` 에서 `default-src 'self'` 라 **data: 는 img-src 에 안 걸린다** — 아이콘이
       * 조용히 안 그려진다. 파일로 내보내면 같은 출처라 통과한다.
       * (CSP 를 넓히는 쪽 대신 이쪽을 골랐다 — 보안 자세를 자산 하나 때문에 낮추지 않는다.)
       */
      assetsInlineLimit: 0,
    },
  },
})
