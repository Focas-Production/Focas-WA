import { describe, it, expect } from 'vitest'

import {
  canReceiveCampaign,
  canReceiveApiTemplate,
  canReceiveAutomationTemplate,
  parseAllowCampaign,
} from './campaign-consent'

describe('canReceiveCampaign', () => {
  it('blocks only an explicit false', () => {
    expect(canReceiveCampaign({ allow_campaign: false })).toBe(false)
    expect(canReceiveCampaign({ allow_campaign: true })).toBe(true)
  })

  it('treats a missing value as allowed (pre-migration rows)', () => {
    expect(canReceiveCampaign({})).toBe(true)
    expect(canReceiveCampaign({ allow_campaign: null })).toBe(true)
    expect(canReceiveCampaign(null)).toBe(true)
  })
})

describe('parseAllowCampaign', () => {
  it('accepts booleans and 1/0', () => {
    expect(parseAllowCampaign(true)).toBe(true)
    expect(parseAllowCampaign(false)).toBe(false)
    expect(parseAllowCampaign(1)).toBe(true)
    expect(parseAllowCampaign(0)).toBe(false)
    expect(parseAllowCampaign(2)).toBeUndefined()
  })

  it('accepts common spellings case-insensitively', () => {
    for (const v of ['TRUE', 'true', 'Yes', 'y', '1', 'on', 'opt-in', 'Opt In']) {
      expect(parseAllowCampaign(v)).toBe(true)
    }
    for (const v of ['FALSE', 'false', 'No', 'n', '0', 'off', 'opt-out', 'OPT_OUT']) {
      expect(parseAllowCampaign(v)).toBe(false)
    }
  })

  it('returns undefined for anything else', () => {
    expect(parseAllowCampaign('')).toBeUndefined()
    expect(parseAllowCampaign('maybe')).toBeUndefined()
    expect(parseAllowCampaign(null)).toBeUndefined()
    expect(parseAllowCampaign(undefined)).toBeUndefined()
  })
})

describe('canReceiveApiTemplate / canReceiveAutomationTemplate', () => {
  it('blocks only an explicit false', () => {
    expect(canReceiveApiTemplate({ allow_api_templates: false })).toBe(false)
    expect(canReceiveApiTemplate({ allow_api_templates: true })).toBe(true)
    expect(canReceiveApiTemplate({})).toBe(true)
    expect(canReceiveAutomationTemplate({ allow_automation_templates: false })).toBe(false)
    expect(canReceiveAutomationTemplate({ allow_automation_templates: true })).toBe(true)
    expect(canReceiveAutomationTemplate(null)).toBe(true)
  })
})
