const http = require('http')
const { extractAdminAssets, runReadinessChecks } = require('../scripts/verify-runtime-readiness')

function startServer(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers)
  res.end(body)
}

describe('runtime readiness verifier', () => {
  test('extracts admin SPA JS and CSS assets', () => {
    const html =
      '<html><head><link href="/admin-next/assets/app.css" rel="stylesheet"></head><body><script src="/admin-next/assets/app.js"></script></body></html>'
    expect(extractAdminAssets(html)).toEqual([
      '/admin-next/assets/app.css',
      '/admin-next/assets/app.js'
    ])
  })

  test('passes only when health, web assets, and auth-required API routes are present', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/health') {
        return send(res, 200, '{"status":"healthy"}', { 'content-type': 'application/json' })
      }
      if (req.url === '/') {
        return send(res, 302, '', { location: '/admin-next/api-stats' })
      }
      if (req.url === '/web') {
        return send(res, 302, '', { location: '/admin-next/api-stats' })
      }
      if (req.url === '/admin-next/') {
        return send(
          res,
          200,
          '<html><body><div id="app"></div><script src="/admin-next/assets/app.js"></script></body></html>',
          { 'content-type': 'text/html' }
        )
      }
      if (req.url === '/admin-next/assets/app.js') {
        return send(res, 200, 'console.log("ok")', { 'content-type': 'application/javascript' })
      }
      if (req.url === '/openai/v1/responses' || req.url === '/openai/v1/images/generations') {
        return send(res, 401, '{"error":"missing auth"}', { 'content-type': 'application/json' })
      }
      return send(res, 404, 'not found')
    })

    try {
      const summary = await runReadinessChecks({ baseUrl: server.baseUrl, timeoutMs: 1000 })
      expect(summary.ok).toBe(true)
      expect(summary.checks.map((check) => check.name)).toContain('admin SPA HTML is served')
      expect(summary.checks.map((check) => check.name)).toContain(
        'OpenAI images route is mounted and requires auth'
      )
    } finally {
      await server.close()
    }
  })

  test('fails when admin SPA dist is missing even if health passes', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/health') {
        return send(res, 200, '{"status":"healthy"}')
      }
      if (req.url === '/') {
        return send(res, 302, '', { location: '/admin-next/api-stats' })
      }
      if (req.url === '/web') {
        return send(res, 302, '', { location: '/admin-next/api-stats' })
      }
      if (req.url === '/openai/v1/responses' || req.url === '/openai/v1/images/generations') {
        return send(res, 401, '{"error":"missing auth"}')
      }
      return send(res, 404, 'not found')
    })

    try {
      const summary = await runReadinessChecks({ baseUrl: server.baseUrl, timeoutMs: 1000 })
      expect(summary.ok).toBe(false)
      expect(summary.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'health endpoint returns healthy status', ok: true }),
          expect.objectContaining({ name: 'admin SPA HTML is served', ok: false })
        ])
      )
    } finally {
      await server.close()
    }
  })

  test('fails when Images API route is absent even if web is healthy', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/health') {
        return send(res, 200, '{"status":"healthy"}')
      }
      if (req.url === '/') {
        return send(res, 302, '', { location: '/admin-next/api-stats' })
      }
      if (req.url === '/web') {
        return send(res, 302, '', { location: '/admin-next/api-stats' })
      }
      if (req.url === '/admin-next/') {
        return send(
          res,
          200,
          '<html><body><div id="app"></div><script src="/admin-next/assets/app.js"></script></body></html>'
        )
      }
      if (req.url === '/admin-next/assets/app.js') {
        return send(res, 200, 'console.log("ok")', { 'content-type': 'application/javascript' })
      }
      if (req.url === '/openai/v1/responses') {
        return send(res, 401, '{"error":"missing auth"}')
      }
      if (req.url === '/openai/v1/images/generations') {
        return send(res, 404, 'not found')
      }
      return send(res, 404, 'not found')
    })

    try {
      const summary = await runReadinessChecks({ baseUrl: server.baseUrl, timeoutMs: 1000 })
      expect(summary.ok).toBe(false)
      expect(summary.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'OpenAI images route is mounted and requires auth',
            ok: false,
            status: 404
          })
        ])
      )
    } finally {
      await server.close()
    }
  })

  test('fails when health endpoint reports an unhealthy component with HTTP 200', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/health') {
        return send(
          res,
          200,
          JSON.stringify({
            status: 'healthy',
            components: { redis: { status: 'unhealthy' }, logger: { status: 'healthy' } }
          }),
          { 'content-type': 'application/json' }
        )
      }
      if (req.url === '/') {
        return send(res, 302, '', { location: '/admin-next/api-stats' })
      }
      if (req.url === '/web') {
        return send(res, 302, '', { location: '/admin-next/api-stats' })
      }
      if (req.url === '/admin-next/') {
        return send(
          res,
          200,
          '<html><body><div id="app"></div><script src="/admin-next/assets/app.js"></script></body></html>'
        )
      }
      if (req.url === '/admin-next/assets/app.js') {
        return send(res, 200, 'console.log("ok")', { 'content-type': 'application/javascript' })
      }
      if (req.url === '/openai/v1/responses' || req.url === '/openai/v1/images/generations') {
        return send(res, 401, '{"error":"missing auth"}')
      }
      return send(res, 404, 'not found')
    })

    try {
      const summary = await runReadinessChecks({ baseUrl: server.baseUrl, timeoutMs: 1000 })
      expect(summary.ok).toBe(false)
      expect(summary.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'health endpoint returns healthy status',
            ok: false,
            unhealthyComponents: ['redis:unhealthy']
          })
        ])
      )
    } finally {
      await server.close()
    }
  })

  test('fails when any referenced admin SPA asset is missing', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/health') {
        return send(res, 200, '{"status":"healthy"}')
      }
      if (req.url === '/') {
        return send(res, 302, '', { location: '/admin-next/api-stats' })
      }
      if (req.url === '/web') {
        return send(res, 302, '', { location: '/admin-next/api-stats' })
      }
      if (req.url === '/admin-next/') {
        return send(
          res,
          200,
          '<html><head><link href="assets/app.css" rel="stylesheet"></head><body><div id="app"></div><script src="assets/app.js"></script><script src="assets/vendor.js"></script><script src="assets/missing.js"></script></body></html>'
        )
      }
      if (
        req.url === '/admin-next/assets/app.css' ||
        req.url === '/admin-next/assets/app.js' ||
        req.url === '/admin-next/assets/vendor.js'
      ) {
        return send(res, 200, 'ok', { 'content-type': 'application/javascript' })
      }
      if (req.url === '/admin-next/assets/missing.js') {
        return send(res, 404, 'not found')
      }
      if (req.url === '/openai/v1/responses' || req.url === '/openai/v1/images/generations') {
        return send(res, 401, '{"error":"missing auth"}')
      }
      return send(res, 404, 'not found')
    })

    try {
      const summary = await runReadinessChecks({ baseUrl: server.baseUrl, timeoutMs: 1000 })
      expect(summary.ok).toBe(false)
      expect(summary.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'admin asset reachable: assets/missing.js',
            ok: false,
            status: 404
          })
        ])
      )
    } finally {
      await server.close()
    }
  })
})
