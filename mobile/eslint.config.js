// Expo 기본 flat 설정 — `npx expo lint` 가 만드는 것과 같다.
const { defineConfig } = require('eslint/config')
const expoConfig = require('eslint-config-expo/flat')

module.exports = defineConfig([
  expoConfig,
  { ignores: ['node_modules/*', '.expo/*', 'android/*', 'ios/*', 'dist/*'] },
])
