const express = require('express')
const {
  createSandboxAuthorizationService,
  SandboxAuthorizationError,
  sendSandboxAuthorizationError
} = require('../../services/sandboxAuthorizationService')
const { readSandboxKey } = require('../sandboxAuthorization')

function createSandboxGrantsRouter({ service, authenticateAdmin } = {}) {
  const grants = service || createSandboxAuthorizationService()
  const admin =
    authenticateAdmin || ((...args) => require('../../middleware/auth').authenticateAdmin(...args))
  const router = express.Router()
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    try {
      // Explicit Admin Bearer is required. A cookie-only request cannot grant
      // access; model Keys and dedicated Codex management Keys never fall back.
      if (req.headers['x-api-key'] !== undefined || req.headers['x-admin-token'] !== undefined) {
        throw new SandboxAuthorizationError('invalid_sandbox_key')
      }
      const token = readSandboxKey(req)
      if (/^cr(sm)?_/.test(token)) {
        throw new SandboxAuthorizationError('invalid_sandbox_key')
      }
      return await admin(req, res, next)
    } catch (error) {
      return sendSandboxAuthorizationError(res, error)
    }
  })
  const handle = (operation) => async (req, res) => {
    try {
      return res.json({ success: true, data: await operation(req) })
    } catch (error) {
      return sendSandboxAuthorizationError(res, error)
    }
  }
  router.get(
    '/:keyId',
    handle((req) => grants.get(req.params.keyId))
  )
  router.put(
    '/:keyId',
    handle((req) => grants.put(req.params.keyId, req.body))
  )
  router.delete(
    '/:keyId',
    handle((req) => grants.revoke(req.params.keyId))
  )
  return router
}

module.exports = { createSandboxGrantsRouter }
