// 상태 글리프 (design-handoff §2 StatusGlyph) — 데스크톱 상태 점과 같은 모양. 색은 design-tokens-mobile.css(L5ⓕ).
import { useEffect, useRef } from 'react'
import { Animated, Easing, Image, Text, View } from 'react-native'
import type { ImageSourcePropType } from 'react-native'
import claudeLogo from '../../assets/agents/claude.png'
import codexLogo from '../../assets/agents/codex.png'
import grokLogo from '../../assets/agents/grok.png'
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

/**
 * 에이전트 로고 (LIFE-594 핸드오프 §B) — 데스크톱 `AgentIcon.tsx` 와 같은 마크를 PNG 로 그린다.
 * 파일은 Claude Design 이 준 자산(`specs/LIFE-594-design-apply/design-assets/png/`)을 바이트 그대로 두고 이름만 RN 밀도 규칙
 * (`<n>.png`·`@2x`·`@3x`)으로 바꿨다 — 출처·라이선스는 `assets/agents/README.md`(로고 모양 = Orca MIT 이식 경로).
 * 고정 PNG 라 색이 박혀 있다: claude `#d97757` · codex `#a1a1a1` · grok 원색. 데스크톱 codex 는 활성 때 `--fg` 로 밝아지지만
 * 모바일 아바타에는 그 변화가 없다(의도 — 모바일 아바타에 활성 표현이 없다). 벡터(`react-native-svg`)는 네이티브 모듈이라 쓰지 않는다.
 */
const AGENT_LOGO: Record<AgentKind, { source: ImageSourcePropType; radius: number }> = {
  claude: { source: claudeLogo, radius: 0 },
  codex: { source: codexLogo, radius: 0 },
  grok: { source: grokLogo, radius: 3 },
}

/** 아바타 칸 → 로고 크기(핸드오프 §B): 목록 38→20 · 대화 머리 34→18 · 워커 행 32→16 · 답 머리 22→13. 표 밖 칸은 비율(≈0.53)로. */
function logoSize(size: number): number {
  switch (size) {
    case 38:
      return 20
    case 34:
      return 18
    case 32:
      return 16
    case 22:
      return 13
    default:
      return Math.round(size * 0.53)
  }
}

/**
 * 아바타 — 에이전트 로고 + 우하단 상태 배지(디자인 §2 ChannelRow). 종류 모름(`null`)은 글리프 `·` 그대로.
 * `dot` 을 넘기지 않으면 배지를 그리지 않는다 — 에이전트 답 머리(칸 22)는 고정 21px 배지가 로고를 덮고 늘 `idle` 이라 뺐다(LIFE-594 K3ⓐ 정정).
 */
export function Avatar({ kind, dot, closed = false, size }: { kind: AgentKind | null; dot?: Dot; closed?: boolean; size: number }) {
  const logo = logoSize(size)
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{ width: size, height: size, borderRadius: 10, backgroundColor: color.window, borderWidth: 1, borderColor: color.line, alignItems: 'center', justifyContent: 'center' }}
      >
        {kind === null ? (
          <Text style={{ color: color.fgMuted, fontSize: size >= 38 ? 17 : 14 }}>·</Text>
        ) : (
          <Image source={AGENT_LOGO[kind].source} style={{ width: logo, height: logo, borderRadius: AGENT_LOGO[kind].radius }} />
        )}
      </View>
      {dot === undefined ? null : (
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
      )}
    </View>
  )
}
