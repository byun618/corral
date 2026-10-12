// 대화 본문 (LIFE-581 X9 — 579 C1·C2·C6(표시)·C8·C9·C11·C13·C15·C16·C18·C19) — 말풍선 4종·SystemNote·도구 묶음·마크다운·과거 불러오기·`새 메시지 ↓`.
// 입력창·중단 버튼은 채널 화면(M5 LIFE-582)이 이 아래·머리에 그린다. 여기는 보낸 지시 상태 줄(C12)과 질문 답 카드(C3·C4·C5)를 더한다 — 색·크기는 design-handoff §2·§3 / tokens.ts.
//
// 목록은 뒤집힌 FlatList(가장 새 말풍선이 index 0 = 화면 아래). 과거 페이지는 배열 끝(화면 위)에 붙어 보던 자리가 움직이지 않는다(C16 위치 유지).
// 새 말풍선은 아래(index 0)에 붙고, 맨 아래에 있지 않으면 `maintainVisibleContentPosition` 이 보던 말풍선을 제자리에 두고 `새 메시지 ↓` 를 띄운다.
import * as Clipboard from 'expo-clipboard'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import type { ChatItem } from '../core/chat'
import type { ChatSnapshot } from '../core/chat-store'
import { questionLockText, sentLine, stepReady, type QuestionLock, type SentEntry, type SentLine, type StepAnswer } from '../core/input'
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

/** 도구·질문·코드 카드 배경 = 확정 토큰 `--m-tool-card-bg: var(--bg-window)`(`specs/design-tokens-mobile.css` — #121212 는 쓰지 않는다, R2-A6). */
const TOOL_CARD_BG = color.window
const BODY_TEXT = '#e5e5e5'
const AGENT_NAME: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok' }

export type ConversationProps = {
  channel: Channel
  chat: ChatSnapshot
  /** 연결이 확인되지 않음(재연결·끊김)·목록 실패 — 지금 상태(작업 중·상태 카드)를 믿지 않는다. 본문 흐림과는 따로다(R3-A2). */
  unknown: boolean
  /** 본문 흐림 — 실제 끊김(C18)에만. 재연결 중(유예 전·후)은 흐리지 않는다(디자인 Q10, R3-A2). */
  dim: boolean
  onOlder: () => void
  onRetry: () => void
  /** 보낸 지시(LIFE-582 C12) — 기록의 「내 지시」 에 붙은 것(`attached`, 말풍선 id → 항목)과 아직 기록에 없는 것(`trailing`). 없으면 그리지 않는다. */
  sent?: { attached: ReadonlyMap<number, SentEntry>; trailing: readonly SentEntry[] }
  /** 보낸 지시의 `취소`·`다시 보내기`. */
  onSentAction?: (input: { id: string; action: 'cancel' | 'retry' }) => void
  /** 지금 답할 수 있는 질문(LIFE-582) — 그 질문 카드만 누를 수 있다. 없으면 질문은 표시만. */
  question?: QuestionControl | null
}

/** 질문 답 조작 — 상태는 채널 화면이 든다(입력창의 직접 입력과 같이 쓴다). */
export type QuestionControl = {
  id: number
  /** 폰에서 답할 수 없는 질문 — 선택지를 잠그고 안내 한 줄(`questionLockText`). */
  lock: QuestionLock
  kind: AgentKind | null
  step: number
  answers: readonly StepAnswer[]
  /** 답을 보내는 중 — 다시 누르지 못한다. */
  busy: boolean
  /** 결과 한 줄(실패·확인 못 함·보내는 중). */
  line: { tone: 'muted' | 'error'; text: string } | null
  onToggle: (choice: number) => void
  onConfirm: () => void
}

/** 맨 아래로 치는 거리(dp, 뒤집힌 목록의 contentOffset.y) — 이 안이면 따라가고, 넘으면 자리를 지키고 「새 메시지 ↓」. 하나의 임계다(n-12). */
export const NEAR_BOTTOM = 120
/** 손을 뗀 뒤 관성 시작을 기다리는 시간(ms) — 이 안에 `onMomentumScrollBegin` 이 오면 관성 종료에서 정한다. Android 는 손을 떼면 늘 관성 이벤트를 낸다(ReactScrollView `handlePostTouchScrolling`), iOS 는 감속할 때만. */
const RELEASE_MS = 100

/** 손가락 제스처 단계 — 이 동안은 크기 변화로 맨 아래에 붙이지 않고, 끝(`none` 으로 돌아올 때) 한 번 정한다. */
type Gesture = 'none' | 'drag' | 'release' | 'momentum'

export function Conversation({ channel, chat, unknown, dim, onOlder, onRetry, sent, onSentAction, question }: ConversationProps) {
  const state = bodyState({ phase: chat.phase, count: chat.items.length })
  const list = useRef<FlatList<ChatItem>>(null)
  // 맨 아래를 떠난 순간의 맨 아래 쪽 변경 횟수(`tailRev`) — 그 뒤 새 말풍선이 붙거나 마지막 답이 자라면 「새 메시지 ↓」(R1-A10). 맨 아래로 돌아오면 지운다.
  const [awayFrom, setAwayFrom] = useState<number | null>(null)
  const tailRev = chat.tailRev
  const data = useMemo(() => [...chat.items].reverse(), [chat.items])
  const heads = useMemo(() => replyHeads(chat.items), [chat.items])
  const live = channel.status === 'live' && !unknown
  const working = live && channel.dot === 'working'
  const seenTail = useRef(tailRev)
  // 아직 맨 아래에 반영하지 않은 맨 아래 쪽 변경(`pending`)과, 그 변경 전 `tailRev`(`pendingBase` — 떠난 채 정하면 이 값을 기준으로 「새 메시지 ↓」).
  const pending = useRef(false)
  const pendingBase = useRef(tailRev)
  if (seenTail.current !== tailRev) {
    if (!pending.current) pendingBase.current = seenTail.current
    seenTail.current = tailRev
    pending.current = true
  }
  const lastY = useRef(0)
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      lastY.current = event.nativeEvent.contentOffset.y
      const isAway = lastY.current > NEAR_BOTTOM
      const base = pending.current ? pendingBase.current : tailRev
      setAwayFrom((previous) => (isAway ? (previous ?? base) : null))
    },
    [tailRev],
  )
  const showNew = awayFrom !== null && tailRev !== awayFrom
  // 맨 아래 따라가기(네이티브 n-12) — 임계 안(`NEAR_BOTTOM`)이면 새 말풍선·자란 말풍선 뒤 맨 아래로 붙인다. 이때는 `maintainVisibleContentPosition` 을 끈다:
  // 켜 두면 네이티브가 보던 말풍선 자리를 지키고, `autoscrollToTopThreshold` 는 정확히 맨 아래가 아니면(에뮬레이터 실측 26dp 에서도) 따라가지 않아
  // 새 답이 화면 아래로 밀린 채 버튼도 없었다(버튼 임계 120 과 따로 놀았다). 위를 보던 사람(임계 밖)만 자리를 지키고 「새 메시지 ↓」.
  // 붙이는 건 맨 아래 쪽이 바뀐 뒤(`tailRev`) 첫 크기 변화 한 번이고, 손가락 제스처(끌기·놓은 직후·관성) 동안은 안 붙인다 — 끌 때 가상화가 새 셀을 재며 크기가 바뀌는데,
  // 그때 붙이면 임계를 넘기 전에 맨 아래로 도로 끌어내렸다(에뮬레이터 N-7*-o160-post2). 관성 중 강제 스크롤은 사용자의 fling 을 끊는다.
  // 제스처 중 들어온 변경은 제스처가 끝날 때(`settle`) 최신 offset 으로 정한다 — 임계 안이면 맨 아래로, 밖이면 자리 유지 + 「새 메시지 ↓」.
  // 끝난 뒤 크기 이벤트가 한 번 더 온다고 기대하지 않는다(새 답의 배치는 끄는 중에 이미 끝났을 수 있다 — r5 R5-A1).
  const following = awayFrom === null
  const followingRef = useRef(following)
  followingRef.current = following
  const gesture = useRef<Gesture>('none')
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearRelease = useCallback(() => {
    if (releaseTimer.current !== null) clearTimeout(releaseTimer.current)
    releaseTimer.current = null
  }, [])
  useEffect(() => clearRelease, [clearRelease])
  // 목록(FlatList)이 화면에서 빠지면(불러오는 중·실패 — stale·reset·resume 은 목록을 남긴다) 그 목록의 제스처도 끝난 것이다. 빠진 목록은 관성 종료를 보내지 않으므로
  // 여기서 단계·놓음 타이머·offset·보류·떠난 기준을 함께 비운다 — 다시 붙는 목록은 맨 아래(offset 0)에서 새로 시작한다(r6 R6-A1: 관성 중 실패 → 재시도 뒤 `momentum` 이 남아 새 답을 계속 막았다).
  const listShown = state.kind !== 'loading' && state.kind !== 'failed'
  useEffect(() => {
    if (listShown) return
    clearRelease()
    gesture.current = 'none'
    lastY.current = 0
    pending.current = false
    pendingBase.current = seenTail.current
    setAwayFrom(null)
  }, [listShown, clearRelease])
  const onContentSizeChange = useCallback(() => {
    if (!pending.current || gesture.current !== 'none' || !followingRef.current) return
    pending.current = false
    list.current?.scrollToOffset({ offset: 0, animated: false })
  }, [])
  const settle = useCallback(() => {
    gesture.current = 'none'
    if (!pending.current) return
    pending.current = false
    if (lastY.current <= NEAR_BOTTOM) {
      setAwayFrom(null)
      list.current?.scrollToOffset({ offset: 0, animated: true })
      return
    }
    const base = pendingBase.current
    setAwayFrom((previous) => previous ?? base)
  }, [])
  const onScrollBeginDrag = useCallback(() => {
    // 맨 아래를 따라가는 중 제스처 없이 남은 보류는 크기 변화가 없던 변경(24줄 접힌 답 안의 숨은 줄 등)이라 화면에 붙일 것이 없다 — 지워서 놓을 때 도로 끌어내리지 않는다
    // (에뮬레이터 A-F5-fold). 관성·놓은 직후에 다시 잡았거나 떠나 있던 동안 들어온 보류는 남긴다.
    if (gesture.current === 'none' && followingRef.current) pending.current = false
    clearRelease()
    gesture.current = 'drag'
  }, [clearRelease])
  const onScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      lastY.current = event.nativeEvent.contentOffset.y
      gesture.current = 'release'
      clearRelease()
      releaseTimer.current = setTimeout(() => {
        releaseTimer.current = null
        if (gesture.current === 'release') settle()
      }, RELEASE_MS)
    },
    [clearRelease, settle],
  )
  const onMomentumScrollBegin = useCallback(() => {
    clearRelease()
    if (gesture.current !== 'drag') gesture.current = 'momentum'
  }, [clearRelease])
  const onMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      lastY.current = event.nativeEvent.contentOffset.y
      if (gesture.current === 'momentum') settle()
    },
    [settle],
  )

  if (state.kind === 'loading') {
    return (
      <View className="flex-1 items-center justify-center gap-3 px-padx">
        <ActivityIndicator color={color.fgMuted} />
        <Text style={{ fontSize: 14, color: color.fgMuted, fontFamily: font.regular }}>대화를 불러오는 중…</Text>
      </View>
    )
  }
  if (state.kind === 'failed') {
    // 기록이 없어도 보낸 지시의 상태(보내는 중·대기 중·실패·다시 보내기)는 보인다 — 글이 사라진 채 아무 표시가 없으면 블랙홀이다(최종 관문 Z8 s39·s40).
    return <NoRecord state={state} trailing={sent?.trailing ?? []} monitoring={channel.dot === 'monitoring'} onRetry={onRetry} onSentAction={onSentAction} />
  }
  const stale = chat.stale === null ? null : staleText(chat.stale)
  return (
    <View style={{ flex: 1, opacity: dim ? 0.5 : 1 }}>
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
          <Bubble
            item={item}
            head={heads.has(item.id)}
            kind={channel.kind}
            last={index === 0}
            working={working}
            monitoring={channel.dot === 'monitoring'}
            sent={sent?.attached.get(item.id) ?? null}
            onSentAction={onSentAction}
            question={question !== undefined && question !== null && question.id === item.id ? question : null}
          />
        )}
        maintainVisibleContentPosition={following ? undefined : { minIndexForVisible: 0 }}
        onContentSizeChange={onContentSizeChange}
        onEndReached={() => onOlder()}
        onEndReachedThreshold={0.4}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        onMomentumScrollBegin={onMomentumScrollBegin}
        onMomentumScrollEnd={onMomentumScrollEnd}
        scrollEventThrottle={100}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12, gap: 14 }}
        ListHeaderComponent={<Trailer channel={channel} live={live} empty={state.kind === 'empty' && (sent?.trailing.length ?? 0) === 0} items={chat.items} dropped={chat.dropped} sent={sent?.trailing ?? []} onSentAction={onSentAction} />}
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
/**
 * 기록 없음 화면 — 안내 + 보낸 지시 줄을 높이가 제한된 스크롤 영역에 둔다(R9-A1: 실패 여러 개·긴 지시·키보드로 줄어든 높이에서도 마지막 상태·취소·다시 보내기까지 닿는다).
 * 새 줄이 붙거나 높이가 바뀌면 끝으로 따라가 마지막 상태가 보인다. 대화 FlatList·제스처 분기와는 따로다.
 */
function NoRecord({ state, trailing, monitoring, onRetry, onSentAction }: { state: { title: string; detail: string; retry: boolean }; trailing: readonly SentEntry[]; monitoring: boolean; onRetry: () => void; onSentAction?: (input: { id: string; action: 'cancel' | 'retry' }) => void }) {
  const scroll = useRef<ScrollView>(null)
  const toEnd = useCallback(() => scroll.current?.scrollToEnd({ animated: false }), [])
  return (
    <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" onContentSizeChange={toEnd} onLayout={toEnd}>
      <View className="flex-1 items-center justify-center gap-2 px-padx" style={{ paddingVertical: 24 }}>
        <Text style={{ fontSize: 15, color: color.fg, fontFamily: font.medium, textAlign: 'center' }}>{state.title}</Text>
        <Text style={{ fontSize: 13.5, color: color.fgMuted, fontFamily: font.regular, textAlign: 'center' }}>{state.detail}</Text>
        {state.retry ? (
          <Pressable accessibilityRole="button" onPress={onRetry} className="mt-2 h-11 justify-center rounded-pill border border-line-strong px-5 active:opacity-70">
            <Text style={{ fontSize: 14, color: color.fg, fontFamily: font.semibold }}>다시 시도</Text>
          </Pressable>
        ) : null}
      </View>
      {trailing.length > 0 ? (
        <View style={{ gap: 12, paddingHorizontal: 16, paddingBottom: 12 }}>
          {trailing.map((entry) => (
            <PromptBubble key={entry.id} text={entry.text ?? ''} clipped={null} status={sentLine({ entry, hhmm, monitoring })} onAction={(action) => onSentAction?.({ id: entry.id, action })} />
          ))}
        </View>
      ) : null}
    </ScrollView>
  )
}

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
function Trailer({ channel, live, empty, items, dropped, sent, onSentAction }: { channel: Channel; live: boolean; empty: boolean; items: readonly ChatItem[]; dropped: number; sent: readonly SentEntry[]; onSentAction?: (input: { id: string; action: 'cancel' | 'retry' }) => void }) {
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
      {sent.map((entry) => (
        // 아직 기록에 「내 지시」 로 보이지 않는 보낸 지시(보내는 중·대기 중·실패·확인 못 함) — 대화 끝에.
        <PromptBubble key={entry.id} text={entry.text ?? ''} clipped={null} status={sentLine({ entry, hhmm, monitoring: channel.dot === 'monitoring' })} onAction={(action) => onSentAction?.({ id: entry.id, action })} />
      ))}
      {channel.status === 'closed' ? (
        <View style={{ height: 56, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1, borderTopColor: color.line }}>
          <Text style={{ fontSize: 13, color: color.fgDim, fontFamily: font.regular }}>세션이 닫혔습니다 · 지난 기록만 볼 수 있습니다</Text>
        </View>
      ) : null}
    </View>
  )
}

type BubbleProps = {
  item: ChatItem
  head: boolean
  kind: AgentKind | null
  last: boolean
  working: boolean
  /** 백그라운드를 지켜보는 중 — 대기 줄 문구(C2). */
  monitoring: boolean
  sent: SentEntry | null
  onSentAction?: (input: { id: string; action: 'cancel' | 'retry' }) => void
  question: QuestionControl | null
}

const Bubble = memo(function Bubble({ item, head, kind, last, working, monitoring, sent, onSentAction, question }: BubbleProps) {
  switch (item.kind) {
    case 'prompt':
      return (
        <PromptBubble
          text={item.body.text}
          clipped={item.body.clipped}
          status={sent === null ? null : sentLine({ entry: sent, hhmm, monitoring })}
          onAction={(action) => (sent === null ? undefined : onSentAction?.({ id: sent.id, action }))}
        />
      )
    case 'reply':
      return <ReplyBlock item={item} head={head} kind={kind} cursor={last && working} />
    case 'tools':
      return <ToolGroup item={item} live={last && working} />
    case 'question':
      return question === null ? <QuestionCard item={item} /> : <QuestionAnswerCard item={item} control={question} />
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

/** 내 지시 — 보낸 지시면 아래 상태 한 줄(§1 Q7): 보내는 중(말풍선 55%) · 대기 중 + 취소 · 들어감 ✓ · 실패(테두리 `--st-error`) + 다시 보내기. */
function PromptBubble({ text, clipped, status = null, onAction }: { text: string; clipped: number | null; status?: SentLine | null; onAction?: (action: 'cancel' | 'retry') => void }) {
  const [expanded, setExpanded] = useState(false)
  const folded = foldText({ text, expanded })
  const failed = status?.tone === 'error'
  return (
    <View style={{ alignSelf: 'flex-end', marginLeft: 44, maxWidth: '100%', gap: 4 }}>
      <View style={{ opacity: status?.faded === true ? 0.55 : 1, backgroundColor: color.chip, borderRadius: 18, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 10, borderWidth: failed ? 1 : 0, borderColor: color.error }}>
        <Text selectable style={{ fontSize: 15, lineHeight: 22.5, color: color.fg, fontFamily: font.regular }}>{folded.text}</Text>
        {folded.hiddenLines > 0 ? <MoreLines hidden={folded.hiddenLines} onPress={() => setExpanded(true)} /> : null}
        <Clipped clipped={clipped} />
      </View>
      {status !== null ? <SentStatus line={status} onAction={onAction} /> : null}
    </View>
  )
}

const SENT_TONE: Record<SentLine['tone'], string> = { muted: color.fgMuted, question: color.dotQuestion, dim: color.fgDim, error: color.error }

function SentStatus({ line, onAction }: { line: SentLine; onAction?: (action: 'cancel' | 'retry') => void }) {
  const action = line.action
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10, paddingRight: 4 }}>
      <Text style={{ flexShrink: 1, fontSize: 12, color: SENT_TONE[line.tone], fontFamily: font.regular, textAlign: 'right' }}>{line.text}</Text>
      {action !== null ? (
        <Pressable accessibilityRole="button" onPress={() => onAction?.(action)} className="active:opacity-60" hitSlop={8}>
          <Text style={{ fontSize: 12, color: color.fg, fontFamily: font.semibold }}>{action === 'cancel' ? '취소' : '다시 보내기'}</Text>
        </Pressable>
      ) : null}
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
          <Avatar kind={kind} size={22} />
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

/** 질문 카드 — 표시만(지금 답할 수 없을 때 — 연결 없음·지난 질문. 답하기는 `QuestionAnswerCard`). 답한 질문은 `질문 · … / 답함 → …` 접힌 기록. */
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
      <Text style={{ fontSize: 12.5, color: color.fgDim, fontFamily: font.regular }}>연결되면 여기서 답할 수 있습니다 — 지금은 맥에서</Text>
    </View>
  )
}

/**
 * 답할 수 있는 질문 카드(C3 하나 + 직접 입력 · C4 여럿 · C5 여러 문항 `n / m`) — design-handoff §2 QuestionOption. 지금 문항만 보인다.
 * 직접 입력은 아래 입력창이 맡는다(P4ⓔ). 잠긴 질문은 선택지를 누를 수 없고 `맥에서 답해 주세요`.
 */
function QuestionAnswerCard({ item, control }: { item: Extract<ChatItem, { kind: 'question' }>; control: QuestionControl }) {
  const total = item.questions.length
  const step = Math.min(control.step, total - 1)
  const question = item.questions[step]
  if (question === undefined) return <QuestionCard item={item} />
  const answer = control.answers[step] ?? { choices: [], other: null }
  const multi = question.multiSelect === true
  const last = step === total - 1
  const locked = control.lock !== 'open'
  const ready = !locked && !control.busy && stepReady({ question, answer })
  const count = answer.choices.length + (answer.other === null ? 0 : 1)
  const label = !last ? '다음' : multi && count > 1 ? `${count}개 보내기` : '보내기'
  return (
    <View style={{ backgroundColor: TOOL_CARD_BG, borderWidth: 1, borderColor: color.questionTint40, borderRadius: 14, padding: 14, gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 12.5, color: color.dotQuestion, fontFamily: font.semibold }}>{`${question.header ?? '질문'}${multi ? ' · 여러 개 고르기' : ''}`}</Text>
        {total > 1 ? <Text style={{ fontSize: 12.5, color: color.fgDim, fontFamily: mono }}>{`${step + 1} / ${total}`}</Text> : null}
      </View>
      <Text selectable style={{ fontSize: 15.5, lineHeight: 22, color: color.fg, fontFamily: font.semibold }}>{question.question}</Text>
      {question.options.map((option, index) => {
        const selected = answer.choices.includes(index)
        return (
          <Pressable
            key={index}
            accessibilityRole={multi ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: selected, disabled: locked || control.busy }}
            disabled={locked || control.busy}
            onPress={() => control.onToggle(index)}
            className="active:opacity-80"
            style={{ minHeight: 52, borderRadius: 10, borderWidth: 1, borderColor: selected ? color.dotQuestion : color.lineStrong, backgroundColor: selected ? color.questionTint8 : 'transparent', paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 }}
          >
            <View style={{ width: 18, height: 18, borderRadius: multi ? 5 : 9, borderWidth: 1.5, borderColor: selected ? color.dotQuestion : color.lineStrong, backgroundColor: selected ? color.dotQuestion : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
              {selected ? <Text style={{ fontSize: 11, color: color.surface, fontFamily: font.semibold }}>✓</Text> : null}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14.5, color: color.fg, fontFamily: font.medium }}>{option.label}</Text>
              {option.description !== null ? <Text style={{ fontSize: 12.5, color: color.fgMuted, fontFamily: font.regular }}>{option.description}</Text> : null}
            </View>
          </Pressable>
        )
      })}
      {answer.other !== null ? <Text numberOfLines={2} style={{ fontSize: 13, color: color.fgMuted, fontFamily: font.regular }}>{`직접 입력 → ${answer.other}`}</Text> : null}
      {control.lock !== 'open' ? (
        <Text style={{ fontSize: 12.5, color: color.fgDim, fontFamily: font.regular }}>{questionLockText({ lock: control.lock, kind: control.kind })}</Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={control.onConfirm}
          className="active:opacity-80"
          style={{ height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: ready ? color.fg : color.chip }}
        >
          <Text style={{ fontSize: 14.5, color: ready ? color.surface : color.fgFaint, fontFamily: font.semibold }}>{label}</Text>
        </Pressable>
      )}
      {control.line !== null ? <Text style={{ fontSize: 12.5, color: control.line.tone === 'error' ? color.error : color.fgMuted, fontFamily: font.regular }}>{control.line.text}</Text> : null}
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
