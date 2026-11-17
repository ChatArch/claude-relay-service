jest.mock('../config/config', () => ({ server: {}, security: {}, rateLimit: {} }), {
  virtual: true
})
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/services/userService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/validators/clientValidator', () => ({}))
jest.mock('../src/validators/clients/claudeCodeValidator', () => ({}))
jest.mock('../src/services/claudeRelayConfigService', () => ({}))
jest.mock('../src/utils/statsHelper', () => ({}))
jest.mock('../src/utils/modelHelper', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const express = require('express')
const request = require('supertest')
const logger = require('../src/utils/logger')
const { requestLogger, errorHandler } = require('../src/middleware/auth')
const { skipSensitiveAuthLogging } = require('../src/middleware/authLogPolicy')
const SECRET = 'synthetic-credential-never-log'

describe('sensitive authentication HTTP logging', () => {
  let app, debug, debugRecords
  beforeEach(() => {
    jest.clearAllMocks()
    debugRecords = []
    debug = jest.fn((req, res, next) => {
      debugRecords.push({ url: req.originalUrl, body: req.body, headers: req.headers })
      const json = res.json.bind(res)
      res.json = (body) => {
        debugRecords.push({ response: body })
        return json(body)
      }
      next()
    })
    app = express()
    // Test pre-parsed bodies as well as the production order, which parses later.
    app.use(express.json())
    app.use(requestLogger)
    app.use(skipSensitiveAuthLogging(debug))
    app.all('*', (req, res) => {
      req.apiKey = { name: SECRET, id: SECRET }
      req._authInfo = { token: SECRET }
      res.json({ success: true, token: SECRET })
    })
    app.use(errorHandler)
  })

  test.each([
    '/web/auth/login',
    '/WEB/AUTH/login',
    '/web/auth/logout',
    '/web/auth/change-password',
    '/web/auth',
    '/auth/sandbox/verify',
    '/auth/sandbox/status',
    '/auth/sandbox/unknown'
  ])(
    'omits sensitive request/response/query/headers for %s even with debug enabled',
    async (path) => {
      const response = await request(app)
        .post(`${path}?password=${SECRET}`)
        .set('Authorization', `Bearer ${SECRET}`)
        .set('Cookie', `adminToken=${SECRET}`)
        .set('x-api-key', SECRET)
        .set('Referer', `https://synthetic.example/?token=${SECRET}`)
        .set('User-Agent', SECRET)
        .send({ username: 'synthetic', password: SECRET })
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ success: true, token: SECRET })
      expect(debug).not.toHaveBeenCalled()
      expect(debugRecords).toEqual([])
      expect(logger.info).toHaveBeenCalled()
      for (const method of ['debug', 'info', 'warn', 'error']) {
        const recorded = JSON.stringify(logger[method].mock.calls)
        expect(recorded).not.toContain(SECRET)
        expect(recorded).not.toContain('password=')
      }
    }
  )

  test('ordinary model request and response logging/debug behavior remain unchanged', async () => {
    const response = await request(app)
      .post('/api/v1/messages?trace=ordinary')
      .send({ model: 'synthetic-model' })
    expect(response.status).toBe(200)
    expect(debug).toHaveBeenCalledTimes(1)
    expect(debugRecords[0].url).toBe('/api/v1/messages?trace=ordinary')
    expect(debugRecords[0].body).toEqual({ model: 'synthetic-model' })
    expect(debugRecords[1].response).toEqual(response.body)
    const metadata = logger.info.mock.calls[0][1]
    expect(metadata.req).toEqual({ model: 'synthetic-model' })
    expect(metadata.res).toEqual(response.body)
    expect(metadata.query).toBe('trace=ordinary')
  })

  test('malformed auth JSON and error metadata cannot disclose the rejected credential', async () => {
    const response = await request(app)
      .post(`/web/auth/login?token=${SECRET}`)
      .set('User-Agent', SECRET)
      .set('Content-Type', 'application/json')
      .send(`{"password":"${SECRET}",INVALID}`)
    expect(response.status).toBe(400)
    expect(logger.error).toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
    expect(JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls))).not.toContain(
      SECRET
    )
  })

  test('auth error and slow-request logs omit arbitrary exception text and query', () => {
    const events = {}
    const req = {
      method: 'POST',
      originalUrl: `/web/auth/login?token=${SECRET}`,
      body: { password: SECRET },
      headers: {},
      get: () => SECRET
    }
    const res = {
      setHeader: jest.fn(),
      json: jest.fn(),
      get: () => '0',
      statusCode: 500,
      on: (name, fn) => {
        events[name] = fn
      }
    }
    const clock = jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(6000)
    try {
      requestLogger(req, res, jest.fn())
      events.error(new Error(SECRET))
      events.finish()
      expect(logger.warn).toHaveBeenCalled()
      expect(JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls))).not.toContain(
        SECRET
      )
    } finally {
      clock.mockRestore()
    }
  })
})
