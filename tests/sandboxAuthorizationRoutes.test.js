const express = require('express')
const request = require('supertest')
const {
  createSandboxVerificationRouter,
  createVerificationLimiter,
  readSandboxKey
} = require('../src/routes/sandboxAuthorization')
const { createSandboxGrantsRouter } = require('../src/routes/admin/sandboxGrants')
const { SandboxAuthorizationError } = require('../src/services/sandboxAuthorizationService')

const key = `cr_${'a'.repeat(64)}`
const version = 'b'.repeat(64)
describe('Sandbox verification and grant HTTP contracts', () => {
  let app, service, admin
  beforeEach(() => {
    service = {
      verify: jest.fn().mockResolvedValue({ schema_version: 1, active: true, key_id: 'key-1' }),
      status: jest.fn(async (id, capability) => ({
        schema_version: 1,
        active: id === 'key-1' && capability === version
      })),
      get: jest.fn().mockResolvedValue({ key_id: 'key-1' }),
      put: jest.fn().mockResolvedValue({ key_id: 'key-1' }),
      revoke: jest.fn().mockResolvedValue({ key_id: 'key-1', revoked: true })
    }
    admin = jest.fn((req, res, next) => {
      if (req.headers.authorization !== 'Bearer synthetic-admin-session') {
        return res.status(401).json({ error: 'admin_required' })
      }
      return next()
    })
    app = express()
    app.use('/auth/sandbox', createSandboxVerificationRouter({ service }))
    app.use(express.json())
    app.use(
      '/admin/sandbox-grants',
      createSandboxGrantsRouter({ service, authenticateAdmin: admin })
    )
  })

  test.each(['Authorization', 'x-api-key'])(
    'verifies only explicit caller Key in %s',
    async (name) => {
      const response = await request(app)
        .post('/auth/sandbox/verify')
        .set(name, name === 'Authorization' ? `Bearer ${key}` : key)
        .send({})
      expect(response.status).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(service.verify).toHaveBeenCalledWith(key)
      expect(admin).not.toHaveBeenCalled()
      expect(JSON.stringify(response.body)).not.toContain(key)
    }
  )

  test('identical dual headers accepted, conflicting/malformed or cookie-only refused', async () => {
    expect(
      (
        await request(app)
          .post('/auth/sandbox/verify')
          .set('Authorization', `Bearer ${key}`)
          .set('x-api-key', key)
          .send({})
      ).status
    ).toBe(200)
    for (const headers of [
      { Authorization: `Bearer ${key}`, 'x-api-key': 'different' },
      { Authorization: `Basic ${key}` },
      { Cookie: 'adminToken=anything' },
      { 'x-admin-token': 'anything' },
      { 'X-Forwarded-User': 'owner' }
    ]) {
      expect((await request(app).post('/auth/sandbox/verify').set(headers).send({})).status).toBe(
        401
      )
    }
  })

  test('duplicate credential wire headers are rejected before resolving identity', () => {
    for (const header of ['authorization', 'x-api-key']) {
      expect(() =>
        readSandboxKey({
          headers: { authorization: `Bearer ${key}` },
          rawHeaders: [header, key, header.toUpperCase(), key]
        })
      ).toThrow(SandboxAuthorizationError)
    }
  })

  test('rejects query credentials and caller/identity claims in body', async () => {
    expect((await request(app).post(`/auth/sandbox/verify?api_key=${key}`).send({})).status).toBe(
      400
    )
    expect(
      (
        await request(app)
          .post('/auth/sandbox/verify')
          .set('Authorization', `Bearer ${key}`)
          .send({ caller_id: 'victim' })
      ).status
    ).toBe(400)
    expect(service.verify).not.toHaveBeenCalled()
  })

  test('status takes only capability references and returns no identity/Key fields', async () => {
    const response = await request(app)
      .post('/auth/sandbox/status')
      .send({ key_id: 'key-1', grant_version: version })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ schema_version: 1, active: true })
    expect(service.status).toHaveBeenCalledWith('key-1', version)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(
      (
        await request(app)
          .post('/auth/sandbox/status')
          .send({ key_id: 'key-1', grant_version: version, caller_id: 'forged' })
      ).status
    ).toBe(400)
    expect((await request(app).post('/auth/sandbox/status').send({})).body).toEqual({
      schema_version: 1,
      active: false
    })
  })

  test.each([401, 403, 503])(
    'safe service denial status %d never exposes backend data',
    async (status) => {
      const codes = {
        401: 'invalid_sandbox_key',
        403: 'sandbox_access_denied',
        503: 'sandbox_authorization_unavailable'
      }
      service.verify.mockRejectedValue(new SandboxAuthorizationError(codes[status]))
      const response = await request(app)
        .post('/auth/sandbox/verify')
        .set('Authorization', `Bearer ${key}`)
        .send({})
      expect(response.status).toBe(status)
      expect(response.body).toEqual({ active: false, error: codes[status] })
      service.status.mockRejectedValue(new Error(key))
      const probe = await request(app)
        .post('/auth/sandbox/status')
        .send({ key_id: 'key-1', grant_version: version })
      expect(probe.status).toBe(503)
      expect(JSON.stringify(probe.body)).not.toContain(key)
    }
  )

  test('grant denial reveals only the verified caller Key ID for operator enrollment', async () => {
    service.verify.mockRejectedValue(
      new SandboxAuthorizationError('sandbox_access_denied', 'key-1')
    )
    const response = await request(app)
      .post('/auth/sandbox/verify')
      .set('Authorization', `Bearer ${key}`)
      .send({})
    expect(response.status).toBe(403)
    expect(response.body).toEqual({
      active: false,
      error: 'sandbox_access_denied',
      key_id: 'key-1'
    })
    expect(response.headers['cache-control']).toBe('no-store')
    for (const code of ['invalid_sandbox_key', 'sandbox_authorization_unavailable']) {
      service.verify.mockRejectedValue(new SandboxAuthorizationError(code, 'key-1'))
      const invalid = await request(app)
        .post('/auth/sandbox/verify')
        .set('Authorization', `Bearer ${key}`)
        .send({})
      expect(invalid.body).not.toHaveProperty('key_id')
    }
  })

  test.each(['get', 'put', 'delete'])(
    'grant %s requires explicit existing admin session',
    async (method) => {
      const response = await request(app)
        [method]('/admin/sandbox-grants/key-1')
        .set('Authorization', 'Bearer synthetic-admin-session')
        .send(method === 'put' ? { enabled: false } : undefined)
      expect(response.status).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(admin).toHaveBeenCalledTimes(1)
      expect(service[method === 'delete' ? 'revoke' : method]).toHaveBeenCalled()
    }
  )

  test.each([
    {},
    { Cookie: 'adminToken=session' },
    { Authorization: `Bearer ${key}` },
    { Authorization: `Bearer crsm_${'A'.repeat(43)}` },
    { 'x-api-key': key },
    { 'x-admin-token': 'session' }
  ])('grant edit refuses alternate identities %p without fallback', async (headers) => {
    expect(
      (await request(app).put('/admin/sandbox-grants/key-1').set(headers).send({})).status
    ).toBe(401)
    expect(admin).not.toHaveBeenCalled()
    expect(service.put).not.toHaveBeenCalled()
  })

  test('coarse verifier limit is bounded and separate from model budget', async () => {
    let now = 1000
    const limited = express()
    limited.use(express.json())
    limited.use(
      '/auth/sandbox',
      createSandboxVerificationRouter({
        service,
        limiter: createVerificationLimiter({
          now: () => now,
          requests: 2,
          windowMs: 1000,
          maxIps: 1
        })
      })
    )
    const call = () =>
      request(limited)
        .post('/auth/sandbox/status')
        .send({ key_id: 'key-1', grant_version: version })
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(200)
    const denied = await call()
    expect(denied.status).toBe(429)
    expect(denied.headers['retry-after']).toBe('1')
    expect(service.status).toHaveBeenCalledTimes(2)
    now += 1000
    expect((await call()).status).toBe(200)
  })

  test('public parser rejects oversized, malformed and non-JSON bodies without echoing them', async () => {
    const oversized = await request(app)
      .post('/auth/sandbox/status')
      .send({ extra: key.repeat(64) })
    expect(oversized.status).toBe(413)
    const malformed = await request(app)
      .post('/auth/sandbox/status')
      .set('Content-Type', 'application/json')
      .send(`{"key":"${key}`)
    expect(malformed.status).toBe(400)
    const text = await request(app)
      .post('/auth/sandbox/verify')
      .set('Content-Type', 'text/plain')
      .send(key)
    expect(text.status).toBe(415)
    for (const response of [oversized, malformed, text]) {
      expect(response.headers['cache-control']).toBe('no-store')
      expect(JSON.stringify(response.body)).not.toContain(key)
    }
    expect(service.verify).not.toHaveBeenCalled()
    expect(service.status).not.toHaveBeenCalled()
  })

  test('limiter bounds retained IP cardinality and expires buckets', () => {
    let now = 0
    const limit = createVerificationLimiter({ now: () => now, maxIps: 1, windowMs: 1000 })
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
    const next = jest.fn()
    limit({ ip: 'peer-one' }, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    limit({ ip: 'peer-two' }, res, next)
    expect(res.status).toHaveBeenCalledWith(429)
    expect(next).toHaveBeenCalledTimes(1)
    now = 1000
    limit({ ip: 'peer-two' }, res, next)
    expect(next).toHaveBeenCalledTimes(2)
  })
})
