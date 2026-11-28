/** Line glyphs of the panel (after Lucide, ISC), drawn in the text color around them and hidden from screen readers. */
import type { ReactNode } from 'react'

function Glyph({ size = 18, strokeWidth = 1.8, children }: { size?: number; strokeWidth?: number; children: ReactNode }): ReactNode {
  return <svg className="op-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
}
type Props = { size?: number }

/** 前哨 itself: a telescope (Lucide `telescope`). */
export const TelescopeIcon = ({ size }: Props) => <Glyph size={size}>
  <path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44" />
  <path d="m13.56 11.747 4.332-.924" />
  <path d="m16 21-3.105-6.21" />
  <path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z" />
  <path d="m6.158 8.633 1.114 4.456" />
  <path d="m8 21 3.105-6.21" />
  <circle cx="12" cy="13" r="2" />
</Glyph>

/** 今日哨报: a newspaper. */
export const BriefIcon = ({ size }: Props) => <Glyph size={size}>
  <path d="M4 5h13v14H6a2 2 0 0 1-2-2z" /><path d="M17 9h3v8a2 2 0 0 1-2 2" /><path d="M7 9h7M7 13h7M7 16h4" />
</Glyph>

/** 赛道概览: a table of rows and columns (M2.1). */
export const OverviewIcon = ({ size }: Props) => <Glyph size={size}>
  <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 4v16" />
</Glyph>

/** 运行记录: a pulse line. */
export const RunsIcon = ({ size }: Props) => <Glyph size={size}><path d="M3 12h4l3-7 4 14 3-7h4" /></Glyph>

/** 设置: a gear (Lucide `settings`). */
export const SettingsIcon = ({ size }: Props) => <Glyph size={size}>
  <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
  <circle cx="12" cy="12" r="3" />
</Glyph>

/** 挑产品: a check mark. */
export const CheckIcon = ({ size }: Props) => <Glyph size={size}><path d="M5 12l4 4 10-10" /></Glyph>

/** 候选推荐: a sparkle, for what the AI suggests (Lucide `sparkle`). */
export const SparkleIcon = ({ size }: Props) => <Glyph size={size}>
  <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
</Glyph>

/** A group's fold arrow, pointing down; the stylesheet turns it while the group is folded. */
export const ChevronIcon = ({ size = 12 }: Props) => <Glyph size={size} strokeWidth={2.4}><path d="M6 9l6 6 6-6" /></Glyph>

/** The narrow layout's menu button. */
export const MenuIcon = ({ size }: Props) => <Glyph size={size}><path d="M4 6h16M4 12h16M4 18h16" /></Glyph>
