/** Small labels on findings, cards and sources, worded as the design says (§5.2, §5.4, §8). */
import type { ReactNode } from 'react'
import { useShell } from '../shell/context.ts'

export const TAG_KINDS = ['official', 'inference', 'ai', 'fresh', 'unconfirmed', 'unopened', 'late', 'major', 'notable', 'promoted', 'unchecked', 'today'] as const
/**
 * - `official` 官方: the source is the product's own (one is enough for what it says about itself).
 * - `inference` 推论 / `ai` AI 归纳: the AI's own reasoning or summary, never mixed with facts.
 * - `fresh` 今天改过: a card changed today.
 * - `unconfirmed` 待确认: not enough sources yet. `unopened` 原文打不开: neither fetch nor browser could open it.
 * - `late` 迟到: added to the brief after it was written. `promoted` 已证实: unconfirmed before, verified that day.
 * - `major` 重要 / `notable` 值得留意: how much a finding matters.
 * - `unchecked` AI 整理 · 未核查: put together by the AI and checked by nobody (the key facts of a dossier).
 * - `today` 今天: a cell of a track's 对比矩阵 whose card changed today (M2.1).
 */
export type TagKind = typeof TAG_KINDS[number]

export function Tag({ kind }: { kind: TagKind }): ReactNode {
  const { t } = useShell()
  return <span className="op-tag" data-kind={kind}>{t(`tag.${kind}`)}</span>
}
