// 설정 D1 기본 · D2 해제 확인 시트 · D3 끊긴 동안. 맥 정보는 마지막으로 받은 값(hello). 해제는 끊긴 동안에도 된다 — 폰 토큰만 지운다.
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import type { ConnState } from '../src/core/connection'
import { connection, useConnection } from '../src/runtime/connection'
import { Button } from '../src/ui/Button'
import { ConnectionBand } from '../src/ui/ConnectionBand'
import { Header } from '../src/ui/Header'
import { Screen } from '../src/ui/Screen'
import { color, mono } from '../src/ui/tokens'

function stateLabel(conn: ConnState): { text: string; color: string } {
  switch (conn.kind) {
    case 'connected':
      return { text: '연결됨', color: color.accent }
    case 'checking':
      return { text: '연결 확인 중', color: color.fgMuted }
    case 'reconnecting':
      return conn.offline ? { text: '끊김', color: color.error } : { text: '재연결 중', color: color.fgMuted }
    case 'mismatch':
      return { text: '버전 불일치', color: color.error }
    case 'loading':
    case 'unpaired':
      return { text: '—', color: color.fgDim }
  }
}

function Row({ label, value, monoValue = false, valueColor = color.fg }: { label: string; value: string; monoValue?: boolean; valueColor?: string }) {
  return (
    <View className="min-h-[52px] flex-row items-center justify-between gap-4 border-b border-line px-4 py-3">
      <Text className="text-preview text-fg-muted">{label}</Text>
      <Text className="flex-1 text-right" style={{ color: valueColor, fontFamily: monoValue ? mono : undefined, fontSize: monoValue ? 13 : 14.5 }} numberOfLines={2}>
        {value}
      </Text>
    </View>
  )
}

export default function Settings() {
  const router = useRouter()
  const { conn, info, appVersion } = useConnection()
  const [sheet, setSheet] = useState(false)
  const state = stateLabel(conn)
  return (
    <Screen>
      <Header title="설정" onBack={() => router.back()} />
      <ConnectionBand conn={conn} onReconnect={() => connection.reconnectNow()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <Text className="px-padx pb-2 pt-5 text-small font-semibold text-fg-dim">연결된 맥</Text>
        <View className="mx-4 overflow-hidden rounded-card border border-line bg-window">
          <Row label="이름" value={info?.macName ?? '—'} />
          <Row label="주소" value={info?.host ?? '—'} monoValue />
          <Row label="corral" value={info?.serverVersion ?? '—'} monoValue />
          <Row label="상태" value={state.text} valueColor={state.color} />
        </View>
        <Text className="px-padx pb-2 pt-6 text-small font-semibold text-fg-dim">이 폰</Text>
        <View className="mx-4 overflow-hidden rounded-card border border-line bg-window">
          <Row label="앱 버전" value={appVersion} monoValue />
          <Row label="기기 이름" value={info?.deviceName ?? '—'} />
          <Pressable accessibilityRole="button" onPress={() => router.push('/log')} className="min-h-[52px] flex-row items-center justify-between px-4 active:opacity-60">
            <Text className="text-preview text-fg-muted">연결 기록</Text>
            <Text className="text-body text-fg-dim">›</Text>
          </Pressable>
        </View>
        <View className="gap-2 px-padx pt-10">
          <Button kind="dangerOutline" label="페어링 해제" onPress={() => setSheet(true)} />
          <Text className="text-center text-small text-fg-dim">해제하면 다시 QR 을 찍어야 연결됩니다</Text>
        </View>
      </ScrollView>
      <Modal visible={sheet} transparent animationType="slide" onRequestClose={() => setSheet(false)}>
        <Pressable className="flex-1 justify-end" style={{ backgroundColor: color.scrim }} onPress={() => setSheet(false)}>
          <Pressable className="gap-3 rounded-t-sheet border-t border-line-strong bg-window px-padx pb-8 pt-6" onPress={() => {}}>
            <Text className="text-[19px] font-semibold text-fg">페어링을 해제할까요?</Text>
            <Text className="text-[14px] leading-[22px] text-fg-muted">
              이 폰의 기기 토큰을 지웁니다. 맥의 세션은 그대로입니다. 맥의 기기 목록에는 이 폰이 남습니다 — 맥의 설정 › Mobile 에서 해지할 수 있습니다. 다시 쓰려면 맥에서 새 QR 을 만들어 찍어야 합니다.
            </Text>
            <View className="gap-1 pt-3">
              <Button
                kind="danger"
                label="해제"
                onPress={() => {
                  setSheet(false)
                  void connection.unpair()
                }}
              />
              <Button kind="secondary" label="취소" onPress={() => setSheet(false)} />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  )
}
