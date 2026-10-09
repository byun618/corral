// 최소 홈 (E1) — 앱 바(`맥 이름 · 연결됨`) + 연결 띠 + 목록 자리. 대화방 목록(B)은 다음 작업이 덮는다.
// 버전 불일치면 본문을 막는다(B8). 끊김이면 본문을 흐린다. 당겨서 새로고침 = 즉시 재시도(P5ⓑ).
import { useRouter } from 'expo-router'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { statusLine } from '../src/core/band'
import { connection, useConnection } from '../src/runtime/connection'
import { ConnectionBand } from '../src/ui/ConnectionBand'
import { Screen } from '../src/ui/Screen'
import { color, mono } from '../src/ui/tokens'

export default function Home() {
  const router = useRouter()
  const { conn, info, appVersion } = useConnection()
  const macName = info?.macName ?? '맥'
  const status = statusLine(conn, macName)
  const offline = conn.kind === 'reconnecting' && conn.offline
  return (
    <Screen>
      <View className="h-16 flex-row items-center justify-between px-padx">
        <View className="flex-1 gap-0.5">
          <Text className="text-[20px] font-semibold text-fg">corral</Text>
          <View className="flex-row items-center gap-1.5">
            {status.tone === 'ok' ? <View className="h-[7px] w-[7px] rounded-full bg-accent" /> : null}
            <Text className={`text-preview ${status.tone === 'error' ? 'text-error' : status.tone === 'ok' ? 'text-fg-muted' : 'text-fg-dim'}`} numberOfLines={1}>
              {status.text}
            </Text>
          </View>
        </View>
        <Pressable accessibilityRole="button" onPress={() => router.push('/settings')} className="h-11 justify-center px-2 active:opacity-60">
          <Text className="text-body text-fg-muted">설정</Text>
        </Pressable>
      </View>
      <ConnectionBand conn={conn} onReconnect={() => connection.reconnectNow()} />
      {conn.kind === 'mismatch' ? (
        <View className="flex-1 gap-4 px-padx pt-10">
          <View className="h-2.5 w-2.5 rounded-full bg-error" />
          <Text className="text-screen font-semibold text-fg">버전이 맞지 않습니다</Text>
          <Text className="text-[14px] leading-[22px] text-fg-muted">맥의 corral 과 이 앱의 연결 방식(프로토콜)이 다릅니다. 오래된 쪽을 업데이트한 뒤 「다시 연결」 을 눌러 주세요.</Text>
          <View className="rounded-card border border-line bg-window p-4">
            <Text className="text-[13px] leading-[20px] text-fg" style={{ fontFamily: mono }}>
              {`이 앱 ${appVersion} · 프로토콜 1\n맥 corral ${info?.serverVersion ?? ''} · 프로토콜 ${conn.supported.length > 0 ? conn.supported.join(', ') : '알 수 없음'}`}
            </Text>
          </View>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => connection.reconnectNow()} tintColor={color.fgMuted} colors={[color.fg]} progressBackgroundColor={color.window} />}
        >
          <View className="flex-1 items-center justify-center gap-2 px-padx" style={{ opacity: offline ? 0.5 : 1 }}>
            <Text className="text-body text-fg-muted">대화방 목록은 다음 작업에서 들어옵니다</Text>
            <Text className="text-small text-fg-dim">아래로 당기면 연결을 바로 다시 확인합니다</Text>
          </View>
        </ScrollView>
      )}
    </Screen>
  )
}
