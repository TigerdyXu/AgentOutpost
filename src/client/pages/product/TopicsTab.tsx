/**
 * 专题 (M2.3, design §5.6 「产品页『专题』页签只列和该产品有关的」): the topics about the product, each opening its page;
 * a topic is started on its track's page.
 */
import type { ReactNode } from 'react'
import type { Id } from '../../../core/types.ts'
import { call, describeError, usePoll } from '../../api.ts'
import { useShell } from '../../shell/context.ts'
import { TopicList } from '../../ui/TopicList.tsx'

const POLL_MS = 15_000

export function TopicsTab({ productId }: { productId: Id }): ReactNode {
  const { t } = useShell()
  const { data, error } = usePoll(() => call('GET products/:id/topics', { id: productId }), [productId], POLL_MS)
  if (!data) return error ? <p className="op-day-problem" role="alert">{describeError(t, error)}</p> : null
  return data.topics.length ? <TopicList rows={data.topics} /> : <p className="op-day-empty">{t('topic.noneForProduct')}</p>
}
