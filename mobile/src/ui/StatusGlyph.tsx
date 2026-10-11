// 상태 글리프 (design-handoff §2 StatusGlyph) — 데스크톱 상태 점과 같은 모양. 색은 design-tokens-mobile.css(L5ⓕ).
import { useEffect, useRef } from 'react'
import { Animated, Easing, Text, View } from 'react-native'
import type { AgentKind, Dot } from '../core/list'
import { color, font } from './tokens'

export function dotColor(dot: Dot, closed = false): string {
  if (closed) return color.dotUnverifiable
  switch (dot) {
    case 'working':
    case 'monitoring':
      return color.dotWorking
    case 'done':
      return color.dotDone
    case 'unverifiable':
      return color.dotUnverifiable
    case 'waiting':
      return color.dotQuestion
    case 'blocked':
    case 'interrupted':
    case 'failed':
      return color.dotAlert
    case 'idle':
      return color.dotIdle
  }
}

function Spinner({ tint }: { tint: string }) {
  const spin = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }))
    loop.start()
    return () => loop.stop()
  }, [spin])
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return (
    <Animated.View
      style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: tint, borderRightColor: 'transparent', transform: [{ rotate }] }}
    />
  )
}

/** 상태 글리프 하나 — 닫힌 세션은 확인 불가와 같은 점선 원(디자인 §2). */
export function StatusGlyph({ dot, closed = false }: { dot: Dot; closed?: boolean }) {
  const tint = dotColor(dot, closed)
  if (closed || dot === 'unverifiable') return <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 1.5, borderStyle: 'dashed', borderColor: tint }} />
  switch (dot) {
    case 'working':
      return <Spinner tint={tint} />
    case 'monitoring':
      return <Text style={{ color: tint, fontSize: 15, lineHeight: 16 }}>∿</Text>
    case 'done':
      return (
        <View style={{ width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: tint, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: tint, fontSize: 8, lineHeight: 10 }}>✓</Text>
        </View>
      )
    case 'waiting':
      return (
        <View style={{ width: 15, height: 13, borderRadius: 4, borderBottomLeftRadius: 1, backgroundColor: tint, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: color.surface, fontSize: 9.5, lineHeight: 12, fontFamily: font.semibold }}>?</Text>
        </View>
      )
    case 'blocked':
    case 'interrupted':
    case 'failed':
      return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tint }} />
    case 'idle':
      return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tint }} />
  }
}

const AGENT_GLYPH: Record<AgentKind, { glyph: string; tint: string }> = {
  claude: { glyph: '✳', tint: color.agentClaude },
  codex: { glyph: '◆', tint: color.fgMuted },
  grok: { glyph: '✦', tint: color.agentGrok },
}

/** 아바타 — 에이전트 글리프 + 우하단 상태 배지(디자인 §2 ChannelRow). */
export function Avatar({ kind, dot, closed = false, size }: { kind: AgentKind | null; dot: Dot; closed?: boolean; size: number }) {
  const agent = kind === null ? { glyph: '·', tint: color.fgMuted } : AGENT_GLYPH[kind]
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{ width: size, height: size, borderRadius: 10, backgroundColor: color.window, borderWidth: 1, borderColor: color.line, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text style={{ color: agent.tint, fontSize: size >= 38 ? 17 : 14 }}>{agent.glyph}</Text>
      </View>
      <View
        style={{
          position: 'absolute',
          right: -6,
          bottom: -6,
          width: 21,
          height: 21,
          borderRadius: 11,
          backgroundColor: color.surface,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <StatusGlyph dot={dot} closed={closed} />
      </View>
    </View>
  )
}
