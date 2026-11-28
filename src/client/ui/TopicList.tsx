/**
 * 专题 in a list (M2.3, mockup 5's 「专题」 block): each its question, then 「5 个产品 · 11-22 首版 · 每周更新 · 上一版：改了
 * 2 处」, or how its round stands (正在深挖, 没出版：why); choosing one opens its page. The track page lists a track's, the
 * product page's 专题 tab those about the product.
 */
import type { ReactNode } from 'react'
import type { TopicRow } from '../../host/api.ts'
import type { T } from '../locales.ts'
import { useShell } from '../shell/context.ts'
import { shortDay } from '../time.ts'
import { counted, told } from '../words.ts'

/** What a topic's line under its question says, in the reader's language. */
export function topicMeta(t: T, row: TopicRow): string {
  const parts = [counted(t, 'topic.products', { count: row.productNames.length })]
  if (row.researching) parts.push(t('topic.researching'))
  else if (row.first) parts.push(t('topic.first', { date: shortDay(row.first) ?? '' }))
  else if (row.problem) parts.push(t('topic.noVersion', { reason: told(t, row.problem) }))
  else parts.push(t('topic.noneYet'))
  if (!row.researching && row.gaveUp) parts.push(t('topic.gaveUpShort'))
  parts.push(t(row.topic.cadence === 'weekly' ? 'topic.weekly' : 'topic.once'))
  if (row.versions > 1 && row.lastNote) parts.push(t('topic.lastNote', { note: row.lastNote }))
  return parts.join(' · ')
}

export function TopicList({ rows }: { rows: TopicRow[] }): ReactNode {
  const { t, navigate } = useShell()
  return <ul className="op-topic-list">
    {rows.map(row => <li key={row.topic.id}>
      <button type="button" className="op-topic-row" onClick={() => { navigate({ page: 'topic', topicId: row.topic.id }) }}>
        <span className="op-topic-q">{row.topic.question}</span>
        <span className="op-topic-meta">{topicMeta(t, row)}</span>
      </button>
    </li>)}
  </ul>
}
