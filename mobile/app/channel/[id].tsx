// 대화 자리 화면 (LIFE-580 J3) — 머리(`ConversationHeader`)만 그린다. 대화 본문은 M4(LIFE-581)가 채운다.
// 열면 읽음(J1). Android 뒤로 = 목록(스택 기본 동작). 목록이 바뀌면 머리도 따라 바뀐다(상태·제목).
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect } from 'react'
import { Pressable, Text, View } from 'react-native'
import { locateChannel } from '../../src/core/list'
import { statusLabel, statusTone } from '../../src/core/list-view'
import { listOf } from '../../src/core/list-store'
import { connection, useConnection } from '../../src/runtime/connection'
import { listStore, useList } from '../../src/runtime/list'
import { toneColor } from '../../src/ui/ChannelList'
import { ConnectionBand } from '../../src/ui/ConnectionBand'
import { Screen } from '../../src/ui/Screen'
import { Avatar, StatusGlyph } from '../../src/ui/StatusGlyph'
import { color, font } from '../../src/ui/tokens'

export default function ChannelPlaceholder() {
  const router = useRouter()
  const params = useLocalSearchParams<{ id?: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  const snapshot = useList()
  const { conn } = useConnection()
  const list = listOf(snapshot)
  const found = list === null ? null : locateChannel(list, id)
  const channel = found?.channel ?? null
  // 열면 읽음 — 열어 둔 동안 새 활동이 와도 본 것으로 친다(보고 있으니까).
  const unread = channel === null ? false : listStore.isUnread(channel)
  useEffect(() => {
    if (channel !== null && unread) listStore.markRead(channel)
  }, [channel, unread])
  const offline = conn.kind !== 'connected' && conn.kind !== 'checking'
  const closed = channel?.status === 'closed'
  const dot = channel === null ? 'unverifiable' : channel.dot
  const label = channel === null ? '' : offline ? '확인 불가' : statusLabel({ dot, waiting: channel.waiting, closed })
  const tone = offline ? color.fgMuted : toneColor(statusTone({ dot, closed }))
  const third = channel === null ? [] : [channel.model, channel.origin === null ? null : `↳ ${channel.origin}`, channel.spawnedBy === null ? null : `띄운 세션: ${channel.spawnedBy.title ?? '알 수 없음'}`].filter((part): part is string => part !== null)
  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingRight: 16, paddingVertical: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="뒤로" onPress={() => router.back()} className="active:opacity-60" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 22, color: color.fg }}>←</Text>
        </Pressable>
        {channel !== null ? (
          <View style={{ paddingTop: 5 }}>
            <Avatar kind={channel.kind} dot={dot} closed={closed} size={34} />
          </View>
        ) : null}
        <View style={{ flex: 1, gap: 2, paddingTop: 4, paddingLeft: 4 }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontFamily: font.semibold, color: color.fg }}>
            {channel?.title ?? '세션'}
          </Text>
          {found !== null ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <StatusGlyph dot={offline ? 'unverifiable' : dot} closed={closed} />
              <Text style={{ fontSize: 13, fontFamily: font.medium, color: tone }}>{label}</Text>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 11.5, fontFamily: font.mono, color: color.fgDim }}>{`${found.repo.name} › ${found.task.name}`}</Text>
            </View>
          ) : null}
          {third.length > 0 ? (
            <Text numberOfLines={1} style={{ fontSize: 11.5, fontFamily: font.mono, color: color.fgDim }}>
              {third.join(' · ')}
            </Text>
          ) : null}
        </View>
      </View>
      <ConnectionBand conn={conn} onReconnect={() => connection.reconnectNow()} />
      <View className="flex-1 items-center justify-center gap-2 px-padx">
        {channel === null ? (
          <Text style={{ fontSize: 15, color: color.fgMuted, fontFamily: font.regular }}>이 세션은 지금 목록에 없습니다</Text>
        ) : (
          <>
            <Text style={{ fontSize: 15, color: color.fgMuted, fontFamily: font.regular }}>대화는 다음 작업에서 들어옵니다</Text>
            <Text style={{ fontSize: 12.5, color: color.fgDim, fontFamily: font.regular }}>지금은 상태와 소속만 보입니다</Text>
          </>
        )}
      </View>
    </Screen>
  )
}
