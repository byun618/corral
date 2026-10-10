// 대화 본문 (LIFE-581 X9 — 579 C1·C2·C6(표시)·C8·C9·C11·C13·C15·C16·C18·C19) — 말풍선 4종·SystemNote·도구 묶음·마크다운·과거 불러오기·`새 메시지 ↓`.
// 입력창·질문 답·중단은 M5(LIFE-582) — 이 화면은 그리지 않는다(입력 자리 없음). 색·크기는 design-handoff §2·§3 / tokens.ts.
//
// 목록은 뒤집힌 FlatList(가장 새 말풍선이 index 0 = 화면 아래). 과거 페이지는 배열 끝(화면 위)에 붙어 보던 자리가 움직이지 않는다(C16 위치 유지).
// 새 말풍선은 아래(index 0)에 붙고, 맨 아래에 있지 않으면 `maintainVisibleContentPosition` 이 보던 말풍선을 제자리에 두고 `새 메시지 ↓` 를 띄운다.
import * as Clipboard from 'expo-clipboard'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import type { ChatItem } from '../core/chat'
import type { ChatSnapshot } from '../core/chat-store'
import {
  TABLE_SCROLL_COLUMNS,
  bodyState,
  droppedText,
  foldText,
  inlineSpans,
  markdownBlocks,
  noteView,
  questionLine,
  replyHeads,
  runningTool,
  staleText,
  stateCard,
  toolLine,
  toolMark,
  toolSummary,
  type Block,
} from '../core/chat-view'
import type { AgentKind, Channel } from '../core/list'
import { Avatar } from './StatusGlyph'
import { color, font, hhmm, mono } from './tokens'

const TOOL_CARD_BG = '#121212'
const BODY_TEXT = '#e5e5e5'
const AGENT_NAME: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok' }

export type ConversationProps = {
  channel: Channel
  chat: ChatSnapshot
  /** 연결 끊김·목록 실패 — 흐리게(C18), 상태를 믿지 않는다. */
  unknown: boolean
  onOlder: () => void
  onRetry: () => void
}

export function Conversation({ channel, chat, unknown, onOlder, onRetry }: ConversationProps) {
  const state = bodyState({ phase: chat.phase, count: chat.items.length })
  const list = useRef<FlatList<ChatItem>>(null)
  // 맨 아래를 떠난 순간의 맨 아래 쪽 변경 횟수(`tailRev`) — 그 뒤 새 말풍선이 붙거나 마지막 답이 자라면 「새 메시지 ↓」(R1-A10). 맨 아래로 돌아오면 지운다.
  const [awayFrom, setAwayFrom] = useState<number | null>(null)
  const tailRev = chat.tailRev
  const data = useMemo(() => [...chat.items].reverse(), [chat.items])
  const heads = useMemo(() => replyHeads(chat.items), [chat.items])
  const live = channel.status === 'live' && !unknown
  const working = live && channel.dot === 'working'
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const isAway = event.nativeEvent.contentOffset.y > 120
      setAwayFrom((previous) => (isAway ? (previous ?? tailRev) : null))
    },
    [tailRev],
  )
  const showNew = awayFrom !== null && tailRev !== awayFrom

  if (state.kind === 'loading') {
    return (
      <View className="flex-1 items-center justify-center gap-3 px-padx">
        <ActivityIndicator color={color.fgMuted} />
        <Text style={{ fontSize: 14, color: color.fgMuted, fontFamily: font.regular }}>대화를 불러오는 중…</Text>
      </View>
    )
  }
  if (state.kind === 'failed') {
    return (
      <View className="flex-1 items-center justify-center gap-2 px-padx">
        <Text style={{ fontSize: 15, color: color.fg, fontFamily: font.medium, textAlign: 'center' }}>{state.title}</Text>
        <Text style={{ fontSize: 13.5, color: color.fgMuted, fontFamily: font.regular, textAlign: 'center' }}>{state.detail}</Text>
        {state.retry ? (
          <Pressable accessibilityRole="button" onPress={onRetry} className="mt-2 h-11 justify-center rounded-pill border border-line-strong px-5 active:opacity-70">
            <Text style={{ fontSize: 14, color: color.fg, fontFamily: font.semibold }}>다시 시도</Text>
          </Pressable>
        ) : null}
      </View>
    )
  }
  const stale = chat.stale === null ? null : staleText(chat.stale)
  return (
    <View style={{ flex: 1, opacity: unknown ? 0.5 : 1 }}>
      {stale !== null ? (
        // 다시 구독 실패(R1-A7) — 본문은 지난 내용으로 두고 그 사실을 띠로.
        <View style={{ minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, backgroundColor: color.errorTint12 }}>
          <Text style={{ flex: 1, fontSize: 12.5, color: color.error, fontFamily: font.medium }}>{stale.title}</Text>
          {stale.retry ? (
            <Pressable accessibilityRole="button" onPress={onRetry} className="active:opacity-70">
              <Text style={{ fontSize: 12.5, color: color.fg, fontFamily: font.semibold }}>다시 시도</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <FlatList
        ref={list}
        data={data}
        inverted
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item, index }) => (
          <Bubble item={item} head={heads.has(item.id)} kind={channel.kind} last={index === 0} working={working} />
        )}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
        onEndReached={() => onOlder()}
        onEndReachedThreshold={0.4}
        onScroll={onScroll}
        scrollEventThrottle={100}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12, gap: 14 }}
        ListHeaderComponent={<Trailer channel={channel} live={live} empty={state.kind === 'empty'} items={chat.items} dropped={chat.dropped} />}
        ListFooterComponent={<OlderMark loading={chat.loadingOlder} hasOlder={chat.hasOlder} />}
      />
      {showNew ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            list.current?.scrollToOffset({ offset: 0, animated: true })
            setAwayFrom(null)
          }}
          className="absolute bottom-3 self-center h-9 flex-row items-center rounded-pill bg-chip px-4 active:opacity-80"
        >
          <Text style={{ fontSize: 13, color: color.fg, fontFamily: font.semibold }}>새 메시지 ↓</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** 화면 위쪽 끝(뒤집힌 목록의 꼬리) — 이전 대화를 불러오는 중 · 대화의 처음. */
function OlderMark({ loading, hasOlder }: { loading: boolean; hasOlder: boolean }) {
  if (loading) {
    return (
      <View className="flex-row items-center justify-center gap-2 py-3">
        <ActivityIndicator size={12} color={color.fgMuted} />
        <Text style={{ fontSize: 12.5, color: color.fgDim, fontFamily: font.regular }}>이전 대화를 불러오는 중</Text>
      </View>
    )
  }
  if (hasOlder) return <View style={{ height: 24 }} />
  return <Text style={{ fontSize: 12.5, color: color.fgDim, fontFamily: font.regular, textAlign: 'center', paddingVertical: 12 }}>대화의 처음입니다</Text>
}

/** 화면 아래쪽 끝 — 지금 상태 카드(권한 대기 C6 · 중단 C8 · 실패 C9) · 못 읽은 말풍선 안내 · 닫힌 세션 안내(C19) · 빈 대화. */
function Trailer({ channel, live, empty, items, dropped }: { channel: Channel; live: boolean; empty: boolean; items: readonly ChatItem[]; dropped: number }) {
  // 지금 상태가 중단·실패인데 최신 턴의 기록에 그 카드가 없으면 상태에서 한 장(R1-A6, X2ⓔ).
  const card = stateCard({ dot: channel.dot, live, errorText: channel.preview.kind === 'error' ? channel.preview.text : null, items })
  const skipped = droppedText(dropped)
  return (
    <View style={{ gap: 12 }}>
      {empty ? <Text style={{ fontSize: 14, color: color.fgMuted, fontFamily: font.regular, textAlign: 'center', paddingVertical: 24 }}>아직 대화가 없습니다</Text> : null}
      {skipped !== null ? <Text style={{ fontSize: 12.5, color: color.fgDim, fontFamily: font.regular, textAlign: 'center' }}>{skipped}</Text> : null}
      {card !== null ? (
        <SystemNote tint={color.dotAlert} title={card.note === 'failed' ? '실패' : '중단됨'} chip={null} detail={card.note === 'failed' ? (card.text ?? '사유를 알 수 없습니다') : '맥에서 다시 지시하면 이어집니다'} />
      ) : null}
      {live && channel.waiting === 'approval' ? (
        <SystemNote
          tint={color.dotQuestion}
          title="맥에서 승인을 기다립니다"
          chip={channel.preview.kind === 'approval' ? channel.preview.text : null}
          detail="맥에서 승인하면 이어집니다"
        />
      ) : null}
      {channel.status === 'closed' ? (
        <View style={{ height: 56, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1, borderTopColor: color.line }}>
          <Text style={{ fontSize: 13, color: color.fgDim, fontFamily: font.regular }}>세션이 닫혔습니다 · 지난 기록만 볼 수 있습니다</Text>
        </View>
      ) : null}
    </View>
  )
}

const Bubble = memo(function Bubble({ item, head, kind, last, working }: { item: ChatItem; head: boolean; kind: AgentKind | null; last: boolean; working: boolean }) {
  switch (item.kind) {
    case 'prompt':
      return <PromptBubble text={item.body.text} clipped={item.body.clipped} />
    case 'reply':
      return <ReplyBlock item={item} head={head} kind={kind} cursor={last && working} />
    case 'tools':
      return <ToolGroup item={item} live={last && working} />
    case 'question':
      return <QuestionCard item={item} />
    case 'note': {
      const view = noteView(item)
      const detail = item.clipped && view.detail !== null ? `${view.detail} …(잘림)` : view.detail
      return <SystemNote tint={view.tone === 'alert' ? color.dotAlert : color.fgDim} title={view.title} chip={null} detail={detail} />
    }
  }
})

function Clipped({ clipped }: { clipped: number | null }) {
  if (clipped === null) return null
  return <Text style={{ fontSize: 12, color: color.fgDim, fontFamily: font.regular, marginTop: 4 }}>{`… 잘림 — 원문 ${clipped.toLocaleString()}자 중 일부`}</Text>
}

function PromptBubble({ text, clipped }: { text: string; clipped: number | null }) {
  const [expanded, setExpanded] = useState(false)
  const folded = foldText({ text, expanded })
  return (
    <View style={{ alignSelf: 'flex-end', marginLeft: 44, maxWidth: '100%', backgroundColor: color.chip, borderRadius: 18, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 10 }}>
      <Text selectable style={{ fontSize: 15, lineHeight: 22.5, color: color.fg, fontFamily: font.regular }}>{folded.text}</Text>
      {folded.hiddenLines > 0 ? <MoreLines hidden={folded.hiddenLines} onPress={() => setExpanded(true)} /> : null}
      <Clipped clipped={clipped} />
    </View>
  )
}

function MoreLines({ hidden, onPress }: { hidden: number; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} className="mt-1 active:opacity-60">
      <Text style={{ fontSize: 13, color: color.accent, fontFamily: font.medium }}>{`나머지 ${hidden}줄 더 보기`}</Text>
    </Pressable>
  )
}

function ReplyBlock({ item, head, kind, cursor }: { item: Extract<ChatItem, { kind: 'reply' }>; head: boolean; kind: AgentKind | null; cursor: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const folded = foldText({ text: item.body.text, expanded })
  const blocks = useMemo(() => markdownBlocks(folded.text), [folded.text])
  return (
    <View style={{ gap: 6 }}>
      {head ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Avatar kind={kind} dot="idle" size={22} />
          <Text style={{ fontSize: 13, color: color.fg, fontFamily: font.semibold }}>{kind === null ? '에이전트' : AGENT_NAME[kind]}</Text>
          {item.at !== null ? <Text style={{ fontSize: 11.5, color: color.fgDim, fontFamily: mono }}>{hhmm(item.at)}</Text> : null}
        </View>
      ) : null}
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} block={block} />
      ))}
      {cursor ? <View style={{ width: 8, height: 16, backgroundColor: color.accent }} /> : null}
      {folded.hiddenLines > 0 ? <MoreLines hidden={folded.hiddenLines} onPress={() => setExpanded(true)} /> : null}
      <Clipped clipped={item.body.clipped} />
    </View>
  )
}

function Inline({ text, style }: { text: string; style: { fontSize: number; lineHeight: number; color: string; fontFamily: string } }) {
  const spans = inlineSpans(text)
  return (
    <Text selectable style={style}>
      {spans.map((span, index) => (
        <Text
          key={index}
          style={span.code ? { fontFamily: mono, fontSize: style.fontSize - 1.5, color: color.fg, backgroundColor: color.window } : span.bold ? { fontFamily: font.semibold, color: color.fg } : undefined}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  )
}

const BODY = { fontSize: 15, lineHeight: 24, color: BODY_TEXT, fontFamily: font.regular }

function MarkdownBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case 'para':
      return <Inline text={block.text} style={BODY} />
    case 'heading':
      return <Inline text={block.text} style={{ ...BODY, fontSize: block.level <= 2 ? 16.5 : 15.5, fontFamily: font.semibold, color: color.fg }} />
    case 'quote':
      return (
        <View style={{ borderLeftWidth: 2, borderLeftColor: color.lineStrong, paddingLeft: 10 }}>
          <Inline text={block.text} style={{ ...BODY, color: color.fgMuted }} />
        </View>
      )
    case 'rule':
      return <View style={{ height: 1, backgroundColor: color.line, marginVertical: 4 }} />
    case 'list':
      return (
        <View style={{ gap: 4 }}>
          {block.items.map((text, index) => (
            <View key={index} style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={{ ...BODY, color: color.fgDim, minWidth: 14 }}>{block.ordered ? `${index + 1}.` : '•'}</Text>
              <View style={{ flex: 1 }}>
                <Inline text={text} style={BODY} />
              </View>
            </View>
          ))}
        </View>
      )
    case 'code':
      return <CodeBlock lang={block.lang} text={block.text} />
    case 'table':
      return <TableBlock header={block.header} rows={block.rows} />
  }
}

/** 코드 블록(C13·Q9) — 줄바꿈 없이 블록 안 가로 스크롤, 머리에 `줄바꿈` 전환 · `복사`. */
function CodeBlock({ lang, text }: { lang: string | null; text: string }) {
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  const code = <Text selectable style={{ fontFamily: mono, fontSize: 12.5, lineHeight: 19, color: color.fg }}>{text}</Text>
  return (
    <View style={{ backgroundColor: TOOL_CARD_BG, borderRadius: 10, borderWidth: 1, borderColor: color.line, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, height: 32, borderBottomWidth: 1, borderBottomColor: color.line, gap: 12 }}>
        <Text style={{ flex: 1, fontSize: 11.5, color: color.fgDim, fontFamily: mono }}>{lang ?? (wrap ? '' : '↔ 밀어서 보기')}</Text>
        <Pressable accessibilityRole="button" onPress={() => setWrap(!wrap)} hitSlop={8} className="active:opacity-60">
          <Text style={{ fontSize: 12, color: wrap ? color.accent : color.fgMuted, fontFamily: font.medium }}>줄바꿈</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            void Clipboard.setStringAsync(text).then(() => setCopied(true), () => setCopied(false))
          }}
          className="active:opacity-60"
        >
          <Text style={{ fontSize: 12, color: copied ? color.accent : color.fgMuted, fontFamily: font.medium }}>{copied ? '복사됨' : '복사'}</Text>
        </Pressable>
      </View>
      {wrap ? (
        <View style={{ padding: 10 }}>{code}</View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ padding: 10 }}>
          {code}
        </ScrollView>
      )}
    </View>
  )
}

/** 표(C13·Q9) — 4열 이상이면 블록 안 가로 스크롤. 칸 너비는 고정(머리·줄이 같은 열에 선다). */
function TableBlock({ header, rows }: { header: string[]; rows: string[][] }) {
  const columns = Math.max(header.length, ...rows.map((row) => row.length))
  const scroll = columns >= TABLE_SCROLL_COLUMNS
  const cellWidth = scroll ? 140 : undefined
  const row = (cells: string[], index: number, isHeader: boolean) => (
    <View key={index} style={{ flexDirection: 'row', borderTopWidth: index === 0 && isHeader ? 0 : 1, borderTopColor: color.line }}>
      {Array.from({ length: columns }, (_, column) => (
        <View key={column} style={{ width: cellWidth, flex: scroll ? undefined : 1, paddingHorizontal: 8, paddingVertical: 6 }}>
          <Inline text={cells[column] ?? ''} style={{ fontSize: 13, lineHeight: 19, color: isHeader ? color.fg : BODY_TEXT, fontFamily: isHeader ? font.semibold : font.regular }} />
        </View>
      ))}
    </View>
  )
  const body = (
    <View>
      {row(header, 0, true)}
      {rows.map((cells, index) => row(cells, index + 1, false))}
    </View>
  )
  return (
    <View style={{ borderRadius: 10, borderWidth: 1, borderColor: color.line, overflow: 'hidden' }}>
      {scroll ? (
        <ScrollView horizontal showsHorizontalScrollIndicator>
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </View>
  )
}

/** 도구 묶음(Q4·C1·C2·C15) — 머리 42 · 진행 줄 36(작업 중·마지막 묶음) · 누르면 펼쳐 도구·대상·결과(실패 색). 결과 본문은 없다. */
function ToolGroup({ item, live }: { item: Extract<ChatItem, { kind: 'tools' }>; live: boolean }) {
  const [open, setOpen] = useState(false)
  const running = live && item.detail ? runningTool(item) : null
  const failed = item.tools.filter((tool) => tool.status === 'error').length
  const header = (
    <View style={{ height: 42, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 }}>
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 12.5, color: color.fgMuted, fontFamily: mono }}>{toolSummary(item)}</Text>
      {failed > 0 ? <Text style={{ fontSize: 12, color: color.error, fontFamily: font.medium }}>{`실패 ${failed}`}</Text> : null}
      {item.detail ? <Text style={{ fontSize: 11, color: color.fgDim, fontFamily: mono }}>{open ? '▾' : '▸'}</Text> : null}
    </View>
  )
  return (
    <View style={{ backgroundColor: TOOL_CARD_BG, borderWidth: 1, borderColor: color.line, borderRadius: 12, overflow: 'hidden' }}>
      {item.detail ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} className="active:opacity-70">
          {header}
        </Pressable>
      ) : (
        header
      )}
      {!item.detail ? (
        <Text style={{ fontSize: 12.5, color: color.fgDim, fontFamily: font.regular, paddingHorizontal: 12, paddingBottom: 10 }}>이 에이전트는 도구 상세를 보내지 않습니다</Text>
      ) : null}
      {running !== null && !open ? (
        <View style={{ height: 36, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: color.line }}>
          <ActivityIndicator size={10} color={color.accent} />
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 12.5, fontFamily: mono, color: color.fgMuted }}>
            <Text style={{ color: color.accent }}>{running.name ?? '도구'}</Text>
            {running.target === null ? '' : ` ${running.target}`}
          </Text>
        </View>
      ) : null}
      {open ? (
        <View style={{ borderTopWidth: 1, borderTopColor: color.line, paddingVertical: 4 }}>
          {item.count > item.tools.length ? (
            <Text style={{ fontSize: 12, color: color.fgDim, fontFamily: font.regular, paddingHorizontal: 12, paddingVertical: 4 }}>{`앞의 ${item.count - item.tools.length}개는 개수만 보입니다`}</Text>
          ) : null}
          {item.tools.map((tool, index) => {
            const mark = toolMark(tool.status)
            return (
            <View key={index} style={{ minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 }}>
              <Text style={{ width: 14, fontSize: 12, color: mark.tone === 'error' ? color.error : mark.tone === 'running' ? color.accent : color.fgDim, fontFamily: mono }}>
                {mark.mark}
              </Text>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12.5, color: tool.status === 'error' ? color.error : color.fgMuted, fontFamily: mono }}>{toolLine(tool)}</Text>
            </View>
            )
          })}
        </View>
      ) : null}
    </View>
  )
}

/** 질문 카드 — 표시만(답하기는 M5). 답한 질문은 `질문 · … / 답함 → …` 접힌 기록. */
function QuestionCard({ item }: { item: Extract<ChatItem, { kind: 'question' }> }) {
  if (item.state !== 'pending') {
    return (
      <View style={{ backgroundColor: TOOL_CARD_BG, borderWidth: 1, borderColor: color.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, gap: 2 }}>
        <Text numberOfLines={2} style={{ fontSize: 13, color: color.fgMuted, fontFamily: font.regular }}>{`질문 · ${questionLine(item)}`}</Text>
        <Text numberOfLines={2} style={{ fontSize: 13, color: item.state === 'answered' ? color.fg : color.fgDim, fontFamily: font.medium }}>
          {item.state === 'answered' ? `답함 → ${item.answer ?? '(답을 기록에서 찾지 못함)'}` : '닫힘 — 답하지 않고 지나갔습니다'}
        </Text>
        {item.clipped ? <QuestionClipped /> : null}
      </View>
    )
  }
  return (
    <View style={{ backgroundColor: TOOL_CARD_BG, borderWidth: 1, borderColor: color.questionTint40, borderRadius: 14, padding: 14, gap: 10 }}>
      {item.questions.map((question, index) => (
        <View key={index} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 12.5, color: color.dotQuestion, fontFamily: font.semibold }}>{question.header ?? '질문'}</Text>
            {item.questions.length > 1 ? <Text style={{ fontSize: 12.5, color: color.fgDim, fontFamily: mono }}>{`${index + 1} / ${item.questions.length}`}</Text> : null}
          </View>
          <Text selectable style={{ fontSize: 15.5, lineHeight: 22, color: color.fg, fontFamily: font.semibold }}>{question.question}</Text>
          {question.options.map((option, optionIndex) => (
            <View key={optionIndex} style={{ minHeight: 52, borderRadius: 10, borderWidth: 1, borderColor: color.lineStrong, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 18, height: 18, borderRadius: question.multiSelect === true ? 5 : 9, borderWidth: 1.5, borderColor: color.lineStrong }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, color: color.fg, fontFamily: font.medium }}>{option.label}</Text>
                {option.description !== null ? <Text style={{ fontSize: 12.5, color: color.fgMuted, fontFamily: font.regular }}>{option.description}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ))}
      {item.clipped ? <QuestionClipped /> : null}
      <Text style={{ fontSize: 12.5, color: color.fgDim, fontFamily: font.regular }}>답은 맥에서 — 폰에서 답하기는 다음 업데이트에서 들어옵니다</Text>
    </View>
  )
}

/** 질문이 너무 커서 서버가 글·문항·선택지 일부를 덜어 냈다(R1-A5). */
function QuestionClipped() {
  return <Text style={{ fontSize: 12, color: color.fgDim, fontFamily: font.regular }}>… 질문이 길어 일부만 보입니다 — 전체는 맥에서</Text>
}

/** SystemNote(권한 대기·중단됨·실패·압축) — StatusGlyph 자리 점 + 제목 14.5/600 상태색 + 도구 칩 + 설명 13.5. */
function SystemNote({ tint, title, chip, detail }: { tint: string; title: string; chip: string | null; detail: string | null }) {
  return (
    <View style={{ borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: color.window, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tint }} />
        <Text style={{ fontSize: 14.5, color: tint, fontFamily: font.semibold }}>{title}</Text>
      </View>
      {chip !== null ? (
        <View style={{ alignSelf: 'flex-start', backgroundColor: color.surface, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text numberOfLines={2} style={{ fontSize: 12.5, color: color.fgMuted, fontFamily: mono }}>{chip}</Text>
        </View>
      ) : null}
      {detail !== null ? <Text selectable style={{ fontSize: 13.5, lineHeight: 20, color: color.fgMuted, fontFamily: font.regular }}>{detail}</Text> : null}
    </View>
  )
}
