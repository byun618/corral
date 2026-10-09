import '../global.css'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { startConnection, useConnection } from '../src/runtime/connection'
import { color } from '../src/ui/tokens'

startConnection()

/** 토큰이 사라지면(해지·unauthorized·해제) 어느 화면에 있든 A1 로. */
function useUnpairedGuard() {
  const { conn } = useConnection()
  const segments = useSegments()
  const router = useRouter()
  const inPairing = segments[0] === 'pair'
  useEffect(() => {
    if (conn.kind === 'unpaired' && !inPairing && segments.length > 0) router.replace('/pair')
  }, [conn.kind, inPairing, segments.length, router])
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
