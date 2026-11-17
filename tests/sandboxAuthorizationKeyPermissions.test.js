jest.mock('../config/config', () => ({ server: {}, security: {}, rateLimit: {} }), {
  virtual: true
})
jest.mock('../src/services/apiKeyService', () => ({
  validateApiKey: jest.fn(),
  generateApiKey: jest.fn(),
  updateApiKey: jest.fn(),
  normalizePermissions: jest.fn((permissions) =>
    Array.isArray(permissions) ? permissions : JSON.parse(permissions)
  )
}))
jest.mock('../src/services/userService', () => ({}))
jest.mock('../src/models/redis', () => ({ incrementConcurrency: jest.fn() }))
jest.mock('../src/validators/clientValidator', () => ({ validateRequest: jest.fn() }))
jest.mock('../src/validators/clients/claudeCodeValidator', () => ({}))
jest.mock('../src/services/claudeRelayConfigService', () => ({}))
jest.mock('../src/utils/statsHelper', () => ({}))
jest.mock('../src/utils/modelHelper', () => ({}))
jest.mock('../src/utils/costCalculator', () => ({}))
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  security: jest.fn()
}))
jest.mock('../src/services/requestBodyRuleService', () => ({
  validateAndNormalizeRules: jest.fn(() => ({ valid: true, rules: [] }))
}))

const express = require('express')
const request = require('supertest')
const apiKeyService = require('../src/services/apiKeyService')
const redis = require('../src/models/redis')
const clientValidator = require('../src/validators/clientValidator')
const auth = require('../src/middleware/auth')

jest.spyOn(auth, 'authenticateAdmin').mockImplementation((req, res, next) => {
  if (req.headers.authorization !== 'Bearer synthetic-admin') {
    return res.status(401).json({ error: 'admin_required' })
  }
  return next()
})
const adminKeys = require('../src/routes/admin/apiKeys')

describe('Sandbox-only Key permissions at HTTP boundaries', () => {
  let app, modelDispatch
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.generateApiKey.mockResolvedValue({
      id: 'synthetic-key',
      permissions: ['sandbox']
    })
    apiKeyService.updateApiKey.mockResolvedValue()
    apiKeyService.validateApiKey.mockResolvedValue({
      valid: true,
      keyData: {
        id: 'synthetic-key',
        permissions: ['sandbox'],
        enableClientRestriction: true,
        allowedClients: ['claude_code'],
        concurrencyLimit: 1
      }
    })
    app = express()
    app.use(express.json())
    app.use('/admin', adminKeys)
    modelDispatch = jest.fn((_req, res) => res.json({ unexpected: 'model-dispatch' }))
    app.use(auth.authenticateApiKey, modelDispatch)
  })

  test('Admin can create an explicitly Sandbox-only Key', async () => {
    const response = await request(app)
      .post('/admin/api-keys')
      .set('Authorization', 'Bearer synthetic-admin')
      .send({ name: 'Sandbox client', permissions: ['sandbox'], expirationMode: 'fixed' })
    expect(response.status).toBe(200)
    expect(apiKeyService.generateApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ['sandbox'], expirationMode: 'fixed' })
    )
  })

  test('Admin can update permissions without granting model services', async () => {
    const response = await request(app)
      .put('/admin/api-keys/synthetic-key')
      .set('Authorization', 'Bearer synthetic-admin')
      .send({ permissions: ['sandbox'] })
    expect(response.status).toBe(200)
    expect(apiKeyService.updateApiKey).toHaveBeenCalledWith('synthetic-key', {
      permissions: ['sandbox']
    })
  })

  test('ordinary callers cannot provision Sandbox-only Keys', async () => {
    const response = await request(app)
      .post('/admin/api-keys')
      .set('x-api-key', 'cr_synthetic-caller-key')
      .send({ name: 'Unauthorized', permissions: ['sandbox'] })
    expect(response.status).toBe(401)
    expect(apiKeyService.generateApiKey).not.toHaveBeenCalled()
  })

  test('unknown permissions remain invalid', async () => {
    const response = await request(app)
      .post('/admin/api-keys')
      .set('Authorization', 'Bearer synthetic-admin')
      .send({ name: 'Invalid', permissions: ['sandbox-admin'] })
    expect(response.status).toBe(400)
    expect(apiKeyService.generateApiKey).not.toHaveBeenCalled()
  })

  test.each([
    '/api/v1/messages',
    '/api/v1/messages/count_tokens',
    '/openai/v1/responses',
    '/gemini/v1beta/models/test:generateContent',
    '/azure-openai/chat/completions',
    '/azure-openai/embeddings',
    '/droid/v1/responses',
    '/v1/chat/completions'
  ])('rejects model endpoint %s before client/concurrency checks or dispatch', async (path) => {
    const response = await request(app)
      .post(path)
      .set('x-api-key', 'cr_synthetic-sandbox-only-key')
      .send({ model: 'synthetic-model', messages: [] })
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('sandbox_only_key')
    expect(clientValidator.validateRequest).not.toHaveBeenCalled()
    expect(redis.incrementConcurrency).not.toHaveBeenCalled()
    expect(modelDispatch).not.toHaveBeenCalled()
  })

  test('stored JSON permissions are denied too', async () => {
    apiKeyService.validateApiKey.mockResolvedValue({
      valid: true,
      keyData: { permissions: '["sandbox"]' }
    })
    const response = await request(app)
      .get('/azure-openai/models')
      .set('x-api-key', 'cr_synthetic-sandbox-only-key')
    expect(response.status).toBe(403)
    expect(modelDispatch).not.toHaveBeenCalled()
  })

  test.each([[[]], [['openai']], [['sandbox', 'openai']]])(
    'keeps model middleware behavior for permissions %p',
    async (permissions) => {
      apiKeyService.validateApiKey.mockResolvedValue({
        valid: true,
        keyData: { id: 'synthetic-model-key', permissions }
      })
      const response = await request(app)
        .post('/openai/v1/responses')
        .set('x-api-key', 'cr_synthetic-model-key')
        .send({ model: 'synthetic-model' })
      expect(response.status).toBe(200)
      expect(modelDispatch).toHaveBeenCalledTimes(1)
    }
  )
})
