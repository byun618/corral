// 대화방 목록 B1–B9 (LIFE-580) — 앱 바(`맥 이름 · 연결됨`) + 연결 띠(578 재사용, B6–B8) + 「비서」 자리 + 「나를 기다리는 것」 + 레포 › 작업 › 채널.
// 값·순서는 서버(데스크톱 파생 함수)가 정한다 — 이 화면은 `core/list-view.ts` 가 만든 줄을 그리기만 한다.
// 버전 불일치면 목록을 숨긴다(B8). 끊김이면 마지막 목록을 흐리게(B7, 띠에 기준 시각). 목록을 아직 못 받았으면 「세션 0」(B9)이 아니라 받는 중으로 그린다(L5ⓗ).
// 당겨서 새로고침 = 즉시 재확인(578 P5ⓑ) + 목록 구독을 다시 보내 전체를 새로 받는다.
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { statusLine } from '../src/core/band'
import { buildListView } from '../src/core/list-view'
import { connection, useConnection } from '../src/runtime/connection'
import { collapse, listStore, useCollapseVersion, useList } from '../src/runtime/list'
import { ChannelRow, GhostRow, RepoDivider, TaskHeader, WaitingHeader } from '../src/ui/ChannelList'
import { ConnectionBand, useNow } from '../src/ui/ConnectionBand'
import { Screen } from '../src/ui/Screen'
import { color, font, mono } from '../src/ui/tokens'

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <View className="flex-1 justify-center gap-2 px-padx" style={{ paddingBottom: 80 }}>
      <Text style={{ fontSize: 17, fontFamily: font.semibold, color: color.fg }}>{title}</Text>
      <Text style={{ fontSize: 14, lineHeight: 22, color: color.fgMuted, fontFamily: font.regular }}>{body}</Text>
    </View>
  )
}

function ChannelListBody() {
  const router = useRouter()
  const list = useList()
  useCollapseVersion()
  const [waitingExpanded, setWaitingExpanded] = useState(false)
  const flashing = Object.values(list.flashUntil).some((until) => until > Date.now())
  const now = useNow(flashing)
  const { conn } = useConnection()
  const phase = list.phase
  if (phase.kind === 'waiting') {
    return conn.kind === 'connected' || conn.kind === 'checking' ? (
      <Notice title="목록을 받는 중" body="맥에서 대화방 목록을 받고 있습니다." />
    ) : (
      <Notice title="아직 목록이 없습니다" body="맥에 연결되면 대화방 목록을 받습니다." />
    )
  }
  const message = phase.message
  if (!message.list.available) {
    return <Notice title="맥이 세션 상태를 읽는 중입니다" body="맥의 corral 이 세션 상태를 아직 읽지 못했습니다. 잠시 뒤 저절로 채워집니다." />
  }
  const view = buildListView({
    list: message.list,
    isUnread: (channel) => listStore.isUnread(channel),
    isCollapsed: (taskId, dots) => collapse.isCollapsed(taskId, dots),
    flashUntil: list.flashUntil,
    now,
    waitingExpanded,
  })
  if (view.empty) {
    return <Notice title="열린 AI 세션이 없습니다" body="맥에서 Claude Code · Codex · Grok 세션을 열면 여기에 대화방으로 나타납니다. 폰에서는 새 세션을 시작할 수 없습니다." />
  }
  const open = (id: string) => router.push({ pathname: '/channel/[id]', params: { id } })
  return (
    <View>
      {/* 「비서」 고정 행 자리(디자인 §1) — 지금은 비어 있다. */}
      <View />
      {view.waitingTotal > 0 ? (
        <View>
          <WaitingHeader count={view.waitingTotal} />
          {view.waiting.map((row) => (
            <ChannelRow key={`w:${row.channel.id}`} row={row} onPress={() => open(row.channel.id)} />
          ))}
          {view.waitingMore > 0 ? (
            <Pressable accessibilityRole="button" onPress={() => setWaitingExpanded(true)} className="active:opacity-70" style={{ height: 44, justifyContent: 'center', paddingHorizontal: 18 }}>
              <Text style={{ fontSize: 13, color: color.fgMuted, fontFamily: font.medium }}>{`${view.waitingMore}개 더 보기 ▾`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : view.noWaitingSummary !== null ? (
        <View style={{ height: 40, justifyContent: 'center', paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: color.line }}>
          <Text style={{ fontSize: 13, color: color.fgDim, fontFamily: font.regular }}>{view.noWaitingSummary}</Text>
        </View>
      ) : null}
      {view.repos.map((repo) => (
        <View key={repo.id}>
          <RepoDivider name={repo.name} />
          {repo.tasks.map((task) => (
            <View key={task.id}>
              <TaskHeader task={task} onToggle={() => collapse.toggle(task.id, task.liveDots)} />
              {task.collapsed
                ? null
                : task.rows.map((row) =>
                    row.kind === 'ghost' ? (
                      <GhostRow key={`g:${row.channel.id}`} row={row} onPress={() => open(row.channel.id)} />
                    ) : (
                      <ChannelRow key={row.channel.id} row={row} onPress={() => open(row.channel.id)} />
                    ),
                  )}
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}

/** 당겨서 새로고침 — 연결 재확인(578) + 목록 전체 다시 받기. */
function refresh(): void {
  listStore.refresh()
  connection.reconnectNow()
}

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
          <Text className="text-[20px] font-semibold text-fg">대화방</Text>
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
          <Text className="text-[14px] leading-[22px] text-fg-muted">맥의 corral 과 이 앱의 연결 방식(프로토콜)이 다릅니다. 오래된 쪽을 업데이트한 뒤 「다시 연결」 을 눌러 주세요. 마지막 목록은 버전이 다르면 잘못 읽힐 수 있어 보여 주지 않습니다.</Text>
          <View className="rounded-card border border-line bg-window p-4">
            <Text className="text-[13px] leading-[20px] text-fg" style={{ fontFamily: mono }}>
              {`이 앱 ${appVersion} · 프로토콜 1\n맥 corral ${info?.serverVersion ?? ''} · 프로토콜 ${conn.supported.length > 0 ? conn.supported.join(', ') : '알 수 없음'}`}
            </Text>
          </View>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 24 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={color.fgMuted} colors={[color.fg]} progressBackgroundColor={color.window} />}
        >
          <View className="flex-1" style={{ opacity: offline ? 0.45 : 1 }}>
            <ChannelListBody />
          </View>
        </ScrollView>
      )}
    </Screen>
  )
}
