// 대화방 목록 행들 (design-handoff §2 ChannelRow · WaitingSection · RepoDivider · TaskHeader) — 그리기만 한다. 값은 `core/list-view.ts`.
import { Pressable, Text, View } from 'react-native'
import type { ChannelRowView, GhostRowView, TaskView, Tone } from '../core/list-view'
import { Avatar, StatusGlyph } from './StatusGlyph'
import { color, font } from './tokens'

export function toneColor(tone: Tone): string {
  switch (tone) {
    case 'question':
      return color.dotQuestion
    case 'alert':
      return color.dotAlert
    case 'done':
      return color.dotDone
    case 'working':
      return color.dotWorking
    case 'muted':
      return color.fgMuted
    case 'dim':
      return color.fgDim
  }
}

export function ChannelRow({ row, onPress }: { row: ChannelRowView; onPress: () => void }) {
  const { channel } = row
  const avatar = row.worker ? 32 : 38
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${channel.title}${row.unread ? ' · 안 읽음' : ''}`}
      onPress={onPress}
      className="active:opacity-70"
      style={{ minHeight: 62, flexDirection: 'row', gap: 12, paddingTop: 9, paddingBottom: 9, paddingRight: 16, paddingLeft: row.worker ? 30 : 18, backgroundColor: row.flash ? color.questionTint8 : 'transparent' }}
    >
      {row.worker ? <Text style={{ color: color.fgFaint, fontFamily: font.mono, fontSize: 12, marginTop: 8, marginLeft: -14 }}>└</Text> : null}
      <View style={{ paddingTop: 3 }}>
        <Avatar kind={channel.kind} dot={row.dot} closed={row.closed} size={avatar} />
      </View>
      <View style={{ flex: 1, gap: 2, opacity: row.closed ? 0.6 : 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, lineHeight: 21, color: color.fg, fontFamily: row.unread ? font.semibold : font.medium }}>
            {channel.title}
          </Text>
          <Text style={{ fontSize: 11.5, fontFamily: font.mono, color: row.flash ? toneColor('question') : color.fgDim }}>{row.time}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {row.prefix !== null ? <Text style={{ fontSize: 13, fontFamily: font.medium, color: toneColor(row.prefix.tone) }}>{row.prefix.text}</Text> : null}
          {row.text !== '' ? (
            <Text numberOfLines={1} style={{ flex: 1, fontSize: row.mono ? 12.5 : 13.5, lineHeight: 19, color: color.fgMuted, fontFamily: row.mono ? font.mono : font.regular }}>
              {row.text}
            </Text>
          ) : (
            // 글 없는 행 — 같은 줄 높이(19)를 지키고 안 읽음 점을 오른쪽 끝에 둔다.
            <View style={{ flex: 1, height: 19 }} />
          )}
          {row.unread ? <View accessibilityLabel="안 읽음" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color.fg }} /> : null}
        </View>
        {row.meta !== null ? (
          <Text numberOfLines={1} style={{ fontSize: 11.5, fontFamily: font.mono, color: color.fgDim }}>
            {row.meta}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

/** 자국 행 — 기다리는 채널이 위로 올라간 자리(디자인 Q1). 누르면 대화. */
export function GhostRow({ row, onPress }: { row: GhostRowView; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className="active:opacity-70"
      style={{ height: 40, flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 16, paddingLeft: row.worker ? 30 : 18 }}
    >
      <Text style={{ color: color.fgDim, fontSize: 13 }}>↑</Text>
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13.5, color: color.fgDim, fontFamily: font.regular }}>
        {row.channel.title}
      </Text>
      <Text style={{ fontSize: 12, color: color.dotQuestion, fontFamily: font.regular }}>위에서 기다리는 중</Text>
    </Pressable>
  )
}

export function RepoDivider({ name }: { name: string }) {
  return (
    <View style={{ height: 38, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18 }}>
      <Text style={{ fontSize: 12, fontFamily: font.monoMedium, letterSpacing: 0.72, color: color.fgDim }}>{name.toUpperCase()}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: color.line }} />
    </View>
  )
}

export function TaskHeader({ task, onToggle }: { task: TaskView; onToggle: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: !task.collapsed }}
      onPress={onToggle}
      className="active:opacity-70"
      style={{ height: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18 }}
    >
      <Text style={{ width: 12, fontSize: 11, fontFamily: font.mono, color: color.fgDim }}>{task.collapsed ? '▸' : '▾'}</Text>
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 15, fontFamily: font.semibold, color: task.collapsed ? color.fgMuted : color.fg }}>
        {task.name}
      </Text>
      {task.isDefault ? (
        <View style={{ borderRadius: 6, backgroundColor: color.chip, paddingHorizontal: 6, paddingVertical: 1 }}>
          <Text style={{ fontSize: 11, color: color.fgMuted, fontFamily: font.regular }}>기본</Text>
        </View>
      ) : null}
      <View style={{ flex: 1 }} />
      {task.collapsed ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {task.dots.map((dot, index) => (
            <StatusGlyph key={index} dot={dot} />
          ))}
          {task.extraDots > 0 ? <Text style={{ fontSize: 11.5, fontFamily: font.mono, color: color.fgDim }}>{`+${task.extraDots}`}</Text> : null}
          <Text style={{ fontSize: 11.5, fontFamily: font.mono, color: color.fgDim }}>{task.count}</Text>
        </View>
      ) : null}
      {task.unread ? <View accessibilityLabel="안 읽음" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color.fg }} /> : null}
    </Pressable>
  )
}

export function WaitingHeader({ count }: { count: number }) {
  return (
    <View style={{ height: 36, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: color.line }}>
      <Text style={{ fontSize: 13, fontFamily: font.semibold, color: color.dotQuestion }}>나를 기다리는 것</Text>
      <Text style={{ fontSize: 12, fontFamily: font.mono, color: color.dotQuestion }}>{count}</Text>
    </View>
  )
}
