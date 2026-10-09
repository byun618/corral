import '../global.css'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { shouldGoHome, shouldGoToIntro } from '../src/core/route'
import { startConnection, useConnection } from '../src/runtime/connection'
import { color } from '../src/ui/tokens'

startConnection()

/** 해지·인증 실패·해제(삭제 중·실패 포함)면 어느 화면에 있든 A1 로, 토큰이 있는데 A1·스캔이면 홈으로 — 판단은 `shouldGoToIntro`·`shouldGoHome`. */
function useUnpairedGuard() {
  const { conn } = useConnection()
  const segments = useSegments()
  const router = useRouter()
  const target = shouldGoToIntro(conn, segments) ? '/pair' : shouldGoHome(conn, segments) ? '/home' : null
  useEffect(() => {
    if (target !== null) router.replace(target)
  }, [target, router])
}

export default function RootLayout() {
  useUnpairedGuard()
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.surface }, animation: 'fade' }} />
    </SafeAreaProvider>
  )
}
