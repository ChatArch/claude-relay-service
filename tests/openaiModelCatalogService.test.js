jest.mock('../src/utils/logger', () => ({
  warn: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null)
}))

jest.mock('axios', () => ({
  get: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  decrypt: jest.fn((value) => value),
  refreshAccountToken: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

const axios = require('axios')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const service = require('../src/services/openaiModelCatalogService')

describe('OpenAI model catalog discovery', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    service.cache.clear()
    service.inFlight.clear()
  })

  test('normalizes the live Codex catalog and filters hidden entries', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'account-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'account-1',
      accountId: 'chatgpt-account-1',
      accessToken: 'encrypted-token',
      proxy: null
    })
    axios.get.mockResolvedValue({
      status: 200,
      data: {
        models: [
          { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', priority: 1 },
          { slug: 'gpt-6.2-astra', display_name: 'GPT-6.2 Astra', priority: 0 },
          { slug: 'gpt-5.6-sol', visibility: 'hide' }
        ]
      }
    })

    const result = await service.getModelsForRequest({ permissions: ['openai'] })

    expect(result.source).toBe('upstream')
    expect(result.models.map((model) => model.id)).toEqual(['gpt-6.2-astra', 'gpt-6.2-sol'])
    expect(axios.get).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/models',
      expect.objectContaining({
        params: { client_version: '1.0.0' },
        headers: expect.objectContaining({
          Authorization: 'Bearer encrypted-token',
          'ChatGPT-Account-Id': 'chatgpt-account-1'
        })
      })
    )
  })

  test('discovers models from an OpenAI-compatible account', async () => {
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'account-2',
      accountType: 'openai-responses'
    })
    openaiResponsesAccountService.getAccount.mockResolvedValue({
      id: 'account-2',
      baseApi: 'https://provider.example/v1',
      apiKey: 'provider-key',
      proxy: null
    })
    axios.get.mockResolvedValue({
      status: 200,
      data: { data: [{ id: 'qwen3.8-max', owned_by: 'qwen' }] }
    })

    const result = await service.getModelsForRequest({ permissions: ['openai'] })

    expect(result.models).toEqual([
      {
        id: 'qwen3.8-max',
        object: 'model',
        created: expect.any(Number),
        owned_by: 'qwen'
      }
    ])
    expect(axios.get).toHaveBeenCalledWith(
      'https://provider.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer provider-key' })
      })
    )
  })

  test('uses the cached catalog during the TTL', async () => {
    const account = {
      id: 'account-3',
      accountId: 'chatgpt-account-3',
      accessToken: 'token',
      proxy: null
    }
    axios.get.mockResolvedValue({
      status: 200,
      data: { models: [{ slug: 'gpt-6.2-sol' }] }
    })
    const first = await service.getModelsForAccount({
      account,
      accountId: 'account-3',
      accountType: 'openai',
      accessToken: 'token'
    })
    const second = await service.getModelsForAccount({
      account,
      accountId: 'account-3',
      accountType: 'openai',
      accessToken: 'token'
    })

    expect(first.source).toBe('upstream')
    expect(second.source).toBe('cache')
    expect(axios.get).toHaveBeenCalledTimes(1)
  })
})
