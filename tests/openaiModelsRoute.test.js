const express = require('express')
const request = require('supertest')

jest.mock('../config/config', () => ({}), { virtual: true })
jest.mock('../src/utils/logger', () => ({
  warn: jest.fn()
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({}))
jest.mock('../src/services/account/openaiAccountService', () => ({}))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({}))
jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({}))
jest.mock('../src/services/openaiModelCatalogService', () => ({
  getModelsForRequest: jest.fn(() =>
    Promise.resolve({
      source: 'upstream',
      models: [
        { id: 'gpt-5.4', object: 'model', owned_by: 'openai' },
        { id: 'gpt-6.2-sol', object: 'model', owned_by: 'openai' }
      ]
    })
  )
}))
jest.mock('../src/services/requestBodyRuleService', () => ({}))
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/utils/rateLimitHelper', () => ({}))
jest.mock('../src/utils/requestDetailHelper', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn((permissions, service) => permissions?.includes(service))
}))
jest.mock('../src/services/modelService', () => ({
  getModelsByProvider: jest.fn(() => [
    { id: 'gpt-5.4', object: 'model', owned_by: 'openai' },
    { id: 'gpt-5.6-sol', object: 'model', owned_by: 'openai' }
  ])
}))
jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: (req, res, next) => {
    if (req.headers.authorization !== 'Bearer test-key') {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    req.apiKey = {
      permissions: req.headers['x-test-permissions']?.split(',') || ['openai'],
      enableModelRestriction: Boolean(req.headers['x-test-blocked']),
      restrictedModels: req.headers['x-test-blocked']?.split(',') || []
    }
    return next()
  }
}))

const modelService = require('../src/services/modelService')
const openaiModelCatalogService = require('../src/services/openaiModelCatalogService')
const openaiRoutes = require('../src/routes/openaiRoutes')
const app = express()
app.use('/openai', openaiRoutes)

describe('OpenAI model discovery', () => {
  beforeEach(() => {
    modelService.getModelsByProvider.mockClear()
    openaiModelCatalogService.getModelsForRequest.mockClear()
  })

  test('requires API key authentication', async () => {
    const res = await request(app).get('/openai/v1/models')
    expect(res.status).toBe(401)
    expect(modelService.getModelsByProvider).not.toHaveBeenCalled()
  })

  test('requires OpenAI permission', async () => {
    const res = await request(app)
      .get('/openai/v1/models')
      .set('Authorization', 'Bearer test-key')
      .set('x-test-permissions', 'claude')
    expect(res.status).toBe(403)
    expect(modelService.getModelsByProvider).not.toHaveBeenCalled()
  })

  test('returns only OpenAI models allowed by the key', async () => {
    const res = await request(app)
      .get('/openai/v1/models')
      .set('Authorization', 'Bearer test-key')
      .set('x-test-blocked', 'gpt-5.4')
    expect(res.status).toBe(200)
    expect(openaiModelCatalogService.getModelsForRequest).toHaveBeenCalled()
    expect(res.body).toEqual({
      object: 'list',
      data: [{ id: 'gpt-6.2-sol', object: 'model', owned_by: 'openai' }]
    })
  })

  test('supports the unversioned models path for Codex discovery', async () => {
    const res = await request(app).get('/openai/models').set('Authorization', 'Bearer test-key')

    expect(res.status).toBe(200)
    expect(res.headers['x-crs-model-source']).toBe('upstream')
    expect(res.body.data.map((model) => model.id)).toEqual(['gpt-5.4', 'gpt-6.2-sol'])
  })

  test('falls back to the current bootstrap catalog when upstream discovery fails', async () => {
    openaiModelCatalogService.getModelsForRequest.mockRejectedValueOnce(new Error('upstream down'))
    modelService.getModelsByProvider.mockReturnValueOnce([
      { id: 'gpt-6.2-sol', object: 'model', owned_by: 'openai' }
    ])

    const res = await request(app).get('/openai/v1/models').set('Authorization', 'Bearer test-key')

    expect(res.status).toBe(200)
    expect(modelService.getModelsByProvider).toHaveBeenCalledWith('openai')
    expect(res.headers['x-crs-model-source']).toBe('bootstrap')
    expect(res.body.data).toEqual([{ id: 'gpt-6.2-sol', object: 'model', owned_by: 'openai' }])
  })
})
