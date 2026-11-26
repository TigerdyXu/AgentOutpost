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

  it('does not run the name into the company', () => {
    expect(identityKey('AB', 'C')).not.toBe(identityKey('A', 'BC'))
  })
})
