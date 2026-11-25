/** A source as a small pill under a finding or a card: `[n]` publisher · date, marked 官方 or 原文打不开, opening the page. */
import type { ReactNode } from 'react'
import type { Source } from '../../core/types.ts'
import { Tag } from './Tag.tsx'

/** `MM-DD` for a date of this year, else `YYYY-MM-DD`; null for none. */
export function shortDate(date: string | null, now = new Date()): string | null {
  if (!date) return null
  const day = date.slice(0, 10)
  return day.startsWith(`${now.getFullYear()}-`) ? day.slice(5) : day
}

export function SourceChip({ source, n }: { source: Source; n?: number }): ReactNode {
  const date = shortDate(source.publishedAt)
  return <a className="op-source" href={source.url} target="_blank" rel="noopener noreferrer" title={source.title}>
    {n !== undefined && <span className="op-source-n">[{n}]</span>}
    <span className="op-source-name">{source.publisher || source.title}{date && ` · ${date}`}</span>
    {source.isOfficial && <Tag kind="official" />}
    {source.openedVia === 'unopened' && <Tag kind="unopened" />}
  </a>
}
