const crypto = require('crypto')
const {
  createSandboxAuthorizationService,
  SandboxAuthorizationError
} = require('../src/services/sandboxAuthorizationService')

const KEY = `cr_${'1'.repeat(64)}`
const KEY_ID = 'key-synthetic'
const security = { apiKeyPrefix: 'cr_', encryptionKey: 'synthetic-test-only-encryption-key' }
const hash = (key) =>
  crypto
    .createHash('sha256')
    .update(key + security.encryptionKey)
    .digest('hex')
const grantInput = () => ({
  enabled: true,
  caller_id: 'trusted-caller',
  actions: ['create', 'list', 'connect', 'exec', 'files', 'renew', 'delete', 'ports'],
  allowed_images: ['python:3.11-slim'],
  allowed_ports: [44772],
  limits: { max_sandboxes: 2, max_cpu_millis: 2000, max_memory_mib: 2048, max_ttl_seconds: 600 },
  expires_at: null
})

function fakeRedis() {
  const indexes = new Map([[hash(KEY), KEY_ID]])
  const keys = new Map([
    [
      KEY_ID,
      {
        id: KEY_ID,
        apiKey: hash(KEY),
        isActive: 'true',
        expirationMode: 'fixed',
        isActivated: 'true',
        permissions: '[]',
        expiresAt: ''
      }
    ]
  ])
  const legacy = new Map()
  const grants = new Map()
  return {
    indexes,
    keys,
    legacy,
    grants,
    hget: jest.fn(async (_map, digest) => indexes.get(digest) || null),
    hgetall: jest.fn(async (key) => {
      if (key.startsWith('apikey_hash:')) {
        return legacy.get(key.slice(12)) || {}
      }
      return keys.get(key.slice(7)) || {}
    }),
    get: jest.fn(async (key) => grants.get(key) || null),
    set: jest.fn(async (key, value) => {
      grants.set(key, value)
      return 'OK'
    }),
    del: jest.fn(async (key) => Number(grants.delete(key)))
  }
}

describe('independent Sandbox authorization', () => {
  let redis, service, now, getUser
  beforeEach(() => {
    redis = fakeRedis()
    now = Date.parse('2026-01-01T00:00:00Z')
    getUser = jest.fn().mockResolvedValue({ isActive: true })
    service = createSandboxAuthorizationService({ redis, security, getUser, now: () => now })
  })

  test('model all/empty permissions grant no Sandbox access', async () => {
    for (const permissions of ['[]', 'all', '["claude","openai"]']) {
      redis.keys.get(KEY_ID).permissions = permissions
      await expect(service.verify(KEY)).rejects.toMatchObject({
        status: 403,
        code: 'sandbox_access_denied',
        keyId: KEY_ID
      })
    }
    expect(redis.set).not.toHaveBeenCalled()
  })

  test('Sandbox-only Key permissions still require an explicit grant', async () => {
    redis.keys.get(KEY_ID).permissions = '["sandbox"]'
    await expect(service.verify(KEY)).rejects.toMatchObject({
      status: 403,
      code: 'sandbox_access_denied'
    })
    await service.put(KEY_ID, grantInput())
    await expect(service.verify(KEY)).resolves.toMatchObject({
      active: true,
      caller_id: 'trusted-caller'
    })
  })

  test('only a verified active Key can discover its own identifier on grant denial', async () => {
    const before = JSON.stringify([...redis.keys])
    const denied = await service.verify(KEY).catch((error) => error)
    expect(denied).toMatchObject({ status: 403, keyId: KEY_ID })
    expect(JSON.stringify([...redis.keys])).toBe(before)
    expect(redis.set).not.toHaveBeenCalled()
    expect(redis.del).not.toHaveBeenCalled()
    for (const patch of [
      { isActive: 'false' },
      { isActive: 'true', expiresAt: '2025-01-01T00:00:00Z' },
      { expiresAt: '', expirationMode: 'activation', isActivated: 'false' }
    ]) {
      Object.assign(redis.keys.get(KEY_ID), patch)
      const invalid = await service.verify(KEY).catch((error) => error)
      expect(invalid.status).toBe(401)
      expect(invalid).not.toHaveProperty('keyId')
    }
    redis.hget.mockRejectedValue(new Error(KEY_ID))
    const unavailable = await service.verify(KEY).catch((error) => error)
    expect(unavailable.status).toBe(503)
    expect(unavailable).not.toHaveProperty('keyId')
  })

  test('explicit grant returns only safe metadata and does not touch model state', async () => {
    const written = await service.put(KEY_ID, grantInput())
    expect(written.version).toMatch(/^[a-f0-9]{64}$/)
    expect(await service.get(KEY_ID)).toEqual(written)
    redis.set.mockClear()
    const before = JSON.stringify([...redis.keys])
    const result = await service.verify(KEY)
    expect(result).toEqual({
      schema_version: 1,
      active: true,
      key_id: KEY_ID,
      caller_id: 'trusted-caller',
      expires_at: null,
      grant: {
        version: written.version,
        actions: grantInput().actions,
        allowed_images: ['python:3.11-slim'],
        allowed_ports: [44772],
        limits: grantInput().limits
      }
    })
    expect(await service.status(KEY_ID, result.grant.version)).toEqual({
      schema_version: 1,
      active: true
    })
    expect(JSON.stringify([...redis.keys])).toBe(before)
    expect(redis.set).not.toHaveBeenCalled()
    expect(redis.del).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(JSON.stringify(result)).not.toContain(hash(KEY))
    expect(JSON.stringify([...redis.grants])).not.toContain(KEY)
    // A strict fake exposes no model counters, costs, concurrency, or validators.
    expect(Object.keys(result).sort()).toEqual(
      ['schema_version', 'active', 'key_id', 'caller_id', 'expires_at', 'grant'].sort()
    )
  })

  test('accepts one bounded 256 GiB six-hour Sandbox grant but rejects larger limits', async () => {
    const limits = {
      max_sandboxes: 1,
      max_cpu_millis: 32000,
      max_memory_mib: 262144,
      max_ttl_seconds: 21600
    }
    const saved = await service.put(KEY_ID, { ...grantInput(), limits })
    expect(saved.limits).toEqual(limits)
    expect((await service.verify(KEY)).grant.limits).toEqual(limits)
    for (const excess of [
      { max_memory_mib: 262145 },
      { max_ttl_seconds: 21601 },
      { max_cpu_millis: 32001 }
    ]) {
      await expect(service.put(KEY_ID, { ...grantInput(), limits: { ...limits, ...excess } }))
        .rejects.toMatchObject({ status: 400 })
    }
  })

  test.each([
    { isActive: 'false' },
    { isDeleted: 'true' },
    { expirationMode: 'activation', isActivated: 'false' },
    { expiresAt: '2026-01-01T00:00:00Z' },
    { expiresAt: '2025-01-01T00:00:00Z' }
  ])('rejects lifecycle state without activation/writes: %p', async (patch) => {
    const granted = await service.put(KEY_ID, grantInput())
    Object.assign(redis.keys.get(KEY_ID), patch)
    redis.set.mockClear()
    const before = JSON.stringify([...redis.keys])
    await expect(service.verify(KEY)).rejects.toMatchObject({ status: 401 })
    expect(await service.status(KEY_ID, granted.version)).toEqual({
      schema_version: 1,
      active: false
    })
    expect(JSON.stringify([...redis.keys])).toBe(before)
    expect(redis.set).not.toHaveBeenCalled()
    expect(redis.del).not.toHaveBeenCalled()
  })

  test.each([null, '', 'not-a-key', `crsm_${'A'.repeat(43)}`, `${KEY}\n`, `cr_${'x'.repeat(513)}`])(
    'rejects invalid Key without storage: %p',
    async (key) => {
      await expect(service.verify(key)).rejects.toMatchObject({ status: 401 })
      expect(redis.hget).not.toHaveBeenCalled()
    }
  )

  test('reads legacy index without backfilling or removing stale entries', async () => {
    await service.put(KEY_ID, grantInput())
    redis.indexes.clear()
    redis.legacy.set(hash(KEY), { id: KEY_ID })
    redis.set.mockClear()
    expect((await service.verify(KEY)).active).toBe(true)
    expect(redis.indexes.size).toBe(0)
    expect(redis.set).not.toHaveBeenCalled()
    redis.keys.clear()
    await expect(service.verify(KEY)).rejects.toMatchObject({ status: 401 })
    expect(redis.legacy.has(hash(KEY))).toBe(true)
    expect(redis.del).not.toHaveBeenCalled()
  })

  test('rejects hash index pointing to a different credential', async () => {
    await service.put(KEY_ID, grantInput())
    redis.keys.get(KEY_ID).apiKey = hash('other-key')
    await expect(service.verify(KEY)).rejects.toMatchObject({ status: 401 })
  })

  test.each([null, { isActive: false }, { isActive: 'false' }])(
    'rejects disabled/missing user %p',
    async (user) => {
      await service.put(KEY_ID, grantInput())
      redis.keys.get(KEY_ID).userId = 'user-1'
      getUser.mockResolvedValue(user)
      await expect(service.verify(KEY)).rejects.toMatchObject({ status: 401 })
      expect(getUser).toHaveBeenCalledWith('user-1')
    }
  )

  test('fails closed and sanitizes backend/metadata errors', async () => {
    await service.put(KEY_ID, grantInput())
    redis.keys.get(KEY_ID).userId = 'user-1'
    getUser.mockRejectedValue(new Error(KEY))
    await expect(service.verify(KEY)).rejects.toMatchObject({
      status: 503,
      message: 'sandbox_authorization_unavailable'
    })
    getUser.mockResolvedValue({ isActive: true })
    redis.grants.set(`sandbox:grant:${KEY_ID}`, `corrupt ${KEY}`)
    await expect(service.verify(KEY)).rejects.toMatchObject({ status: 503 })
    await expect(service.status(KEY_ID, 'a'.repeat(64))).rejects.toMatchObject({ status: 503 })
    redis.get.mockRejectedValue(new Error(KEY))
    await expect(service.status(KEY_ID, 'a'.repeat(64))).rejects.toMatchObject({ status: 503 })
  })

  test('combines key and grant expiry at exact deadline', async () => {
    redis.keys.get(KEY_ID).expiresAt = '2026-01-01T00:20:00Z'
    const metadata = await service.put(KEY_ID, {
      ...grantInput(),
      expires_at: '2026-01-01T00:10:00Z'
    })
    expect((await service.verify(KEY)).expires_at).toBe('2026-01-01T00:10:00.000Z')
    now += 600000
    await expect(service.verify(KEY)).rejects.toMatchObject({ status: 403 })
    expect(await service.status(KEY_ID, metadata.version)).toEqual({
      schema_version: 1,
      active: false
    })
  })

  test('grant update, revocation, and same-ID Key rotation invalidate old versions', async () => {
    const first = await service.put(KEY_ID, grantInput())
    const changed = await service.put(KEY_ID, { ...grantInput(), allowed_ports: [44772, 8080] })
    expect(changed.version).not.toBe(first.version)
    expect(await service.status(KEY_ID, first.version)).toEqual({
      schema_version: 1,
      active: false
    })
    expect(await service.status(KEY_ID, changed.version)).toEqual({
      schema_version: 1,
      active: true
    })
    const nextKey = `cr_${'2'.repeat(64)}`
    redis.indexes.delete(hash(KEY))
    redis.indexes.set(hash(nextKey), KEY_ID)
    redis.keys.get(KEY_ID).apiKey = hash(nextKey)
    expect(await service.status(KEY_ID, changed.version)).toEqual({
      schema_version: 1,
      active: false
    })
    const rotated = await service.verify(nextKey)
    expect(rotated.caller_id).toBe(first.caller_id)
    expect(rotated.grant.version).not.toBe(changed.version)
    await service.revoke(KEY_ID)
    expect(await service.status(KEY_ID, rotated.grant.version)).toEqual({
      schema_version: 1,
      active: false
    })
    await expect(service.verify(nextKey)).rejects.toMatchObject({ status: 403 })
    expect(await service.revoke(KEY_ID)).toMatchObject({ key_id: KEY_ID, revoked: false })
  })

  test('status exposes only one boolean for missing, malformed and mismatched capabilities', async () => {
    await service.put(KEY_ID, grantInput())
    for (const [id, version] of [
      ['missing', 'a'.repeat(64)],
      [KEY_ID, 'a'.repeat(64)],
      ['../key', 'a'.repeat(64)],
      [KEY_ID, null]
    ]) {
      expect(await service.status(id, version)).toEqual({ schema_version: 1, active: false })
    }
  })

  test.each([
    { actions: [] },
    { actions: ['all'] },
    { caller_id: '../owner' },
    { allowed_images: ['*'] },
    { allowed_ports: [0] },
    { allowed_ports: ['44772'] },
    { enabled: 'true' },
    { other: 'claim' },
    { expires_at: 'invalid' },
    { expires_at: '' },
    { expires_at: '2025-01-01T00:00:00Z' },
    { limits: { ...grantInput().limits, max_sandboxes: 0 } },
    { limits: { ...grantInput().limits, max_cpu_millis: 1.5 } },
    { limits: { ...grantInput().limits, extra: 2 } }
  ])('rejects invalid grant %p before write', async (patch) => {
    await expect(service.put(KEY_ID, { ...grantInput(), ...patch })).rejects.toMatchObject({
      status: 400
    })
    expect(redis.set).not.toHaveBeenCalled()
  })

  test('unknown/deleted keys cannot receive grants, corrupt expiry fails closed', async () => {
    await expect(service.put('missing', grantInput())).rejects.toMatchObject({ status: 404 })
    redis.keys.get(KEY_ID).isDeleted = 'true'
    await expect(service.put(KEY_ID, grantInput())).rejects.toMatchObject({ status: 404 })
    delete redis.keys.get(KEY_ID).isDeleted
    redis.keys.get(KEY_ID).expiresAt = 'corrupt'
    await expect(service.verify(KEY)).rejects.toMatchObject({ status: 503 })
    expect(new SandboxAuthorizationError('private backend error').message).toBe(
      'sandbox_authorization_unavailable'
    )
  })

  test('a corrupt credential cannot produce an ambiguous applied grant', async () => {
    redis.keys.get(KEY_ID).apiKey = 'corrupt'
    await expect(service.put(KEY_ID, grantInput())).rejects.toMatchObject({ status: 503 })
    expect(redis.set).not.toHaveBeenCalled()
  })
})
