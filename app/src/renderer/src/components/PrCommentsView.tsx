// PR 보기 (LIFE-811) — 오른쪽 패널 몸통. 활성 worktree 의 PR 에 달린 리뷰 · 줄 코멘트 스레드 · 일반 코멘트를 읽기만 한다(답글·해소·머지 입력 없음).
//
// · 머리: `PR #n · <상태>` + GitHub 열기 + 새로고침(C6). 탐색기·소스 제어와 같은 머리 줄(`explorer-section-head`).
// · 상태마다 다른 글(C5) — 「없다」(PR 없음·코멘트 0건) 와 「못 본다」(gh 없음·미인증·실패) 를 가른다.
// · 본문은 `MarkdownView`(C7) — raw HTML 은 글자, 이미지는 대체 글자(원격 src 를 가진 img 없음), 링크는 http·https 만 바깥 열기.
// · 해소된 스레드는 기본 접힘(펼칠 수 있다). 접힘은 메모리(세션 동안).
import { useState } from 'react'
import { PR_COMMENTS_ERROR_LABEL, PR_REVIEW_STATE_LABEL, type PrComment, type PrComments, type PrCommentsResult, type PrThread } from '../../../shared/pr-comments.js'
import { PR_STATE_LABEL, type PrInfo } from '../../../shared/pr-status.js'
import type { PrCommentsApi } from '../hooks/usePrComments.js'
import { linkAction } from '../markdown.js'
import { Codicon } from './ExplorerIcons.js'
import { MarkdownView } from './MarkdownView.js'
import './pr-comments.css'

const NO_KEY = (): void => undefined

function openExternal(url: string): void {
  const action = linkAction(url)
  if (action.kind === 'external') window.open(action.url, '_blank', 'noopener')
}

function timeLabel(at: string | null): string {
  if (at === null) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })
}

/** 몸통 대신 보일 글 — 내용을 그릴 상태면 null. 순수 함수(시험 대상). */
export function prCommentsNotice({ path, state }: Pick<PrCommentsApi, 'path' | 'state'>): string | null {
  if (path === null || state.kind === 'idle') return '열린 worktree 가 없습니다.'
  if (state.kind === 'loading') return 'PR 코멘트를 불러오는 중…'
  return resultNotice(state.result)
}

function resultNotice(result: PrCommentsResult): string | null {
  switch (result.kind) {
    case 'none':
      return '이 브랜치에 PR 이 없습니다.'
    case 'rejected':
      return `조회할 수 없습니다 — ${result.reason}`
    case 'error':
      return result.error === 'failed' ? `${PR_COMMENTS_ERROR_LABEL.failed} — ${result.message}` : PR_COMMENTS_ERROR_LABEL[result.error]
    case 'comments': {
      const { reviews, threads, comments, more } = result.comments
      return reviews.length + threads.length + comments.length + more.reviews + more.threads + more.comments === 0 ? '이 PR 에 리뷰 코멘트가 없습니다.' : null
    }
  }
}

export function PrCommentsView({ api, title }: { api: PrCommentsApi; title: string | null }): React.JSX.Element {
  const { path, state } = api
  const pr = state.kind === 'ready' && state.result.kind === 'comments' ? state.result.pr : null
  const notice = prCommentsNotice(api)
  const busy = state.kind === 'loading' || (state.kind === 'ready' && state.refreshing)
  return (
    <div className="pr-view" data-pr-view="" data-pr-busy={busy ? '' : undefined}>
      <div className="explorer-section-head" data-pr-head="">
        <span className="explorer-section-twistie" />
        <span className="explorer-section-title" title={title ?? undefined} data-pr-title="">
          {pr === null ? 'PR' : `PR #${pr.number} · ${PR_STATE_LABEL[pr.state]}`}
        </span>
        <div className="explorer-toolbar">
          <button type="button" className="explorer-tool" data-pr-open="" title="GitHub 에서 열기" aria-label="GitHub 에서 열기" disabled={pr === null} onClick={() => { if (pr !== null) openExternal(pr.url) }}>
            <Codicon name="link-external" />
          </button>
          <button type="button" className="explorer-tool" data-pr-refresh="" title="새로고침" aria-label="새로고침" disabled={path === null} onClick={api.refresh}>
            <Codicon name="refresh" />
          </button>
        </div>
      </div>
      <div className="explorer-scroll pr-scroll">
        {notice !== null ? (
          <div className="explorer-empty" data-pr-empty="">
            {notice}
          </div>
        ) : state.kind === 'ready' && state.result.kind === 'comments' ? (
          <PrCommentsBody pr={state.result.pr} comments={state.result.comments} />
        ) : null}
      </div>
    </div>
  )
}

function PrCommentsBody({ pr, comments }: { pr: PrInfo; comments: PrComments }): React.JSX.Element {
  return (
    <div className="pr-body" data-pr-body="">
      <Section id="reviews" title="리뷰" count={comments.reviews.length} more={comments.more.reviews} url={pr.url}>
        {comments.reviews.map((review) => (
          <article key={review.id} className="pr-item" data-pr-review={review.state}>
            <ItemHead comment={review} badge={<span className={`pr-badge is-${review.state.toLowerCase()}`} data-pr-review-state="">{PR_REVIEW_STATE_LABEL[review.state]}</span>} />
            {review.body.trim() === '' ? null : <Body source={review.body} />}
          </article>
        ))}
      </Section>
      <Section id="threads" title="줄 코멘트" count={comments.threads.length} more={comments.more.threads} url={pr.url}>
        {comments.threads.map((thread) => <ThreadView key={thread.id} thread={thread} />)}
      </Section>
      <Section id="comments" title="일반 코멘트" count={comments.comments.length} more={comments.more.comments} url={pr.url}>
        {comments.comments.map((comment) => (
          <article key={comment.id} className="pr-item" data-pr-comment="" data-pr-minimized={comment.minimized ? '' : undefined}>
            <ItemHead comment={comment} badge={null} />
            {comment.minimized ? <div className="pr-hidden" data-pr-hidden="">숨긴 코멘트 — GitHub 에서 보기</div> : <Body source={comment.body} />}
          </article>
        ))}
      </Section>
    </div>
  )
}

function Section({ id, title, count, more, url, children }: { id: string; title: string; count: number; more: number; url: string; children: React.ReactNode }): React.JSX.Element | null {
  if (count === 0 && more === 0) return null
  return (
    <section className="pr-section" data-pr-section={id}>
      <div className="pr-section-head">
        <span className="pr-section-title">{title}</span>
        <span className="scm-count" data-pr-count={count}>
          {count}
        </span>
      </div>
      {children}
      {more > 0 ? <MoreLink count={more} url={url} /> : null}
    </section>
  )
}

function MoreLink({ count, url }: { count: number; url: string }): React.JSX.Element {
  return (
    <a className="pr-more" href={url} data-pr-more={count} onClick={(event) => { event.preventDefault(); openExternal(url) }}>
      {count}건 더 — GitHub 에서 보기
    </a>
  )
}

function ItemHead({ comment, badge }: { comment: PrComment; badge: React.ReactNode }): React.JSX.Element {
  return (
    <div className="pr-item-head">
      <span className="pr-author" data-pr-author="">{comment.author ?? 'ghost'}</span>
      {badge}
      <a className="pr-time" href={comment.url} title={comment.at ?? undefined} onClick={(event) => { event.preventDefault(); openExternal(comment.url) }}>
        {timeLabel(comment.at)}
      </a>
    </div>
  )
}

function Body({ source }: { source: string }): React.JSX.Element {
  return <MarkdownView source={source} keyPattern={null} onOpenKey={NO_KEY} className="pr-md" />
}

export function threadLocation(thread: Pick<PrThread, 'path' | 'line'>): string {
  return thread.line === null ? `${thread.path} · 줄 없음` : `${thread.path}:${thread.line}`
}

function ThreadView({ thread }: { thread: PrThread }): React.JSX.Element {
  // 해소된 스레드는 기본 접힘(C6).
  const [open, setOpen] = useState(!thread.resolved)
  const first = thread.comments[0]
  return (
    <article className="pr-thread" data-pr-thread={thread.id} data-pr-resolved={thread.resolved ? '' : undefined} data-pr-outdated={thread.outdated ? '' : undefined} data-pr-open={open ? '' : undefined}>
      <button type="button" className="pr-thread-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={`explorer-twistie is-collapsible${open ? '' : ' is-collapsed'}`}>
          <Codicon name="chevron-down" />
        </span>
        <span className="pr-thread-path" data-pr-thread-location="" title={thread.path}>
          {threadLocation(thread)}
        </span>
        {thread.resolved ? <span className="pr-badge is-resolved" data-pr-badge="resolved">해소됨</span> : null}
        {thread.outdated ? <span className="pr-badge is-outdated" data-pr-badge="outdated">outdated</span> : null}
        <span className="pr-thread-count">{thread.comments.length + thread.more}</span>
      </button>
      {open ? (
        <div className="pr-thread-body">
          {thread.comments.map((comment) => (
            <div key={comment.id} className="pr-item is-reply" data-pr-thread-comment="">
              <ItemHead comment={comment} badge={null} />
              <Body source={comment.body} />
            </div>
          ))}
          {thread.more > 0 && first !== undefined ? <MoreLink count={thread.more} url={first.url} /> : null}
        </div>
      ) : null}
    </article>
  )
}
