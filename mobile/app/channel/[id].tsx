// 대화 자리 화면 (LIFE-580 J3) — 머리(`ConversationHeader`)만 그린다. 대화 본문은 M4(LIFE-581)가 채운다.
// 열면 읽음(J1). Android 뒤로 = 목록(스택 기본 동작). 목록이 바뀌면 머리도 따라 바뀐다(상태·제목).
// 버전 불일치(B8 · 579 Q10)면 목록 화면과 같이 채널 정보(제목·소속·모델·출신)를 숨기고 버전 안내만 — 읽음 장부도 바꾸지 않는다(R1-A6).
// 셋째 줄 「띄운 세션」 은 부모가 있으면 항상(579 Q3, R1 C2 — 목록 행 규칙과 다르다).
// 목록 실패(R2-A2 — 읽지 못함·구독 거부·응답 없음)면 Home 과 같은 정책: 「오래된 값」 띠(기준 시각 · 호환 불가면 업데이트 안내),
// 상태는 「확인 불가」, 실패 중에는 읽음 장부를 바꾸지 않는다(최신이 아닌 것을 봤다고 치지 않는다).
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect } from 'react'
import { Pressable, Text, View } from 'react-native'
import { locateChannel } from '../../src/core/list'
import { failureText, headerMeta, statusLabel, statusTone } from '../../src/core/list-view'
import { listOf } from '../../src/core/list-store'
import { connection, useConnection } from '../../src/runtime/connection'
import { listStore, useList } from '../../src/runtime/list'
import { toneColor } from '../../src/ui/ChannelList'
import { ConnectionBand } from '../../src/ui/ConnectionBand'
import { Screen } from '../../src/ui/Screen'
import { Avatar, StatusGlyph } from '../../src/ui/StatusGlyph'
import { color, font } from '../../src/ui/tokens'
import { StaleBand } from '../../src/ui/StaleBand'
import { VersionMismatch } from '../../src/ui/VersionMismatch'

export default function ChannelPlaceholder() {
  const router = useRouter()
  const params = useLocalSearchParams<{ id?: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  const snapshot = useList()
  const { conn, info, appVersion } = useConnection()
  const mismatch = conn.kind === 'mismatch'
  // 버전이 다르면 캐시된 목록을 읽지 않는다 — 채널을 찾지도, 읽음으로 치지도 않는다.
  const list = mismatch ? null : listOf(snapshot)
  const found = list === null ? null : locateChannel(list, id)
  const channel = found?.channel ?? null
  // 목록 실패 중이면 이 채널 값은 최신이 아니다 — 기준 시각은 그 목록을 받은 시각.
  const failure = mismatch ? null : snapshot.failure
  const staleAt = failure !== null && snapshot.phase.kind === 'ready' ? snapshot.phase.receivedAt : null
  // 열면 읽음 — 열어 둔 동안 새 활동이 와도 본 것으로 친다(보고 있으니까). 목록 실패 중에는 읽음으로 치지 않는다.
  const unread = channel === null ? false : listStore.isUnread(channel)
  const stale = failure !== null
  useEffect(() => {
    if (channel !== null && unread && !stale) listStore.markRead(channel)
  }, [channel, unread, stale])
  const offline = conn.kind !== 'connected' && conn.kind !== 'checking'
  const unknown = offline || stale
  const closed = channel?.status === 'closed'
  const dot = channel === null ? 'unverifiable' : channel.dot
  const label = channel === null ? '' : unknown ? '확인 불가' : statusLabel({ dot, waiting: channel.waiting, closed })
  const tone = unknown ? color.fgMuted : toneColor(statusTone({ dot, closed }))
  const third = channel === null ? null : headerMeta(channel)
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
            {mismatch ? '대화' : (channel?.title ?? '세션')}
          </Text>
          {found !== null ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <StatusGlyph dot={unknown ? 'unverifiable' : dot} closed={closed} />
              <Text style={{ fontSize: 13, fontFamily: font.medium, color: tone }}>{label}</Text>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 11.5, fontFamily: font.mono, color: color.fgDim }}>{`${found.repo.name} › ${found.task.name}`}</Text>
            </View>
          ) : null}
          {third !== null ? (
            <Text numberOfLines={1} style={{ fontSize: 11.5, fontFamily: font.mono, color: color.fgDim }}>
              {third}
            </Text>
          ) : null}
        </View>
      </View>
      <ConnectionBand conn={conn} onReconnect={() => connection.reconnectNow()} />
      {failure !== null && staleAt !== null ? <StaleBand failure={failure} receivedAt={staleAt} /> : null}
      {conn.kind === 'mismatch' ? (
        <VersionMismatch appVersion={appVersion} serverVersion={info?.serverVersion ?? null} supported={conn.supported} />
      ) : (
        <View className="flex-1 items-center justify-center gap-2 px-padx">
          {channel === null ? (
            <Text style={{ fontSize: 15, color: color.fgMuted, fontFamily: font.regular }}>{failure !== null && staleAt === null ? failureText(failure).title : '이 세션은 지금 목록에 없습니다'}</Text>
          ) : (
            <>
              <Text style={{ fontSize: 15, color: color.fgMuted, fontFamily: font.regular }}>대화는 다음 작업에서 들어옵니다</Text>
              <Text style={{ fontSize: 12.5, color: color.fgDim, fontFamily: font.regular }}>지금은 상태와 소속만 보입니다</Text>
            </>
          )}
        </View>
      )}
    </Screen>
  )
}
