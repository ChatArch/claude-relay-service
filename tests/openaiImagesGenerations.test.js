const { Readable } = require('stream')

const mockRouter = {
  get: jest.fn(),
  post: jest.fn()
}

jest.mock(
  'express',
  () => ({
    Router: () => mockRouter
  }),
  { virtual: true }
)

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000
  }),
  { virtual: true }
)

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: jest.fn((_req, _res, next) => next())
}))

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountRateLimited: jest.fn(),
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  removeAccountRateLimit: jest.fn(),
  markAccountUnauthorized: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  decrypt: jest.fn(),
  isTokenExpired: jest.fn(() => false),
  refreshAccountToken: jest.fn(),
  updateCodexUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(() => true),
  recordUsage: jest.fn().mockResolvedValue(null)
}))

jest.mock('../src/models/redis', () => ({
  getUsageStats: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn().mockResolvedValue({ totalTokens: 0, totalCost: 0 })
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((error) => error?.message || String(error || 'error'))
}))

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => null),
  extractOpenAICacheReadTokens: jest.fn(() => 0)
}))

const axios = require('axios')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')
const openaiRoutes = require('../src/routes/openaiRoutes')
const registeredPostPaths = mockRouter.post.mock.calls.map((call) => call[0])

function createReq(body) {
  return {
    method: 'POST',
    path: '/v1/images/generations',
    url: '/v1/images/generations',
    originalUrl: '/openai/v1/images/generations',
    headers: {
      'user-agent': 'image-client/1.0'
    },
    body: JSON.parse(JSON.stringify(body)),
    apiKey: {
      id: 'key_1',
      permissions: ['openai'],
      enableOpenAIResponsesCodexAdaptation: true,
      enableOpenAIResponsesPayloadRules: false,
      openaiResponsesPayloadRules: []
    },
    rateLimitInfo: { source: 'test' },
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn()
  }
}

function createRes() {
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    destroyed: false,
    status: jest.fn((code) => {
      res.statusCode = code
      return res
    }),
    json: jest.fn((payload) => {
      res.payload = payload
      res.headersSent = true
      return res
    }),
    setHeader: jest.fn((key, value) => {
      res.headers[key] = value
    }),
    set: jest.fn((key, value) => {
      res.headers[key] = value
      return res
    }),
    write: jest.fn(),
    end: jest.fn(),
    flushHeaders: jest.fn()
  }
  return res
}

function sseStream(events) {
  return Readable.from(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
}

describe('openai images generations compatibility route', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'openai-1',
      accountType: 'openai'
    })
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'openai-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1'
    })
    openaiAccountService.decrypt.mockReturnValue('decrypted-token')
  })

  test('registers OpenAI-compatible images generation routes', () => {
    expect(registeredPostPaths).toContain('/images/generations')
    expect(registeredPostPaths).toContain('/v1/images/generations')
  })

  test('converts images generation body into Responses image_generation payload', () => {
    const payload = openaiRoutes.buildImageGenerationResponsesPayload(
      {
        model: 'gpt-image-2',
        prompt: 'draw a small blue circle',
        size: '1024x1024',
        quality: 'low',
        output_format: 'png',
        background: 'opaque'
      },
      'gpt-5.4'
    )

    expect(payload).toMatchObject({
      model: 'gpt-5.4',
      store: false,
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'draw a small blue circle' }]
        }
      ],
      tools: [
        {
          type: 'image_generation',
          model: 'gpt-image-2',
          size: '1024x1024',
          quality: 'low',
          output_format: 'png',
          background: 'opaque',
          partial_images: 1
        }
      ]
    })
    expect(payload.tool_choice).toEqual({
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'image_generation' }]
    })
  })

  test('rejects unsupported images generation requests before touching provider credentials', async () => {
    const req = createReq({ model: 'gpt-image-2', prompt: 'x', n: 2 })
    const res = createRes()

    await openaiRoutes.handleImageGeneration(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.payload.error).toMatchObject({
      type: 'invalid_request_error',
      param: 'n'
    })
    expect(unifiedOpenAIScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  })

  test('extracts the final image base64 from Responses SSE events', () => {
    const b64 = openaiRoutes.extractImageGenerationB64FromSse(
      'event: response.image_generation_call.partial_image\n' +
        'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"partial"}\n\n' +
        'event: response.output_item.done\n' +
        'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"final"}}\n\n'
    )

    expect(b64).toBe('final')
  })

  test('handles /v1/images/generations through the existing CRS OpenAI account flow', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: sseStream([
        {
          type: 'response.output_item.done',
          item: {
            type: 'image_generation_call',
            result: 'image-b64'
          }
        },
        {
          type: 'response.completed',
          response: {
            model: 'gpt-5.4',
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              total_tokens: 14
            }
          }
        }
      ])
    })

    const req = createReq({
      model: 'gpt-image-2',
      prompt: 'draw a green square',
      size: '1024x1024',
      quality: 'low',
      n: 1
    })
    const res = createRes()

    await openaiRoutes.handleImageGeneration(req, res)

    expect(unifiedOpenAIScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      null,
      'gpt-5.4'
    )
    expect(axios.post).toHaveBeenCalled()
    expect(axios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5.4',
      stream: true,
      tools: [
        expect.objectContaining({
          type: 'image_generation',
          model: 'gpt-image-2',
          quality: 'low'
        })
      ]
    })
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.payload).toMatchObject({
      data: [{ b64_json: 'image-b64' }]
    })
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key_1',
      10,
      4,
      0,
      0,
      'gpt-5.4',
      'openai-1',
      'openai',
      null,
      null
    )
    expect(updateRateLimitCounters).toHaveBeenCalledWith(
      { source: 'test' },
      {
        inputTokens: 10,
        outputTokens: 4,
        cacheCreateTokens: 0,
        cacheReadTokens: 0
      },
      'gpt-5.4',
      'key_1',
      'openai',
      null
    )
  })

  test('marks the selected account rate-limited when upstream image generation returns 429', async () => {
    axios.post.mockResolvedValue({
      status: 429,
      headers: {},
      data: sseStream([
        {
          type: 'error',
          error: {
            message: 'rate limited',
            type: 'usage_limit_reached',
            resets_in_seconds: 60
          }
        }
      ])
    })

    const req = createReq({
      model: 'gpt-image-2',
      prompt: 'draw a green square',
      n: 1
    })
    const res = createRes()

    await openaiRoutes.handleImageGeneration(req, res)

    expect(res.status).toHaveBeenCalledWith(429)
    expect(unifiedOpenAIScheduler.markAccountRateLimited).toHaveBeenCalledWith(
      'openai-1',
      'openai',
      null,
      60
    )
  })

  test('maps HTTP 200 SSE usage-limit errors to 429 and marks the account', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: sseStream([
        {
          type: 'error',
          error: {
            message: 'stream rate limited',
            type: 'usage_limit_reached',
            resets_in_seconds: 45
          }
        }
      ])
    })

    const req = createReq({
      model: 'gpt-image-2',
      prompt: 'draw a green square',
      n: 1
    })
    const res = createRes()

    await openaiRoutes.handleImageGeneration(req, res)

    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.payload.error.message).toBe('stream rate limited')
    expect(unifiedOpenAIScheduler.markAccountRateLimited).toHaveBeenCalledWith(
      'openai-1',
      'openai',
      null,
      45
    )
  })

  test('marks the selected account unauthorized when upstream image generation returns 401', async () => {
    axios.post.mockResolvedValue({
      status: 401,
      headers: {},
      data: sseStream([
        {
          type: 'error',
          error: {
            message: 'unauthorized',
            type: 'unauthorized'
          }
        }
      ])
    })

    const req = createReq({
      model: 'gpt-image-2',
      prompt: 'draw a green square',
      n: 1
    })
    const res = createRes()

    await openaiRoutes.handleImageGeneration(req, res)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(unifiedOpenAIScheduler.markAccountUnauthorized).toHaveBeenCalledWith(
      'openai-1',
      'openai',
      null,
      expect.stringContaining('OpenAI account auth failed')
    )
  })
})
