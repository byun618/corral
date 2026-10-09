import * as Application from 'expo-application'
import Constants from 'expo-constants'
import * as Device from 'expo-device'

/** 앱 버전 `0.1.0 (빌드)` — 설정(D1)·A4·A9 에 보인다. */
export function appVersion(): string {
  const version = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0.0.0'
  const build = Application.nativeBuildVersion
  return build === null || build.length === 0 ? version : `${version} (${build})`
}

/** 맥 기기 목록에 보일 이름 — 64자까지. */
export function deviceName(): string {
  const name = Device.deviceName ?? Device.modelName ?? 'Android 폰'
  return name.slice(0, 64)
}
