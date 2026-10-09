import type { ExpoConfig } from 'expo/config'

// 변형은 eas.json 프로필의 APP_VARIANT. development = 개발 클라이언트(패키지 `.dev`, 에뮬레이터 개발 접속 허용) ·
// preview·production = 판정·배포 APK(패키지 `io.github.byun618.corral.mobile`).
const variant = process.env.APP_VARIANT
const IS_DEV = variant === 'development'

const config: ExpoConfig = {
  name: IS_DEV ? 'corral (dev)' : 'corral',
  slug: 'corral-mobile',
  scheme: IS_DEV ? 'corral-dev' : 'corral',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  backgroundColor: '#0a0a0a',
  newArchEnabled: true,
  splash: { backgroundColor: '#0a0a0a' },
  android: {
    package: IS_DEV ? 'io.github.byun618.corral.mobile.dev' : 'io.github.byun618.corral.mobile',
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    softwareKeyboardLayoutMode: 'resize',
    permissions: ['android.permission.CAMERA'],
    blockedPermissions: ['android.permission.RECORD_AUDIO'],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-camera', { cameraPermission: '맥의 corral 페어링 QR 을 찍는 데만 카메라를 씁니다.', recordAudioAndroid: false }],
    ...(IS_DEV ? ['expo-dev-client'] : []),
  ],
  experiments: { typedRoutes: false },
  extra: {
    variant: variant ?? 'production',
    router: {},
    // eas init 2026-10-09 — Expo 계정 byun618 의 corral-mobile (게이트 ⓪ E5)
    eas: { projectId: '4cf6c707-7c77-41e9-81c6-a61f9bfc5b31' },
  },
  owner: 'byun618',
}

export default config
