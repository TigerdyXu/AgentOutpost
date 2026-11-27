// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ModelsView } from '../../src/host/api.ts'
import { Settings, SettingsForm, usePageForm } from '../../src/client/pages/Settings.tsx'
import { all, click, fail, mount, settle, state, stubApi, t, text, type, unmount } from '../fixtures/client.tsx'

/** What DSH offers: DeepSeek (metered) and a local Ollama, DeepSeek being its default. */
const MODELS: ModelsView = {
  groups: [
    { provider: 'deepseek-official', name: 'DeepSeek', billing: 'metered', error: null, models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }, { id: 'deepseek-pro', name: 'deepseek-pro' }] },
    { provider: 'ollama', name: 'Ollama (local)', billing: 'local', error: null, models: [{ id: 'qwen3:8b', name: 'qwen3:8b' }, { id: 'llama3.2', name: 'llama3.2' }] },
  ],
  defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
}
/** A model as a select's value: the provider and the model, apart by U+0000. */
const ref = (provider: string, model: string) => `${provider}\u0000${model}`

beforeEach(() => { stubApi({ 'GET models': MODELS }) })
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
/** The drop-down labelled `label`. */
const picker = (label: string) => {
  const control = field(label) as unknown as HTMLSelectElement
  if (control.tagName !== 'SELECT') throw new Error(`${label} is not a drop-down`)
  return control
}
const ROLES = ['调研（推荐·建档·日更）', '核查', '写哨报总结', '追问'] as const
/** What the reader picks from, in order: each option's text, and for a group its label first (`group › option`). */
const offered = (select: HTMLSelectElement) => [...select.children].flatMap(child => child instanceof HTMLOptGroupElement
  ? [...child.querySelectorAll('option')].map(option => `${child.label} › ${option.textContent}`) : [(child as HTMLOptionElement).textContent])
/** Picks `value` in `label`'s drop-down as the reader would (React sees a change event). */
async function choose(label: string, value: string) {
  const select = picker(label)
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
}
const fieldError = (label: string) => field(label).closest('.op-set-field')?.querySelector('.op-set-error')?.textContent ?? null
const saveButton = () => all<HTMLButtonElement>('button').find(button => button.textContent === '保存')!
const revertButton = () => all<HTMLButtonElement>('button').find(button => button.textContent === '还原')!

describe('the browser fallback', () => {
  it('explains how to enable the browser fallback when it is off', async () => {
    await mount(<Settings />, { state: state({ browserAvailable: false }) })
    expect(text()).toContain('没开浏览器兜底')
    // The browser comes with the research preset (cordis.patch.yml), on: it is off here because the profile overrides the
    // preset without it (missing packages make research run on the preset without a browser: that is the next message).
    expect(document.querySelector('.op-browser')?.textContent).toBe(
      '没开浏览器兜底：公众号、小红书、知乎等页面打不开，相关消息会一直是『待确认』。浏览器在前哨的调研预设里，默认是开的；profile 里覆盖了这个预设、去掉了浏览器时就会这样，删掉那条覆盖后重启即可打开。')
    expect(document.querySelector('.op-browser')?.getAttribute('data-on')).toBeNull()
    expect(text()).not.toContain('浏览器兜底已开启')
    expect(document.querySelector('.op-browser code')).toBeNull()
  })

  // M1.4: a plain `dsh plugin add` of Outpost lacks the two browser plugins; research runs on the preset without a browser.
  it('says the browser plugins are not installed, that research still runs, and gives the command that installs them', async () => {
    await mount(<Settings />, { state: state({ browserAvailable: false, browserMissing: true }) })
    const notice = document.querySelector('.op-browser')
    const COMMAND = 'curl -fsSL https://raw.githubusercontent.com/TigerdyXu/AgentOutpost/master/install.sh | sh'
    expect(notice?.textContent).toBe(
      '浏览器兜底没开：带浏览器的调研预设加载不了，多半是桌面版里没装浏览器的两个插件。公众号、小红书、知乎等页面打不开，相关消息会一直是『待确认』；调研照常跑。'
      + '没装插件的话，先退出桌面版，再在终端运行前哨的一行安装命令，它会装上这两个插件，并把前哨更新到 GitHub 上的最新版：' + COMMAND)
    // The command on a line of its own, whole: one click selects it all for copying.
    const code = notice?.querySelector('code')
    expect(code?.textContent).toBe(COMMAND)
    expect(code?.className).toBe('op-browser-command')
    expect(notice?.getAttribute('role')).toBe('status')
    expect(notice?.getAttribute('data-on')).toBeNull()
    expect(notice?.getAttribute('data-broken')).toBeNull()
    expect(text()).not.toContain('删掉那条覆盖')
    expect(text()).not.toContain('调研跑不了')
  })

  it('says the browser is on when research runs without its own but the profile\'s browser reaches it', async () => {
    // The profile's Playwright clashed with the preset's own: research runs on the preset without a browser, with the profile's.
    await mount(<Settings />, { state: state({ browserAvailable: true, browserMissing: true }) })
    expect(document.querySelector('.op-browser')?.textContent).toBe('浏览器兜底已开启')
    expect(document.querySelector('.op-browser')?.getAttribute('data-on')).toBe('')
  })

  it('says research cannot run when neither research preset loads, instead of the browser notice', async () => {
    await mount(<Settings />, { state: state({ browserAvailable: false, browserMissing: false, researchBroken: true }) })
    const notice = document.querySelector('.op-browser')
    // No longer the browser packages' fault (research runs without them): what stops, and where the details are.
    expect(notice?.textContent).toBe('调研跑不了：前哨的调研预设加载不了，推荐、建档、核查和日更都会失败。详情在桌面版的日志里。')
    expect(notice?.getAttribute('role')).toBe('alert')
    expect(notice?.getAttribute('data-broken')).toBe('')
    expect(notice?.getAttribute('data-on')).toBeNull()
    expect(text()).not.toContain('没开浏览器兜底')
    expect(text()).not.toContain('浏览器兜底已开启')
  })

  it('shows no browser notice when it is on', async () => {
    await mount(<Settings />, { state: state({ browserAvailable: true }) })
    expect(text()).not.toContain('没开浏览器兜底')
    expect(text()).not.toContain('删掉那条覆盖')
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
    const { form } = formOf({ ...SAVED, model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    await mount(<Settings />, { state: state(), configForm: form })
    expect(document.querySelector('h1')?.textContent).toBe('设置')
    expect(field('每天几点跑').value).toBe('08:00')
    // A change of the run time is picked up by the scheduler within a minute; the field says so.
    expect(field('每天几点跑').closest('.op-set-field')?.querySelector('.op-set-hint')?.textContent).toContain('改动一分钟内生效')
    expect(field('同时跑几个产品').value).toBe('3')
    expect(field('每日总预算（元）').value).toBe('20')
    expect(field('单个会话最长（分钟）').value).toBe('30')
    expect(picker('调研（推荐·建档·日更）').value).toBe(ref('deepseek-official', 'deepseek-flash'))
    expect(['核查', '写哨报总结', '追问'].map(label => picker(label).value)).toEqual(['', '', ''])
    expect([field('输入（未命中缓存）').value, field('输出').value, field('输入（命中缓存）').value]).toEqual(['2', '8', '0.04'])
    // The prices are per million tokens and only for the estimate; the page says both.
    expect(all('.op-unit').map(unit => unit.textContent)).toEqual(['元 / 百万 token', '元 / 百万 token', '元 / 百万 token'])
    expect(document.querySelector('.op-set-tag')?.textContent).toBe('估算用')
    // The data directory is a path to read, not a field to edit.
    expect(document.querySelector('.op-datadir')?.textContent).toBe('/Users/tiger/Projects/AgentOutpost-data')
    expect(all<HTMLInputElement>('input').map(input => input.value)).not.toContain('/Users/tiger/Projects/AgentOutpost-data')
    expect(all('label').map(label => label.textContent)).not.toContain('数据目录')
    // Where it is by default, and how to move it: the profile names no dataDir unless the user (or install.sh) wrote one.
    expect(document.querySelector('.op-datadir')?.closest('.op-set-section')?.querySelector('.op-set-hint')?.textContent).toBe(
      '数据库、产品图标和调研会话的工作文件都放在这里，默认是 ~/.outpost/data。要改用别的目录，在 profile 的 cordis.patch.yml 里给 id 为 outpost 的条目写上 dataDir（没有这个条目就加一个），然后重启。数据不会自动搬过去，要沿用就先把旧目录整个拷过去。')
    // Nothing changed: nothing to save or to revert.
    expect(saveButton().disabled).toBe(true)
    expect(revertButton().disabled).toBe(true)
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

describe('the models', () => {
  const [RESEARCH, VERIFY, BRIEF, FOLLOWUP] = ROLES

  it('offers the models DSH can use, grouped by provider', async () => {
    await mount(<Settings />, { state: state(), configForm: formOf().form })
    const research = picker(RESEARCH)
    // DSH's own names for the providers are the group titles, and every model names its source too (a closed drop-down shows
    // only the choice); the default model comes first, and only for research.
    expect(offered(research)).toEqual([
      'DeepSeek Harness 的默认模型（DeepSeek · deepseek-flash）',
      'DeepSeek › DeepSeek · deepseek-flash', 'DeepSeek › DeepSeek · deepseek-pro',
      'Ollama (local) › Ollama (local) · qwen3:8b', 'Ollama (local) › Ollama (local) · llama3.2',
    ])
    expect([...research.querySelectorAll('optgroup')].map(group => group.label)).toEqual(['DeepSeek', 'Ollama (local)'])
    expect(research.options[0]!.value).toBe('')
    for (const label of [VERIFY, BRIEF, FOLLOWUP]) {
      const select = picker(label)
      expect(select.options[0]!.textContent).toBe('跟调研一样（DeepSeek · deepseek-flash）')
      expect(select.options[0]!.value).toBe('')
      expect(offered(select).slice(1)).toEqual(offered(research).slice(1))
      expect(select.value).toBe('')
    }
    // The values carry the provider and the model apart by U+0000, so no model id can pass for the pair.
    expect([...research.options].map(option => option.value)).toEqual(['', ref('deepseek-official', 'deepseek-flash'), ref('deepseek-official', 'deepseek-pro'), ref('ollama', 'qwen3:8b'), ref('ollama', 'llama3.2')])
    // The drop-downs are labelled, and the four rows sit under one heading.
    expect(document.querySelector('.op-set-title')?.textContent).toBe('每天的运行')
    expect(all('.op-set-title').map(title => title.textContent)).toContain('模型')
  })

  it('shows the models the configuration holds', async () => {
    const { form } = formOf({ ...SAVED, model: { provider: 'deepseek-official', model: 'deepseek-pro' }, briefModel: { provider: 'ollama', model: 'llama3.2' } })
    await mount(<Settings />, { state: state(), configForm: form })
    expect([RESEARCH, VERIFY, BRIEF, FOLLOWUP].map(label => picker(label).value)).toEqual([ref('deepseek-official', 'deepseek-pro'), '', ref('ollama', 'llama3.2'), ''])
    // What the reader sees closed names the source: which provider, so how it is billed, and which model.
    expect([RESEARCH, BRIEF].map(label => picker(label).selectedOptions[0]!.textContent)).toEqual(['DeepSeek · deepseek-pro', 'Ollama (local) · llama3.2'])
    // A choice too long for the box is cut short there: its whole is the tooltip.
    expect([RESEARCH, VERIFY].map(label => picker(label).title)).toEqual(['DeepSeek · deepseek-pro', '跟调研一样（DeepSeek · deepseek-pro）'])
    // 「跟调研一样」 says what research is on, and follows what is picked for research before it is saved.
    expect(picker(VERIFY).selectedOptions[0]!.textContent).toBe('跟调研一样（DeepSeek · deepseek-pro）')
    await choose(RESEARCH, ref('ollama', 'qwen3:8b'))
    expect([VERIFY, BRIEF, FOLLOWUP].map(label => picker(label).options[0]!.textContent)).toEqual(Array(3).fill('跟调研一样（Ollama (local) · qwen3:8b）'))
    // Research's own first choice is DSH's default model, whatever research is on now.
    expect(picker(RESEARCH).options[0]!.textContent).toBe('DeepSeek Harness 的默认模型（DeepSeek · deepseek-flash）')
  })

  it('says what the default choices come to, and only when it can tell', async () => {
    // DSH's default model is one the list does not name (its provider is not listed): the ids stand in for the names.
    stubApi({ 'GET models': { ...MODELS, defaultModel: { provider: 'lmstudio', model: 'gemma-3' } } })
    await mount(<Settings />, { state: state(), configForm: formOf().form })
    expect(picker(RESEARCH).options[0]!.textContent).toBe('DeepSeek Harness 的默认模型（lmstudio · gemma-3）')
    expect(picker(VERIFY).options[0]!.textContent).toBe('跟调研一样（lmstudio · gemma-3）')
    unmount()
    // DSH cannot say its default: the plain phrases.
    stubApi({ 'GET models': { ...MODELS, defaultModel: null } })
    await mount(<Settings />, { state: state(), configForm: formOf().form })
    expect([RESEARCH, VERIFY, BRIEF, FOLLOWUP].map(label => picker(label).options[0]!.textContent)).toEqual(['DeepSeek Harness 的默认模型', '跟调研一样', '跟调研一样', '跟调研一样'])
    unmount()
    // ... but a research model of its own is named even then, for the three that follow it.
    await mount(<Settings />, { state: state(), configForm: formOf({ ...SAVED, model: { provider: 'ollama', model: 'qwen3:8b' } }).form })
    expect(picker(VERIFY).options[0]!.textContent).toBe('跟调研一样（Ollama (local) · qwen3:8b）')
  })

  it('saves a role’s model and unsets it when set back to follow research', async () => {
    const { form, mutate } = formOf()
    await mount(<Settings />, { state: state(), configForm: form })
    expect(saveButton().disabled).toBe(true)
    await choose(VERIFY, ref('ollama', 'qwen3:8b'))
    expect(saveButton().disabled).toBe(false)
    await choose(FOLLOWUP, ref('deepseek-official', 'deepseek-pro'))
    await choose(RESEARCH, ref('deepseek-official', 'deepseek-flash'))
    await click(saveButton())
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['model'], value: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      { op: 'set', path: ['verifyModel'], value: { provider: 'ollama', model: 'qwen3:8b' } },
      { op: 'set', path: ['followupModel'], value: { provider: 'deepseek-official', model: 'deepseek-pro' } },
    ], 7)
    expect(document.querySelector('.op-save-status')?.textContent).toBe('已保存')
    unmount()

    // Back to 「跟调研一样」 removes the field (nothing is written as an empty model); research on DSH's default removes `model`.
    const set = formOf({ ...SAVED, model: { provider: 'deepseek-official', model: 'deepseek-pro' }, verifyModel: { provider: 'ollama', model: 'qwen3:8b' } })
    await mount(<Settings />, { state: state(), configForm: set.form })
    await choose(VERIFY, '')
    await click(saveButton())
    expect(set.mutate).toHaveBeenLastCalledWith([{ op: 'unset', path: ['verifyModel'] }], 7)
    unmount()
    const other = formOf({ ...SAVED, model: { provider: 'deepseek-official', model: 'deepseek-pro' } })
    await mount(<Settings />, { state: state(), configForm: other.form })
    await choose(RESEARCH, '')
    await click(saveButton())
    expect(other.mutate).toHaveBeenLastCalledWith([{ op: 'unset', path: ['model'] }], 7)
  })

  it('writes nothing when a choice is put back where it was', async () => {
    const { form, mutate } = formOf({ ...SAVED, followupModel: { provider: 'ollama', model: 'qwen3:8b' } })
    await mount(<Settings />, { state: state(), configForm: form })
    await choose(FOLLOWUP, '')
    expect(saveButton().disabled).toBe(false)
    await choose(FOLLOWUP, ref('ollama', 'qwen3:8b'))
    expect(saveButton().disabled).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('keeps a saved model that is no longer offered and marks it', async () => {
    const { form, mutate } = formOf({
      ...SAVED,
      followupModel: { provider: 'ollama', model: 'qwen2:7b' },
      briefModel: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    })
    await mount(<Settings />, { state: state(), configForm: form })
    // Ollama is up but no longer has it: it stays in its own group, marked, and is what the drop-down shows.
    const followup = picker(FOLLOWUP)
    expect(offered(followup)).toContain('Ollama (local) › Ollama (local) · qwen2:7b（当前不可用）')
    expect(followup.value).toBe(ref('ollama', 'qwen2:7b'))
    expect(followup.selectedOptions[0]!.textContent).toContain('当前不可用')
    // Its provider is gone altogether (signed out): a group of its own, named as it is saved.
    const brief = picker(BRIEF)
    expect(offered(brief).at(-1)).toBe('anthropic › anthropic · claude-sonnet-4-5（当前不可用）')
    expect(brief.value).toBe(ref('anthropic', 'claude-sonnet-4-5'))
    // A model that is offered carries no mark, and the others are not given the saved one.
    expect(offered(picker(VERIFY)).join()).not.toContain('当前不可用')
    // Saving something else does not touch them.
    await type(field('每天几点跑'), '09:30')
    await click(saveButton())
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['runTime'], value: '09:30' }], 7)
    expect(picker(FOLLOWUP).value).toBe(ref('ollama', 'qwen2:7b'))
    // Changing one's mind does not lose it: it is still there to go back to, and going back is no change.
    await choose(FOLLOWUP, ref('deepseek-official', 'deepseek-pro'))
    expect(offered(picker(FOLLOWUP))).toContain('Ollama (local) › Ollama (local) · qwen2:7b（当前不可用）')
    await choose(FOLLOWUP, ref('ollama', 'qwen2:7b'))
    expect(saveButton().disabled).toBe(true)
  })

  it('leaves out a provider that lists no models and no error, unless it holds the saved model', async () => {
    // DSH lists 「DeepSeek Account」 with nothing under it (not signed in), and says nothing is wrong.
    const empty = { provider: 'deepseek-account', name: 'DeepSeek Account', billing: 'metered' as const, error: null, models: [] }
    stubApi({ 'GET models': { ...MODELS, groups: [MODELS.groups[0]!, empty, MODELS.groups[1]!] } })
    const { form } = formOf({ ...SAVED, briefModel: { provider: 'deepseek-account', model: 'deepseek-chat' } })
    await mount(<Settings />, { state: state(), configForm: form })
    const groupsOf = (select: HTMLSelectElement) => [...select.querySelectorAll('optgroup')].map(group => group.label)
    for (const label of [RESEARCH, VERIFY, FOLLOWUP]) expect(groupsOf(picker(label)), label).toEqual(['DeepSeek', 'Ollama (local)'])
    // Where a saved model sits in it, the group stays, with that model marked as it cannot be listed now.
    expect(groupsOf(picker(BRIEF))).toEqual(['DeepSeek', 'DeepSeek Account', 'Ollama (local)'])
    expect(offered(picker(BRIEF))).toContain('DeepSeek Account › DeepSeek Account · deepseek-chat（当前不可用）')
    expect(picker(BRIEF).value).toBe(ref('deepseek-account', 'deepseek-chat'))
  })

  it('shows a provider that failed to list as such, and the others as usual', async () => {
    stubApi({ 'GET models': { ...MODELS, groups: [MODELS.groups[0]!, { ...MODELS.groups[1]!, models: [], error: '读取失败' }] } })
    const { form } = formOf({ ...SAVED, followupModel: { provider: 'ollama', model: 'qwen3:8b' } })
    await mount(<Settings />, { state: state(), configForm: form })
    const select = picker(VERIFY)
    expect(offered(select)).toEqual(['跟调研一样（DeepSeek · deepseek-flash）', 'DeepSeek › DeepSeek · deepseek-flash', 'DeepSeek › DeepSeek · deepseek-pro', 'Ollama (local) › 读取失败'])
    const failed = [...select.options].find(option => option.textContent === '读取失败')!
    expect(failed.disabled).toBe(true)
    expect([...select.options].filter(option => option.disabled)).toEqual([failed])
    // A saved model of that provider is still shown (it cannot be listed now), above the note.
    expect(offered(picker(FOLLOWUP)).slice(-2)).toEqual(['Ollama (local) › Ollama (local) · qwen3:8b（当前不可用）', 'Ollama (local) › 读取失败'])
    expect(picker(FOLLOWUP).value).toBe(ref('ollama', 'qwen3:8b'))
    // A model of the other provider can be picked as ever.
    await choose(VERIFY, ref('deepseek-official', 'deepseek-pro'))
    expect(picker(VERIFY).value).toBe(ref('deepseek-official', 'deepseek-pro'))
  })

  it('names the providers that failed to list, with a way to read again, though the list itself came', async () => {
    stubApi({ 'GET models': { ...MODELS, groups: [MODELS.groups[0]!, { ...MODELS.groups[1]!, models: [], error: '读取失败' }] } })
    await mount(<Settings />, { state: state(), configForm: formOf().form })
    // One provider failing is not the list failing: no error line, a quiet note that says which and offers to read again.
    expect(document.querySelector('.op-models-error')).toBeNull()
    expect(document.querySelector('.op-models-status')?.textContent).toBe('Ollama (local)：读取失败 重新读取')
    expect(document.querySelector('.op-models-status')?.className).toContain('op-set-hint')
    // It asks again, and what the provider has now is offered; with all well the note is gone.
    const again = stubApi({ 'GET models': MODELS })
    await click('重新读取')
    expect(again.requests.filter(request => request.path === 'models')).toHaveLength(1)
    expect(document.querySelector('.op-models-status')).toBeNull()
    expect(offered(picker(VERIFY))).toContain('Ollama (local) › Ollama (local) · qwen3:8b')
  })

  it('says how to use a Claude subscription, and how local and subscription models are billed', async () => {
    await mount(<Settings />, { state: state(), configForm: formOf().form })
    const hints = all('.op-model-notes .op-set-hint').map(hint => hint.textContent)
    expect(hints).toEqual([
      '要用 Claude 订阅：先在 DeepSeek Harness 的模型设置里添加 Anthropic，用 Claude Pro/Max 登录，它就会出现在这里。',
      '本机模型和 Claude 订阅记 ¥0，不占每日预算；用 Anthropic 按量付费的 API key 时，这部分花费前哨不记。',
    ])
  })

  it('shows only the saved models and the default choice, with a line saying so, when the list cannot be read', async () => {
    const api = stubApi({ 'GET models': fail(502, '读不到 DeepSeek Harness 的模型清单') })
    const { form, mutate } = formOf({ ...SAVED, verifyModel: { provider: 'ollama', model: 'qwen3:8b' } })
    await mount(<Settings />, { state: state(), configForm: form })
    expect(document.querySelector('.op-models-error')?.textContent).toContain('读不到 DeepSeek Harness 的模型清单')
    expect(document.querySelector('.op-models-error')?.textContent).toContain('没读到可选的模型')
    expect(offered(picker(RESEARCH))).toEqual(['DeepSeek Harness 的默认模型'])
    // Without the list nothing can be called unavailable: the saved model shows as it is, with its provider's id for source.
    expect(offered(picker(VERIFY))).toEqual(['跟调研一样', 'ollama › ollama · qwen3:8b'])
    expect(picker(VERIFY).selectedOptions[0]!.textContent).toBe('ollama · qwen3:8b')
    expect(picker(VERIFY).value).toBe(ref('ollama', 'qwen3:8b'))
    // The rest of the form still works.
    await type(field('每天几点跑'), '09:30')
    await click(saveButton())
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['runTime'], value: '09:30' }], 7)
    // 重新读取 asks again, and the choices come once DSH answers.
    expect(api.requests.filter(request => request.path === 'models')).toHaveLength(1)
    const again = stubApi({ 'GET models': MODELS })
    await click('重新读取')
    expect(again.requests.filter(request => request.path === 'models')).toHaveLength(1)
    expect(document.querySelector('.op-models-error')).toBeNull()
    expect(offered(picker(RESEARCH))).toContain('Ollama (local) › Ollama (local) · qwen3:8b')
    expect(offered(picker(VERIFY))).not.toContain('ollama › ollama · qwen3:8b')
  })

  it('says the list is being read, on the first read and on reading again, and the drop-downs work meanwhile', async () => {
    // Answers held back by hand (`stubApi` answers at once).
    const answers: ((response: Response) => void)[] = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { answers.push(resolve) })))
    await mount(<Settings />, { state: state(), configForm: formOf({ ...SAVED, followupModel: { provider: 'ollama', model: 'qwen3:8b' } }).form })
    const status = () => document.querySelector('.op-models-status')
    expect(status()?.textContent).toBe('正在读取可用的模型…')
    expect(status()?.className).toContain('op-set-hint')
    expect(all<HTMLSelectElement>('.op-select').some(select => select.disabled)).toBe(false)
    // The list does not come (DSH fails): the line gives way to the one saying why, with the way to read again.
    await act(async () => { answers[0]!(Response.json({ error: '请求超时' }, { status: 502 })) })
    await settle()
    expect(status()?.textContent).toBe('没读到可选的模型：请求超时 重新读取')
    // Reading again: the failure line gives way to the reading line, until the answer comes; then neither is left.
    await click('重新读取')
    expect(answers).toHaveLength(2)
    expect(status()?.textContent).toBe('正在读取可用的模型…')
    expect(document.querySelector('.op-models-error')).toBeNull()
    await act(async () => { answers[1]!(Response.json(MODELS)) })
    await settle()
    expect(status()).toBeNull()
    expect(offered(picker(FOLLOWUP))).toContain('Ollama (local) › Ollama (local) · qwen3:8b')
  })

  it('shows the saved models while the list is being read, and an edit made meanwhile survives its arrival', async () => {
    // DSH has not answered yet (an answer held back by hand; `stubApi` answers at once).
    let answer: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { answer = resolve })))
    const { form, mutate } = formOf({ ...SAVED, followupModel: { provider: 'ollama', model: 'qwen3:8b' } })
    await mount(<Settings />, { state: state(), configForm: form })
    // Nothing is called unavailable while nothing is known; the saved model is simply what the drop-down shows.
    expect(offered(picker(FOLLOWUP))).toEqual(['跟调研一样', 'ollama › ollama · qwen3:8b'])
    expect(picker(FOLLOWUP).value).toBe(ref('ollama', 'qwen3:8b'))
    expect(document.querySelector('.op-models-error')).toBeNull()
    await type(field('每天几点跑'), '09:30')
    await act(async () => { answer(Response.json(MODELS)) })
    await settle()
    // The list is in, the model is in it (so not marked), and the edit is still there.
    expect(offered(picker(FOLLOWUP))).toContain('Ollama (local) › Ollama (local) · qwen3:8b')
    expect(offered(picker(FOLLOWUP)).join()).not.toContain('当前不可用')
    expect(picker(FOLLOWUP).value).toBe(ref('ollama', 'qwen3:8b'))
    expect(field('每天几点跑').value).toBe('09:30')
    await click(saveButton())
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['runTime'], value: '09:30' }], 7)
  })

  it('asks for the models itself, so the Plugin Manager’s page shows them too', async () => {
    const api = stubApi({ 'GET models': MODELS })
    const { form, mutate } = formOf()
    await mount(<SettingsForm t={t} form={form} />)
    expect(api.requests.filter(request => request.path === 'models')).toHaveLength(1)
    expect(offered(picker(FOLLOWUP))).toContain('Ollama (local) › Ollama (local) · llama3.2')
    await choose(FOLLOWUP, ref('ollama', 'llama3.2'))
    await click(saveButton())
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['followupModel'], value: { provider: 'ollama', model: 'llama3.2' } }], 7)
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
    const { form } = formOf({ ...SAVED, model: { provider: 'deepseek', model: 'deepseek-flash' }, followupModel: { provider: 'ollama', model: 'qwen3:8b' } }, { writable: false })
    await mount(<Settings />, { state: state(), configForm: form })
    expect(document.querySelector('.op-settings-note')?.textContent).toBe('在『插件』页修改')
    expect(all('input')).toHaveLength(0)
    const shown = Object.fromEntries(all('.op-setting').map(row => [row.getAttribute('data-key'), row.querySelector('.op-setting-value')?.textContent]))
    expect(shown).toMatchObject({
      runTime: '08:00', maxParallel: '3', dailyBudgetYuan: '¥20', sessionTimeoutMin: '30 分钟',
      model: 'deepseek / deepseek-flash', verifyModel: '跟调研一样', briefModel: '跟调研一样', followupModel: 'ollama / qwen3:8b',
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

  it('lists the four models, research on DSH’s default and the other three following it', async () => {
    const { form } = formOf(SAVED, { writable: false })
    await mount(<Settings />, { state: state(), configForm: form })
    const shown = (key: string) => document.querySelector(`.op-setting[data-key="${key}"] .op-setting-value`)?.textContent
    expect(shown('model')).toBe('DeepSeek Harness 的默认模型')
    expect(['verifyModel', 'briefModel', 'followupModel'].map(shown)).toEqual(['跟调研一样', '跟调研一样', '跟调研一样'])
    expect(['model', 'verifyModel', 'briefModel', 'followupModel'].map(key => document.querySelector(`.op-setting[data-key="${key}"] .op-setting-label`)?.textContent)).toEqual(ROLES)
  })

  it('asks DSH for its models only where the form can be edited', async () => {
    const api = stubApi({ 'GET models': MODELS })
    await mount(<Settings />, { state: state(), configForm: formOf(SAVED, { writable: false }).form })
    expect(api.requests.filter(request => request.path === 'models')).toHaveLength(0)
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
