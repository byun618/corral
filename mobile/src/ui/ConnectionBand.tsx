// 연결 띠 E (design-handoff §2 ConnectionBand) — 연결됨: 없음 · 재연결 중: 3초 넘을 때만 · 끊김: 빨간 띠 + 기준 시각 + 「다시 연결」 · 버전 불일치: 같은 띠.
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { bandFor } from '../core/band'
import type { ConnState } from '../core/connection'
import { color, hhmm } from './tokens'

/** 재연결 중·확인 중일 때만 0.5초마다 다시 그린다(3초 유예를 넘는 순간을 보려고). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function ConnectionBand({ conn, onReconnect }: { conn: ConnState; onReconnect: () => void }) {
  const now = useNow(conn.kind === 'reconnecting' || conn.kind === 'checking')
  const band = bandFor(conn, now)
  switch (band.kind) {
    case 'none':
      return null
    case 'reconnecting':
      return (
        <View className="h-band flex-row items-center gap-2 bg-window px-padx" accessibilityLiveRegion="polite">
          <ActivityIndicator size={12} color={color.fgMuted} />
          <Text className="text-[13px] text-fg-muted">{band.since === null ? '연결 중…' : `재연결 중 · ${hhmm(band.since)} 기준`}</Text>
        </View>
      )
    case 'offline':
    case 'mismatch':
      return (
        <View className="h-band flex-row items-center gap-2 px-padx" style={{ backgroundColor: color.errorTint12 }} accessibilityLiveRegion="polite">
          <View className="h-3 w-3 rounded-full bg-error" />
          <Text className="flex-1 text-[13px] text-fg" numberOfLines={1}>
            {band.kind === 'mismatch' ? '버전이 맞지 않아 연결을 멈췄습니다' : band.since === null ? '끊김 · 맥에 닿지 않음' : `끊김 · ${hhmm(band.since)} 기준`}
          </Text>
          <Pressable accessibilityRole="button" onPress={onReconnect} className="h-8 justify-center rounded-pill border border-line-strong px-3 active:opacity-70">
            <Text className="text-[13px] font-semibold text-fg">다시 연결</Text>
          </Pressable>
        </View>
      )
  }
}

