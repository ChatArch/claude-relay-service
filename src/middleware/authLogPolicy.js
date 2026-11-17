// Credential endpoints never enter a request/response debug interceptor.
function sensitiveAuthPrefix(req) {
  let path = (req.originalUrl || req.url || '').split('?')[0]
  try {
    path = decodeURIComponent(path)
  } catch {
    // Preserve the raw path for classification of malformed requests.
  }
  path = path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
  const match = path.match(/^\/(web\/auth|auth\/sandbox)(?:\/|$)/)
  return match ? `/${match[1]}` : null
}

function isSensitiveAuthRequest(req) {
  return sensitiveAuthPrefix(req) !== null
}

function authLogUrl(req) {
  const prefix = sensitiveAuthPrefix(req)
  return prefix ? `${prefix}/[omitted-sensitive-auth]` : req.originalUrl
}

function skipSensitiveAuthLogging(interceptor) {
  return (req, res, next) => (isSensitiveAuthRequest(req) ? next() : interceptor(req, res, next))
}

module.exports = { isSensitiveAuthRequest, authLogUrl, skipSensitiveAuthLogging }
