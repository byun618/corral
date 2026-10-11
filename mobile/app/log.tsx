// 연결 기록(P8) — 시도·인증·프로브·끊김 사유·재연결을 시각과 함께. 「복사」 로 사후 회수(토큰·코드 없음).
import * as Clipboard from 'expo-clipboard'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { FlatList, Pressable, Text, View } from 'react-native'
import { connectionLog, useConnectionLog } from '../src/runtime/connection'
import { Header } from '../src/ui/Header'
import { Screen } from '../src/ui/Screen'
import { mono } from '../src/ui/tokens'

function time(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export default function Log() {
  const router = useRouter()
  const entries = useConnectionLog()
  const [copied, setCopied] = useState(false)
  const newestFirst = [...entries].reverse()
  return (
    <Screen>
      <View className="flex-row items-center justify-between pr-padx">
        <Header title="연결 기록" onBack={() => router.back()} />
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void Clipboard.setStringAsync(connectionLog.text()).then(() => setCopied(true))
          }}
          className="h-11 justify-center active:opacity-60"
        >
          <Text className="text-body text-fg-muted">{copied ? '복사함' : '복사'}</Text>
        </Pressable>
      </View>
      <FlatList
        data={newestFirst}
        keyExtractor={(entry, index) => `${entry.at}-${index}`}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        ListEmptyComponent={<Text className="pt-10 text-center text-preview text-fg-dim">기록이 없습니다</Text>}
        renderItem={({ item }) => (
          <View className="border-b border-line py-2">
            <Text className="text-meta text-fg-dim" style={{ fontFamily: mono }}>
              {time(item.at)} <Text className="text-fg">{item.event}</Text>
            </Text>
            {Object.keys(item.detail).length > 0 ? (
              <Text className="text-meta text-fg-muted" style={{ fontFamily: mono }}>
                {Object.entries(item.detail)
                  .map(([key, value]) => `${key}=${String(value)}`)
                  .join(' ')}
              </Text>
            ) : null}
          </View>
        )}
      />
    </Screen>
  )
}
