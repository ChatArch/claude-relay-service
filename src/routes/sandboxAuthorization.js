const express = require('express')
const {
  createSandboxAuthorizationService,
  SandboxAuthorizationError,
  sendSandboxAuthorizationError
} = require('../services/sandboxAuthorizationService')

function readSandboxKey(req) {
  for (const header of ['authorization', 'x-api-key']) {
    let count = 0
    for (let i = 0; i < (req.rawHeaders || []).length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === header) {
        count++
      }
    }
    if (count > 1) {
      throw new SandboxAuthorizationError('invalid_sandbox_key')
    }
  }
  const { authorization } = req.headers
  const xKey = req.headers['x-api-key']
  const bearer =
    typeof authorization === 'string' ? authorization.match(/^Bearer ([^\s,]+)$/i)?.[1] : undefined
  if (
    (authorization !== undefined && !bearer) ||
    (xKey !== undefined && typeof xKey !== 'string') ||
    (xKey !== undefined && bearer !== undefined && xKey !== bearer) ||
    !(xKey || bearer)
  ) {
    throw new SandboxAuthorizationError('invalid_sandbox_key')
  }
  return xKey === undefined ? bearer : xKey
}

// This limiter is separate from every model budget and retains no credentials.
// Bounded per-process IP buckets are a coarse abuse guard, not Sandbox quotas.
function createVerificationLimiter({
  now = Date.now,
  requests = 600,
  windowMs = 60000,
  maxIps = 1024
} = {}) {
  const buckets = new Map()
  return (req, res, next) => {
    const timestamp = now()
    for (const [ip, bucket] of buckets) {
      if (bucket.reset <= timestamp) {
        buckets.delete(ip)
      }
    }
    const ip = req.ip || req.socket?.remoteAddress || 'unknown'
    let bucket = buckets.get(ip)
    if (!bucket) {
      if (buckets.size >= maxIps) {
        return res.status(429).json({ active: false, error: 'sandbox_verification_rate_limited' })
      }
      bucket = { count: 0, reset: timestamp + windowMs }
      buckets.set(ip, bucket)
    }
    bucket.count++
    if (bucket.count > requests) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.reset - timestamp) / 1000))))
      return res.status(429).json({ active: false, error: 'sandbox_verification_rate_limited' })
    }
    return next()
  }
}

function createSandboxVerificationRouter({ service, limiter } = {}) {
  const authorization = service || createSandboxAuthorizationService()
  const router = express.Router()
  const rateLimit = limiter || createVerificationLimiter()
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    res.set('X-Content-Type-Options', 'nosniff')
    next()
  })
  const body = [
    rateLimit,
    (req, res, next) => {
      if (
        (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0) &&
        !req.is('application/json')
      ) {
        return res.status(415).json({ active: false, error: 'sandbox_json_required' })
      }
      return next()
    },
    express.json({ limit: '2kb', strict: true })
  ]
  router.post('/verify', ...body, async (req, res) => {
    try {
      if (
        Object.keys(req.query || {}).length ||
        (req.body !== undefined &&
          (!req.body ||
            typeof req.body !== 'object' ||
            Array.isArray(req.body) ||
            Object.keys(req.body).length))
      ) {
        return res
          .status(400)
          .json({ active: false, error: 'invalid_sandbox_verification_request' })
      }
      return res.json(await authorization.verify(readSandboxKey(req)))
    } catch (error) {
      return sendSandboxAuthorizationError(res, error)
    }
  })
  router.post('/status', ...body, async (req, res) => {
    try {
      if (
        Object.keys(req.query || {}).length ||
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => !['key_id', 'grant_version'].includes(key))
      ) {
        return res
          .status(400)
          .json({ schema_version: 1, active: false, error: 'invalid_sandbox_status_request' })
      }
      return res.json(await authorization.status(req.body.key_id, req.body.grant_version))
    } catch (error) {
      return sendSandboxAuthorizationError(res, error)
    }
  })
  router.use((error, _req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : 400
    return res.status(status).json({ active: false, error: 'invalid_sandbox_verification_request' })
  })
  return router
}

module.exports = { createSandboxVerificationRouter, createVerificationLimiter, readSandboxKey }
