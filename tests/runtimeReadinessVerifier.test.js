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
      if (req.url === '/health')
        return send(res, 200, '{"status":"healthy"}', { 'content-type': 'application/json' })
      if (req.url === '/') return send(res, 302, '', { location: '/admin-next/api-stats' })
      if (req.url === '/web') return send(res, 302, '', { location: '/admin-next/api-stats' })
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
      if (req.url === '/health') return send(res, 200, '{"status":"healthy"}')
      if (req.url === '/') return send(res, 302, '', { location: '/admin-next/api-stats' })
      if (req.url === '/web') return send(res, 302, '', { location: '/admin-next/api-stats' })
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
          expect.objectContaining({ name: 'health endpoint returns 200', ok: true }),
          expect.objectContaining({ name: 'admin SPA HTML is served', ok: false })
        ])
      )
    } finally {
      await server.close()
    }
  })

  test('fails when Images API route is absent even if web is healthy', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/health') return send(res, 200, '{"status":"healthy"}')
      if (req.url === '/') return send(res, 302, '', { location: '/admin-next/api-stats' })
      if (req.url === '/web') return send(res, 302, '', { location: '/admin-next/api-stats' })
      if (req.url === '/admin-next/') {
        return send(
          res,
          200,
          '<html><body><div id="app"></div><script src="/admin-next/assets/app.js"></script></body></html>'
        )
      }
      if (req.url === '/admin-next/assets/app.js')
        return send(res, 200, 'console.log("ok")', { 'content-type': 'application/javascript' })
      if (req.url === '/openai/v1/responses') return send(res, 401, '{"error":"missing auth"}')
      if (req.url === '/openai/v1/images/generations') return send(res, 404, 'not found')
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
})
