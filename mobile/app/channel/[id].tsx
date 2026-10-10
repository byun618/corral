// 대화 화면 (LIFE-580 J3 머리 · LIFE-581 본문 · LIFE-582 쓰기) — 머리(`ConversationHeader` + 오른쪽 중단 버튼) + 대화(`Conversation`) + 입력창(`Composer`).
// 쓰기 규칙(Composer 8행·중단 버튼·질문 잠금·보낸 지시 자리)은 `core/input.ts`, 보낸 것의 상태는 `inputStore`. 대화의 제스처·따라가기는 그대로(LIFE-595).
// 열면 대화를 구독하고(`chatStore.open`) 떠나면 끊는다. 재연결·포그라운드 복귀 뒤 이어 받기는 chatStore 가 한다(X6).
// 열면 읽음(J1). Android 뒤로 = 목록(스택 기본 동작). 목록이 바뀌면 머리도 따라 바뀐다(상태·제목).
// 버전 불일치(B8 · 579 Q10)면 목록 화면과 같이 채널 정보(제목·소속·모델·출신)를 숨기고 버전 안내만 — 읽음 장부도 바꾸지 않는다(R1-A6).
// 셋째 줄 「띄운 세션」 은 부모가 있으면 항상(579 Q3, R1 C2 — 목록 행 규칙과 다르다).
// 목록 실패(R2-A2 — 읽지 못함·구독 거부·응답 없음)면 Home 과 같은 정책: 「오래된 값」 띠(기준 시각 · 호환 불가면 업데이트 안내),
// 상태는 「확인 불가」, 실패 중에는 읽음 장부를 바꾸지 않는다(최신이 아닌 것을 봤다고 치지 않는다).
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { locateChannel } from '../../src/core/list'
import { failureText, headerMeta, headerStatus } from '../../src/core/list-view'
import { listOf } from '../../src/core/list-store'
import {
  FINAL_STATES,
  answerLine,
  composerMode,
  connKind,
  openQuestion,
  placeSent,
  questionLocked,
  stopLine,
  stopView,
  toggleChoice,
  withOther,
  type StepAnswer,
} from '../../src/core/input'
import { connection, useConnection } from '../../src/runtime/connection'
import { chatStore, useChat } from '../../src/runtime/chat'
import { inputStore, useInput } from '../../src/runtime/input'
import { listStore, useList } from '../../src/runtime/list'
import { toneColor } from '../../src/ui/ChannelList'
import { Composer } from '../../src/ui/Composer'
import { ConnectionBand } from '../../src/ui/ConnectionBand'
import { Conversation } from '../../src/ui/Conversation'
import { Screen } from '../../src/ui/Screen'
import { StopButton } from '../../src/ui/StopButton'
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
  // 본문 흐림은 실제 끊김(C18 — `reconnecting` 의 `offline`)에만. 재연결 중에는 3초 유예 전·후 모두 흐리지 않는다(디자인 Q10, R3-A2) — 연결 띠의 유예는 `band.ts` 그대로.
  const dim = conn.kind === 'reconnecting' && conn.offline
  const closed = channel?.status === 'closed'
  // 표시 점 하나 — 아바타 배지·별도 점·상태 글이 같이 쓴다(R3-A3).
  const status = channel === null ? null : headerStatus({ channel, unknown })
  const third = channel === null ? null : headerMeta(channel)
  const chat = useChat()
  // 대화 구독 — 버전이 다르면 열지 않는다. 채널 id 만 보낸다(서버가 목록 안에서 세션을 고른다).
  useEffect(() => {
    if (mismatch || id === '') return
    chatStore.open(id)
    return () => chatStore.close(id)
  }, [id, mismatch])
  // --- 쓰기 (LIFE-582) ---
  const input = useInput()
  const kindOfConn = connKind(conn)
  const mine = input.entries.filter((entry) => entry.channel === id)
  const question = channel !== null && channel.status === 'live' && !unknown ? openQuestion(chat.items) : null
  // 질문 답 초안 — 질문이 바뀌면 처음부터. 입력창의 직접 입력과 카드가 같이 쓴다.
  const [draft, setDraft] = useState<{ question: number | null; step: number; answers: StepAnswer[] }>({ question: null, step: 0, answers: [] })
  const current = question !== null && draft.question === question.id ? draft : { question: question?.id ?? null, step: 0, answers: [] }
  const lastAnswer = mine.filter((entry) => entry.op === 'answer').at(-1) ?? null
  const answerBusy = lastAnswer !== null && !FINAL_STATES.has(lastAnswer.state)
  const lastStop = mine.filter((entry) => entry.op === 'stop').at(-1) ?? null
  const stopResult = lastStop === null ? null : stopLine(lastStop)
  const noSession = chat.phase.kind === 'unavailable' && chat.phase.reason === 'no_session'
  const mode = channel === null ? null : composerMode({ channel, conn: kindOfConn, unknown, question, step: current.step, noSession })
  const stop = channel === null ? 'hidden' : stopView({ channel, conn: kindOfConn, unknown })
  const sent = placeSent({ items: chat.items, sent: mine })
  const tailId = chat.items.at(-1)?.id ?? null
  // 보낸 뒤에도 초안을 그대로 둔다 — 실패하면 같은 답을 다시 보낼 수 있다(R1-A11). 질문이 닫히면(다른 id) 초안은 저절로 처음부터다.
  const sendAnswers = (answers: StepAnswer[]): void => {
    if (question === null) return
    inputStore.answer({ channel: id, question: question.id, call: question.call, digest: question.digest, answers })
  }
  /** 문항 하나를 채우고 다음 문항으로 — 마지막이면 보낸다. */
  const commitStep = (answer: StepAnswer): void => {
    if (question === null) return
    const answers = [...current.answers]
    answers[current.step] = answer
    if (current.step >= question.questions.length - 1) return sendAnswers(answers)
    setDraft({ question: question.id, step: current.step + 1, answers })
  }
  const control =
    question === null || channel === null
      ? null
      : {
          id: question.id,
          locked: questionLocked({ kind: channel.kind, item: question }),
          step: current.step,
          answers: current.answers,
          busy: answerBusy || kindOfConn !== 'connected',
          line: lastAnswer === null ? null : answerLine(lastAnswer),
          onToggle: (choice: number) => {
            const step = question.questions[current.step]
            if (step === undefined) return
            const answers = [...current.answers]
            answers[current.step] = toggleChoice({ question: step, answer: current.answers[current.step] ?? { choices: [], other: null }, choice })
            setDraft({ question: question.id, step: current.step, answers })
          },
          onConfirm: () => commitStep(current.answers[current.step] ?? { choices: [], other: null }),
        }
  const submit = (text: string): boolean => {
    if (mode === null || mode.kind !== 'open') return false
    if (mode.target === 'send') return inputStore.send({ channel: id, text, tailId }) !== null
    const step = question?.questions[current.step]
    if (step === undefined || answerBusy) return false
    commitStep(withOther({ question: step, answer: current.answers[current.step] ?? { choices: [], other: null }, text }))
    // 직접 입력 글은 지우지 않는다 — 답이 실패하면 그대로 다시 보낼 수 있게(R1-A11). 다음 문항·질문이 닫히면 입력창이 새로 열린다(아래 key).
    return false
  }
  // 입력창의 수명 = 논리적 질문·문항(R2-A8). 연결이 잠깐 끊겨 질문을 모르는(`unknown`) 동안은 직전 키를 그대로 둔다 — 잠긴 입력창이 쓴 글을 지니고 있다가
  // 다시 붙으면 그대로 열린다. 질문이 닫히거나 다음 문항으로 가면(아는 상태에서 키가 바뀜) 새 입력창이다.
  const keyRef = useRef('send')
  if (!unknown) keyRef.current = question !== null ? `answer:${question.id}:${current.step}` : 'send'
  const composerKey = keyRef.current
  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingRight: 16, paddingVertical: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="뒤로" onPress={() => router.back()} className="active:opacity-60" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 22, color: color.fg }}>←</Text>
        </Pressable>
        {channel !== null ? (
          <View style={{ paddingTop: 5 }}>
            <Avatar kind={channel.kind} dot={status?.dot ?? 'unverifiable'} closed={closed} size={34} />
          </View>
        ) : null}
        <View style={{ flex: 1, gap: 2, paddingTop: 4, paddingLeft: 4 }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontFamily: font.semibold, color: color.fg }}>
            {mismatch ? '대화' : (channel?.title ?? '세션')}
          </Text>
          {found !== null ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <StatusGlyph dot={status?.dot ?? 'unverifiable'} closed={closed} />
              <Text style={{ fontSize: 13, fontFamily: font.medium, color: status === null ? color.fgMuted : toneColor(status.tone) }}>{status?.label ?? ''}</Text>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 11.5, fontFamily: font.mono, color: color.fgDim }}>{`${found.repo.name} › ${found.task.name}`}</Text>
            </View>
          ) : null}
          {third !== null ? (
            <Text numberOfLines={1} style={{ fontSize: 11.5, fontFamily: font.mono, color: color.fgDim }}>
              {third}
            </Text>
          ) : null}
        </View>
        {!mismatch && channel !== null ? (
          <View style={{ paddingTop: 2 }}>
            <StopButton view={stop} onStop={() => void inputStore.stop({ channel: id })} />
          </View>
        ) : null}
      </View>
      <ConnectionBand conn={conn} onReconnect={() => connection.reconnectNow()} />
      {failure !== null && staleAt !== null ? <StaleBand failure={failure} receivedAt={staleAt} /> : null}
      {channel !== null && !unknown && channel.dot === 'monitoring' ? (
        // 지켜보는 중 띠(C10) — 백그라운드 개수는 목록에 없어 글만. 중단은 지금 턴만 멈춘다(Z1ⓓ — 문구 후보 A, 게이트 ① 에서 확정).
        <View style={{ height: 30, justifyContent: 'center', paddingHorizontal: 18, backgroundColor: color.accentTint8 }}>
          <Text numberOfLines={1} style={{ fontSize: 12.5, color: color.accent, fontFamily: font.medium }}>∿ 백그라운드 작업을 지켜보는 중 · 멈추기는 지금 턴만</Text>
        </View>
      ) : null}
      {!mismatch && lastStop !== null && stopResult !== null ? (
        // 중단 결과 한 줄 — 닫을 때까지 남는다(재연결 뒤 조회로 바뀔 수 있다).
        <View style={{ minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, backgroundColor: stopResult.tone === 'error' ? color.errorTint12 : color.window }}>
          <Text style={{ flex: 1, fontSize: 12.5, color: stopResult.tone === 'error' ? color.error : color.fgMuted, fontFamily: font.medium }}>{stopResult.text}</Text>
          {FINAL_STATES.has(lastStop.state) ? (
            <Pressable accessibilityRole="button" accessibilityLabel="닫기" onPress={() => inputStore.dismiss(lastStop.id)} className="active:opacity-60" hitSlop={8}>
              <Text style={{ fontSize: 14, color: color.fgMuted }}>×</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {conn.kind === 'mismatch' ? (
        <VersionMismatch appVersion={appVersion} serverVersion={info?.serverVersion ?? null} supported={conn.supported} />
      ) : channel !== null ? (
        <>
          <Conversation
            channel={channel}
            chat={chat}
            unknown={unknown}
            dim={dim}
            onOlder={() => chatStore.loadOlder()}
            onRetry={() => chatStore.retry()}
            sent={sent}
            onSentAction={({ id: entry, action }) => void (action === 'cancel' ? inputStore.cancel(entry) : inputStore.retry(entry))}
            question={control}
          />
          {mode !== null ? <Composer key={composerKey} mode={mode} onSubmit={submit} /> : null}
        </>
      ) : (
        <View className="flex-1 items-center justify-center gap-2 px-padx">
          {channel === null ? (
            <Text style={{ fontSize: 15, color: color.fgMuted, fontFamily: font.regular }}>{failure !== null && staleAt === null ? failureText(failure).title : '이 세션은 지금 목록에 없습니다'}</Text>
          ) : null}
        </View>
      )}
    </Screen>
  )
}
