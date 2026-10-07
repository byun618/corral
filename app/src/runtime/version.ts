// CLI 가 찍는 버전 (LIFE-555 G1) — `scripts/build-runtime.mjs` 가 `app/package.json` 의 version 을 esbuild define 으로 넣는다.
// 같은 version 이 electron-builder 의 `CFBundleShortVersionString` 이 되므로 `corral --version` = 번들 버전이다.
// 번들을 거치지 않은 실행(vitest·tsx)에는 주입이 없어 'dev' 로 둔다.
declare const __CORRAL_VERSION__: string | undefined
export const CORRAL_VERSION: string = typeof __CORRAL_VERSION__ === 'string' ? __CORRAL_VERSION__ : 'dev'
