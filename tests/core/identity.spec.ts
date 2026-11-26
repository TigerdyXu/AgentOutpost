import { describe, expect, it } from 'vitest'
import { identityKey } from '../../src/core/identity.ts'

describe('identityKey', () => {
  it('ignores punctuation, so a name with or without an exclamation mark is one product', () => {
    expect(identityKey('千问Go!', '阿里巴巴')).toBe(identityKey('千问Go', '阿里巴巴'))
  })

  it('ignores spaces, so a name with or without a space is one product', () => {
    expect(identityKey('阶跃 Amoo', '阶跃星辰')).toBe(identityKey('阶跃Amoo', '阶跃星辰'))
  })

  it('ignores full-width against half-width forms, case and hyphens', () => {
    expect(identityKey('ＧＰＴ－4o', 'OpenAI')).toBe(identityKey('gpt4o', 'openai'))
  })

  it('tells the same name at different companies apart', () => {
    expect(identityKey('Muse', 'Meta')).not.toBe(identityKey('Muse', 'Muse AI'))
  })

  it('drops only spaces and punctuation, not symbols, so 「Kimi+」 is not 「Kimi」', () => {
    // The design says 「去掉空格和标点」: a symbol (+, ★, ©…) is part of the name.
    expect(identityKey('Kimi+', '月之暗面')).not.toBe(identityKey('Kimi', '月之暗面'))
    expect(identityKey('Kimi +', '月之暗面')).toBe(identityKey('Kimi+', '月之暗面')) // the space still goes
    expect(identityKey('★', 'X')).not.toBe(identityKey('☆', 'X'))
    expect(identityKey('X', '★')).not.toBe(identityKey('X', '☆'))
    expect(identityKey(' ★ ', 'X')).toBe(identityKey('★', 'X'))
    expect(identityKey('Ｘ', '★')).toBe(identityKey('x', '★')) // still unified
  })

  it('keeps names and companies made only of punctuation apart, by what they are', () => {
    // Dropping the punctuation would leave nothing, and every such name would match every other.
    expect(identityKey('!!!', 'X')).not.toBe(identityKey('???', 'X'))
    expect(identityKey('X', '—')).not.toBe(identityKey('X', '…'))
    expect(identityKey(' ！！ ', 'X')).toBe(identityKey('!!', 'X')) // trimmed, and unified (NFKC)
  })

  it('does not run the name into the company', () => {
    expect(identityKey('AB', 'C')).not.toBe(identityKey('A', 'BC'))
  })
})
