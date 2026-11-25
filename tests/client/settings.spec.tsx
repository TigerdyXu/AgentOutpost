// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Settings, SettingsForm, usePageForm } from '../../src/client/pages/Settings.tsx'
import { all, click, mount, settle, state, t, text, type, unmount } from '../fixtures/client.tsx'

afterEach(() => { unmount(); vi.unstubAllGlobals() })

// ---- a configuration form as DSH hands it to a page ----

const SAVED = {
  runTime: '08:00', maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30,
  prices: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 },
} as Record<string, unknown>

/** A form over `value`; `mutate` answers `accepted`, and is what the tests look at. */
function formOf(value: Record<string, unknown> = SAVED, extra: Partial<ConfigPageForm['state']> = {}, accepted = true) {
  const mutate = vi.fn<ConfigPageForm['mutate']>(async () => accepted)
  const form: ConfigPageForm = { state: { status: 'ready', value, base: undefined, user: undefined, revision: 7, writable: true, ...extra }, mutate }
  return { form, mutate }
}

/** The input of the field labelled `label`. */
const field = (label: string) => {
  const found = all<HTMLLabelElement>('label').find(item => item.textContent?.trim() === label)
  if (!found?.control) throw new Error(`No field labelled ${label}`)
  return found.control as HTMLInputElement
}
const fieldError = (label: string) => field(label).closest('.op-set-field')?.querySelector('.op-set-error')?.textContent ?? null
const saveButton = () => all<HTMLButtonElement>('button').find(button => button.textContent === '保存')!
const revertButton = () => all<HTMLButtonElement>('button').find(button => button.textContent === '还原')!

describe('the browser fallback', () => {
  it('explains how to enable the browser fallback when it is off', async () => {
    await mount(<Settings />, { state: state({ browserAvailable: false }) })
    expect(text()).toContain('没开浏览器兜底')
    expect(document.querySelector('.op-browser')?.textContent).toBe(
      '没开浏览器兜底：公众号、小红书、知乎等页面打不开，相关消息会一直是『待确认』。到『插件』页启用 dsh-browser-use 和 Playwright 浏览器两项后重启。')
    expect(document.querySelector('.op-browser')?.getAttribute('data-on')).toBeNull()
    expect(text()).not.toContain('浏览器兜底已开启')
  })

  it('shows no browser notice when it is on', async () => {
    await mount(<Settings />, { state: state({ browserAvailable: true }) })
    expect(text()).not.toContain('没开浏览器兜底')
    expect(text()).not.toContain('到『插件』页启用')
    expect(document.querySelector('.op-browser')?.textContent).toBe('浏览器兜底已开启')
    expect(document.querySelector('.op-browser')?.getAttribute('data-on')).toBe('')
  })

  it('says nothing about the browser until the state is known', async () => {
    await mount(<Settings />, { state: undefined })
    expect(document.querySelector('.op-browser')).toBeNull()
    expect(text()).not.toContain('没开浏览器兜底')
  })
})

describe('the form', () => {
  it('shows the configured values, the data directory only as text, and labels the prices', async () => {
    const { form } = formOf({ ...SAVED, model: { provider: 'deepseek', model: 'deepseek-flash' } })
    await mount(<Settings />, { state: state(), configForm: form })
    expect(document.querySelector('h1')?.textContent).toBe('设置')
    expect(field('每天几点跑').value).toBe('08:00')
    expect(field('同时跑几个产品').value).toBe('3')
    expect(field('每日总预算（元）').value).toBe('20')
    expect(field('单个会话最长（分钟）').value).toBe('30')
    expect(field('模型厂商').value).toBe('deepseek')
    expect(field('模型名').value).toBe('deepseek-flash')
    expect([field('输入（未命中缓存）').value, field('输出').value, field('输入（命中缓存）').value]).toEqual(['2', '8', '0.04'])
    // The prices are per million tokens and only for the estimate; the page says both.
    expect(all('.op-unit').map(unit => unit.textContent)).toEqual(['元 / 百万 token', '元 / 百万 token', '元 / 百万 token'])
    expect(document.querySelector('.op-set-tag')?.textContent).toBe('估算用')
    // The data directory is a path to read, not a field to edit.
    expect(document.querySelector('.op-datadir')?.textContent).toBe('/Users/tiger/Projects/AgentOutpost-data')
    expect(all<HTMLInputElement>('input').map(input => input.value)).not.toContain('/Users/tiger/Projects/AgentOutpost-data')
    expect(all('label').map(label => label.textContent)).not.toContain('数据目录')
    // Nothing changed: nothing to save or to revert.
    expect(saveButton().disabled).toBe(true)
    expect(revertButton().disabled).toBe(true)
  })

  it('says what an empty model means', async () => {
    const { form } = formOf()
    await mount(<Settings />, { state: state(), configForm: form })
    expect(field('模型厂商').value).toBe('')
    expect(field('模型名').value).toBe('')
    expect(text()).toContain('用 DeepSeek Harness 的默认模型')
  })

  it('saves what changed in one write, fenced by the revision it read', async () => {
    const { form, mutate } = formOf()
    await mount(<Settings />, { state: state(), configForm: form })
    await type(field('每天几点跑'), '09:30')
    await type(field('同时跑几个产品'), '5')
    await type(field('每日总预算（元）'), '12.5')
    await type(field('单个会话最长（分钟）'), '45')
    expect(saveButton().disabled).toBe(false)
    expect(revertButton().disabled).toBe(false)
    await click(saveButton())
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['runTime'], value: '09:30' },
      { op: 'set', path: ['maxParallel'], value: 5 },
      { op: 'set', path: ['dailyBudgetYuan'], value: 12.5 },
      { op: 'set', path: ['sessionTimeoutMin'], value: 45 },
    ], 7)
    expect(document.querySelector('.op-save-status')?.textContent).toBe('已保存')
    expect(saveButton().disabled).toBe(true)
  })

  it('writes the three prices together when one changed, and only then', async () => {
    const { form, mutate } = formOf()
    await mount(<Settings />, { state: state(), configForm: form })
    await type(field('输出'), '9')
    await click(saveButton())
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['prices'], value: { inputPerMTok: 2, outputPerMTok: 9, cacheReadPerMTok: 0.04 } }], 7)
  })

  it('writes the model as a provider and a name, and clears it when both are emptied', async () => {
    const { form, mutate } = formOf()
    await mount(<Settings />, { state: state(), configForm: form })
    await type(field('模型厂商'), 'deepseek')
    // Half a model is no model: it is not written.
    expect(fieldError('模型名')).toBe('厂商和模型名要一起填，或者都留空')
    expect(saveButton().disabled).toBe(true)
    await type(field('模型名'), 'deepseek-pro')
    expect(fieldError('模型名')).toBeNull()
    await click(saveButton())
    expect(mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['model'], value: { provider: 'deepseek', model: 'deepseek-pro' } }], 7)
    unmount()

    // A model that was set and is emptied goes back to DSH's default: the override is removed, not written as an empty one.
    const set = formOf({ ...SAVED, model: { provider: 'deepseek', model: 'deepseek-flash' } })
    await mount(<Settings />, { state: state(), configForm: set.form })
    await type(field('模型厂商'), '')
    await type(field('模型名'), '')
    await click(saveButton())
    expect(set.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['model'] }], 7)
  })

  it('accepts a run time written HH:MM and refuses anything else', async () => {
    const { form, mutate } = formOf()
    await mount(<Settings />, { state: state(), configForm: form })
    for (const bad of ['8:00', '24:00', '08:60', '0800', '早上八点', '']) {
      await type(field('每天几点跑'), bad)
      expect(fieldError('每天几点跑'), bad).toBe('写成 时:分，比如 08:00')
      expect(saveButton().disabled, bad).toBe(true)
    }
    for (const good of ['00:00', '07:05', '23:59']) {
      await type(field('每天几点跑'), good)
      expect(fieldError('每天几点跑'), good).toBeNull()
    }
    await type(field('每天几点跑'), '23:59')
    await click(saveButton())
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['runTime'], value: '23:59' }], 7)
  })

  it('keeps 同时跑几个产品 a whole number from 1 to 8, and the other numbers in range', async () => {
    const { form } = formOf()
    await mount(<Settings />, { state: state(), configForm: form })
    for (const bad of ['0', '9', '2.5', '', '三']) {
      await type(field('同时跑几个产品'), bad)
      expect(fieldError('同时跑几个产品'), bad).toBe('填 1 到 8 的整数')
      expect(saveButton().disabled, bad).toBe(true)
    }
    for (const good of ['1', '8']) {
      await type(field('同时跑几个产品'), good)
      expect(fieldError('同时跑几个产品'), good).toBeNull()
    }
    await type(field('每日总预算（元）'), '-1')
    expect(fieldError('每日总预算（元）')).toBe('填 0 或更大的数')
    await type(field('每日总预算（元）'), '0')
    expect(fieldError('每日总预算（元）')).toBeNull()
    await type(field('单个会话最长（分钟）'), '0')
    expect(fieldError('单个会话最长（分钟）')).toBe('填 1 或更大的数')
    await type(field('单个会话最长（分钟）'), '1')
    expect(fieldError('单个会话最长（分钟）')).toBeNull()
    await type(field('输入（命中缓存）'), 'abc')
    expect(fieldError('输入（命中缓存）')).toBe('填 0 或更大的数')
  })

  it('puts the saved values back on 还原', async () => {
    const { form, mutate } = formOf()
    await mount(<Settings />, { state: state(), configForm: form })
    await type(field('每天几点跑'), '09:30')
    await click(revertButton())
    expect(field('每天几点跑').value).toBe('08:00')
    expect(saveButton().disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('keeps the edits and says so when DSH refuses the write', async () => {
    const { form, mutate } = formOf(SAVED, {}, false)
    await mount(<Settings />, { state: state(), configForm: form })
    await type(field('每天几点跑'), '09:30')
    await click(saveButton())
    expect(document.querySelector('.op-save-problem')?.textContent).toBe('没有保存：设置刚在别处改过，或有一项没通过检查。已载入最新的值，你的改动还在，确认后再保存一次。')
    expect(document.querySelector('.op-save-problem')?.getAttribute('role')).toBe('alert')
    expect(field('每天几点跑').value).toBe('09:30')
    expect(saveButton().disabled).toBe(false)
    // The next try is fenced by what DSH holds now, not by the revision that was just refused.
    await click(saveButton())
    expect(mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['runTime'], value: '09:30' }], undefined)
  })

  it('says what went wrong when the write itself fails', async () => {
    const { form, mutate } = formOf()
    mutate.mockRejectedValueOnce(new Error('connection lost'))
    await mount(<Settings />, { state: state(), configForm: form })
    await type(field('每天几点跑'), '09:30')
    await click(saveButton())
    expect(document.querySelector('.op-save-problem')?.textContent).toBe('没有保存：connection lost')
    expect(field('每天几点跑').value).toBe('09:30')
  })
})

describe('when the form cannot be written', () => {
  it('shows the values read-only with a note when DSH has no configuration forms', async () => {
    await mount(<Settings />, { state: state({ runTime: '08:30' }), configForm: undefined })
    expect(document.querySelector('.op-settings-note')?.textContent).toBe('在『插件』页修改')
    // Nothing to type into; what is known is shown (the run time comes with the state).
    expect(all('input')).toHaveLength(0)
    expect(all('button').map(button => button.textContent)).not.toContain('保存')
    expect(document.querySelector('.op-setting[data-key="runTime"] .op-setting-value')?.textContent).toBe('08:30')
    // The browser fallback still says where it stands.
    expect(document.querySelector('.op-browser')).not.toBeNull()
  })

  it('shows every value read-only when the host document does not accept writes', async () => {
    const { form } = formOf({ ...SAVED, model: { provider: 'deepseek', model: 'deepseek-flash' } }, { writable: false })
    await mount(<Settings />, { state: state(), configForm: form })
    expect(document.querySelector('.op-settings-note')?.textContent).toBe('在『插件』页修改')
    expect(all('input')).toHaveLength(0)
    const shown = Object.fromEntries(all('.op-setting').map(row => [row.getAttribute('data-key'), row.querySelector('.op-setting-value')?.textContent]))
    expect(shown).toMatchObject({
      runTime: '08:00', maxParallel: '3', dailyBudgetYuan: '¥20', sessionTimeoutMin: '30 分钟', model: 'deepseek / deepseek-flash',
      inputPerMTok: '2 元 / 百万 token', outputPerMTok: '8 元 / 百万 token', cacheReadPerMTok: '0.04 元 / 百万 token',
    })
    expect(document.querySelector('.op-datadir')?.textContent).toBe('/Users/tiger/Projects/AgentOutpost-data')
  })

  it('says it is reading while DSH has not answered, and when the plugin has no settings to show', async () => {
    await mount(<Settings />, { state: state(), configForm: formOf(undefined as never, { status: 'loading', value: undefined, revision: undefined }).form })
    expect(text()).toContain('正在读取设置…')
    expect(all('input')).toHaveLength(0)
    unmount()
    await mount(<Settings />, { state: state(), configForm: formOf(undefined as never, { status: 'unavailable', value: undefined, revision: undefined }).form })
    expect(document.querySelector('.op-settings-note')?.textContent).toBe('在『插件』页修改')
    expect(all('input')).toHaveLength(0)
  })

  it('shows a model that is not set as DSH’s default', async () => {
    const { form } = formOf(SAVED, { writable: false })
    await mount(<Settings />, { state: state(), configForm: form })
    expect(document.querySelector('.op-setting[data-key="model"] .op-setting-value')?.textContent).toBe('用 DeepSeek Harness 的默认模型')
  })
})

describe('as the Plugin Manager’s page', () => {
  it('renders the same form without the panel around it', async () => {
    const { form, mutate } = formOf()
    // The Plugin Manager is not inside the panel's shell: the form needs only its words and DSH's form.
    await mount(<SettingsForm t={t} form={form} known={{ dataDir: '/data/outpost' }} />)
    expect(field('每天几点跑').value).toBe('08:00')
    expect(document.querySelector('.op-datadir')?.textContent).toBe('/data/outpost')
    expect(document.querySelector('.op-browser')).toBeNull()
    await type(field('同时跑几个产品'), '4')
    await click(saveButton())
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['maxParallel'], value: 4 }], 7)
  })

  it('follows DSH’s form as it changes (usePageForm)', async () => {
    let snapshot = { status: 'ready' as const, value: SAVED, base: undefined, user: undefined, revision: 7, writable: true }
    const listeners = new Set<() => void>()
    const store = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      mutate: vi.fn(async () => true),
      set: vi.fn(), unset: vi.fn(),
    }
    function Page() {
      const form = usePageForm(store as never)
      return <SettingsForm t={t} form={form} />
    }
    await mount(<Page />)
    expect(field('每天几点跑').value).toBe('08:00')
    // Someone else changed it: the saved value follows, since nothing here was edited.
    snapshot = { ...snapshot, value: { ...SAVED, runTime: '07:15' }, revision: 8 }
    await act(async () => { for (const listener of [...listeners]) listener() })
    await settle()
    expect(field('每天几点跑').value).toBe('07:15')
    // A form that DSH does not have is no form.
    unmount()
    function Without() { return <SettingsForm t={t} form={usePageForm(undefined)} /> }
    await mount(<Without />)
    expect(document.querySelector('.op-settings-note')?.textContent).toBe('在『插件』页修改')
  })
})
