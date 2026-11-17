const crypto = require('crypto')

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const DIGEST = /^[a-f0-9]{64}$/
const ACTIONS = Object.freeze([
  'create',
  'list',
  'connect',
  'exec',
  'files',
  'renew',
  'delete',
  'ports'
])
const PREFIX = 'sandbox:grant:'
const ERROR_STATUS = Object.freeze({
  invalid_sandbox_key: 401,
  sandbox_access_denied: 403,
  invalid_sandbox_grant: 400,
  sandbox_grant_not_found: 404,
  sandbox_authorization_unavailable: 503
})

class SandboxAuthorizationError extends Error {
  constructor(code) {
    const safe = Object.hasOwn(ERROR_STATUS, code) ? code : 'sandbox_authorization_unavailable'
    super(safe)
    this.name = 'SandboxAuthorizationError'
    this.code = safe
    this.status = ERROR_STATUS[safe]
  }
}

function sendSandboxAuthorizationError(res, error) {
  const safe = error instanceof SandboxAuthorizationError ? error : new SandboxAuthorizationError()
  return res.status(safe.status).json({ active: false, error: safe.code })
}

function checkId(value) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new SandboxAuthorizationError('invalid_sandbox_grant')
  }
  return value
}

function expiry(value, invalidCode) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new SandboxAuthorizationError(invalidCode)
  }
  return new Date(value).toISOString()
}

function validateGrant(input) {
  const invalid = () => {
    throw new SandboxAuthorizationError('invalid_sandbox_grant')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid()
  }
  const names = [
    'enabled',
    'caller_id',
    'actions',
    'allowed_images',
    'allowed_ports',
    'limits',
    'expires_at'
  ]
  if (
    Object.keys(input).some((key) => !names.includes(key)) ||
    typeof input.enabled !== 'boolean'
  ) {
    invalid()
  }
  const caller_id = checkId(input.caller_id)
  const { actions } = input
  if (
    !Array.isArray(actions) ||
    !actions.length ||
    actions.length > ACTIONS.length ||
    actions.some((action) => !ACTIONS.includes(action))
  ) {
    invalid()
  }
  const images = input.allowed_images
  if (
    !Array.isArray(images) ||
    !images.length ||
    images.length > 32 ||
    images.some(
      (image) =>
        typeof image !== 'string' ||
        image.length > 512 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image)
    )
  ) {
    invalid()
  }
  const ports = input.allowed_ports
  if (
    !Array.isArray(ports) ||
    !ports.length ||
    ports.length > 32 ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    invalid()
  }
  if (input.expires_at === '') {
    invalid()
  }
  const { limits } = input
  const bounds = {
    max_sandboxes: [1, 32],
    max_cpu_millis: [1, 32000],
    max_memory_mib: [128, 98304],
    max_ttl_seconds: [60, 7200]
  }
  if (
    !limits ||
    typeof limits !== 'object' ||
    Array.isArray(limits) ||
    Object.keys(limits).length !== Object.keys(bounds).length ||
    Object.entries(bounds).some(
      ([key, [min, max]]) =>
        !Number.isInteger(limits[key]) || limits[key] < min || limits[key] > max
    )
  ) {
    invalid()
  }
  return {
    enabled: input.enabled,
    caller_id,
    actions: [...new Set(actions)],
    allowed_images: [...new Set(images)],
    allowed_ports: [...new Set(ports)],
    limits: { ...limits },
    expires_at: expiry(input.expires_at, 'invalid_sandbox_grant')
  }
}

function createSandboxAuthorizationService({ redis, security, getUser, now = Date.now } = {}) {
  const provider = () => redis || require('../models/redis')
  const client = () => {
    const store = provider()
    return typeof store.getClientSafe === 'function' ? store.getClientSafe() : store
  }
  const settings = () => security || require('../../config/config').security
  const readUser = getUser || ((id) => require('./userService').getUserById(id, false))
  const safe =
    (fn) =>
    async (...args) => {
      try {
        return await fn(...args)
      } catch (error) {
        if (error instanceof SandboxAuthorizationError) {
          throw error
        }
        // Never retain/return a caller Key or a backend exception's text.
        throw new SandboxAuthorizationError()
      }
    }
  const readGrant = async (db, keyId) => {
    const raw = await db.get(PREFIX + keyId)
    if (!raw) {
      return null
    }
    try {
      const record = JSON.parse(raw)
      const { version, updated_at, ...input } = record
      checkId(version)
      if (!updated_at || !Number.isFinite(Date.parse(updated_at))) {
        throw new Error('Invalid metadata')
      }
      return { ...validateGrant(input), version, updated_at }
    } catch {
      throw new SandboxAuthorizationError()
    }
  }
  const readKey = async (db, keyId) => {
    const record = await db.hgetall(`apikey:${keyId}`)
    return record && Object.keys(record).length ? record : null
  }
  const publicVersion = (keyId, key, grant) => {
    if (!DIGEST.test(key.apiKey || '')) {
      throw new SandboxAuthorizationError()
    }
    return crypto
      .createHmac('sha256', settings().encryptionKey)
      .update(JSON.stringify(['sandbox-grant-version-v1', keyId, key.apiKey, grant.version]))
      .digest('hex')
  }
  const keyState = async (record) => {
    if (
      !record ||
      record.isActive !== 'true' ||
      record.isDeleted === 'true' ||
      (record.expirationMode === 'activation' && record.isActivated !== 'true')
    ) {
      return { active: false }
    }
    const expires_at = expiry(record.expiresAt, 'sandbox_authorization_unavailable')
    if (expires_at && Date.parse(expires_at) <= now()) {
      return { active: false }
    }
    if (record.userId) {
      const user = await readUser(record.userId)
      if (!user || user.isActive !== true) {
        return { active: false }
      }
    }
    return { active: true, expires_at }
  }
  const grantActive = (grant) =>
    grant && grant.enabled && (!grant.expires_at || Date.parse(grant.expires_at) > now())
  const findId = async (db, digest) => {
    const indexed = await db.hget('apikey:hash_map', digest)
    return indexed || (await db.hgetall(`apikey_hash:${digest}`))?.id
  }

  return {
    verify: safe(async (key) => {
      const config = settings()
      if (
        typeof key !== 'string' ||
        key.length > 512 ||
        !key.startsWith(config.apiKeyPrefix) ||
        !/^[\x21-\x7e]+$/.test(key)
      ) {
        throw new SandboxAuthorizationError('invalid_sandbox_key')
      }
      const db = client()
      const digest = crypto
        .createHash('sha256')
        .update(key + config.encryptionKey)
        .digest('hex')
      // Read both supported indexes without calling the model lookup, which
      // backfills/deletes indexes and whose validator can activate a Key.
      const keyId = await findId(db, digest)
      if (typeof keyId !== 'string' || !ID.test(keyId)) {
        throw new SandboxAuthorizationError('invalid_sandbox_key')
      }
      const record = await readKey(db, keyId)
      if (
        !record ||
        !DIGEST.test(record.apiKey || '') ||
        !crypto.timingSafeEqual(Buffer.from(record.apiKey), Buffer.from(digest))
      ) {
        throw new SandboxAuthorizationError('invalid_sandbox_key')
      }
      const state = await keyState(record)
      if (!state.active) {
        throw new SandboxAuthorizationError('invalid_sandbox_key')
      }
      const grant = await readGrant(db, keyId)
      if (!grantActive(grant)) {
        throw new SandboxAuthorizationError('sandbox_access_denied')
      }
      const dates = [state.expires_at, grant.expires_at].filter(Boolean)
      const expires_at = dates.length
        ? new Date(Math.min(...dates.map(Date.parse))).toISOString()
        : null
      return {
        schema_version: 1,
        active: true,
        key_id: keyId,
        caller_id: grant.caller_id,
        expires_at,
        grant: {
          version: publicVersion(keyId, record, grant),
          actions: grant.actions,
          allowed_images: grant.allowed_images,
          allowed_ports: grant.allowed_ports,
          limits: grant.limits
        }
      }
    }),
    status: safe(async (keyId, version) => {
      const inactive = { schema_version: 1, active: false }
      if (
        typeof keyId !== 'string' ||
        !ID.test(keyId) ||
        typeof version !== 'string' ||
        !DIGEST.test(version)
      ) {
        return inactive
      }
      const db = client()
      const record = await readKey(db, keyId)
      if (!(await keyState(record)).active) {
        return inactive
      }
      if (!DIGEST.test(record.apiKey || '') || (await findId(db, record.apiKey)) !== keyId) {
        return inactive
      }
      const grant = await readGrant(db, keyId)
      if (!grantActive(grant)) {
        return inactive
      }
      return {
        schema_version: 1,
        active: crypto.timingSafeEqual(
          Buffer.from(version),
          Buffer.from(publicVersion(keyId, record, grant))
        )
      }
    }),
    get: safe(async (keyId) => {
      checkId(keyId)
      const db = client()
      const grant = await readGrant(db, keyId)
      const key = await readKey(db, keyId)
      if (!grant || !key) {
        throw new SandboxAuthorizationError('sandbox_grant_not_found')
      }
      return { key_id: keyId, ...grant, version: publicVersion(keyId, key, grant) }
    }),
    put: safe(async (keyId, input) => {
      checkId(keyId)
      const grant = validateGrant(input)
      if (grant.expires_at && Date.parse(grant.expires_at) <= now()) {
        throw new SandboxAuthorizationError('invalid_sandbox_grant')
      }
      const db = client()
      const key = await readKey(db, keyId)
      if (!key || key.isDeleted === 'true') {
        throw new SandboxAuthorizationError('sandbox_grant_not_found')
      }
      const record = {
        ...grant,
        version: crypto.randomUUID(),
        updated_at: new Date(now()).toISOString()
      }
      const version = publicVersion(keyId, key, record)
      await db.set(PREFIX + keyId, JSON.stringify(record))
      return { key_id: keyId, ...record, version }
    }),
    revoke: safe(async (keyId) => {
      checkId(keyId)
      const removed = await client().del(PREFIX + keyId)
      return {
        key_id: keyId,
        revoked: removed > 0,
        version: crypto.randomBytes(32).toString('hex')
      }
    })
  }
}

module.exports = {
  ACTIONS,
  createSandboxAuthorizationService,
  SandboxAuthorizationError,
  sendSandboxAuthorizationError
}
