#!/usr/bin/env node

const http = require('http')
const https = require('https')
const { URL } = require('url')

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.CRS_BASE_URL || 'http://127.0.0.1:3000',
    timeoutMs: Number(process.env.CRS_READINESS_TIMEOUT_MS || 5000),
    json: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--base-url') {
      args.baseUrl = argv[i + 1]
      i += 1
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[i + 1])
      i += 1
    } else if (arg === '--json') {
      args.json = true
    } else if (arg === '-h' || arg === '--help') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function printHelp() {
  console.log(`Usage: node scripts/verify-runtime-readiness.js [options]

Checks a running CRS instance before it is considered eligible for traffic.
This intentionally covers both Web and API surfaces so /health alone cannot
be mistaken for production readiness.

Options:
  --base-url URL      CRS base URL, default: CRS_BASE_URL or http://127.0.0.1:3000
  --timeout-ms N      per-request timeout, default: CRS_READINESS_TIMEOUT_MS or 5000
  --json              print machine-readable JSON
  -h, --help          show this help
`)
}

function joinUrl(baseUrl, path) {
  const base = new URL(baseUrl)
  return new URL(path, base).toString()
}

function requestUrl(url, options = {}) {
  const method = options.method || 'GET'
  const timeoutMs = options.timeoutMs || 5000
  const body = options.body || null
  const headers = options.headers || {}

  return new Promise((resolve) => {
    const parsed = new URL(url)
    const client = parsed.protocol === 'https:' ? https : http
    const req = client.request(
      parsed,
      {
        method,
        timeout: timeoutMs,
        headers: {
          'user-agent': 'crs-runtime-readiness/1.0',
          ...headers
        }
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`))
    })
    req.on('error', (error) => {
      resolve({ ok: false, status: 0, headers: {}, body: '', error: error.message })
    })

    if (body) {
      req.write(body)
    }
    req.end()
  })
}

function result(name, ok, details = {}) {
  return { name, ok, ...details }
}

function extractAdminAssets(html) {
  const assets = new Set()
  const attrRegex = /(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/gi
  let match
  while ((match = attrRegex.exec(html))) {
    assets.add(match[1])
  }
  return Array.from(assets).slice(0, 6)
}

async function checkHealth(baseUrl, timeoutMs) {
  const response = await requestUrl(joinUrl(baseUrl, '/health'), { timeoutMs })
  return result('health endpoint returns 200', response.ok && response.status === 200, {
    status: response.status,
    error: response.error
  })
}

async function checkRootRedirect(baseUrl, timeoutMs) {
  const response = await requestUrl(joinUrl(baseUrl, '/'), { timeoutMs })
  const location = response.headers.location || ''
  const ok = response.ok && [200, 301, 302, 303, 307, 308].includes(response.status)
  return result('root route is reachable or redirects', ok, {
    status: response.status,
    location,
    error: response.error
  })
}

async function checkAdminSpa(baseUrl, timeoutMs) {
  const response = await requestUrl(joinUrl(baseUrl, '/admin-next/'), { timeoutMs })
  const assets = response.ok && response.status === 200 ? extractAdminAssets(response.body) : []
  const looksLikeHtml =
    /<html[\s>]/i.test(response.body) || /<div\s+id=["']app["']/i.test(response.body)

  if (!(response.ok && response.status === 200 && looksLikeHtml)) {
    return [
      result('admin SPA HTML is served', false, {
        status: response.status,
        error: response.error || 'admin HTML missing or not HTML'
      })
    ]
  }

  const results = [
    result('admin SPA HTML is served', true, {
      status: response.status,
      assetCount: assets.length
    })
  ]

  if (assets.length === 0) {
    results.push(result('admin SPA references JS/CSS assets', false, { assetCount: 0 }))
    return results
  }

  for (const asset of assets.slice(0, 3)) {
    const assetUrl = asset.startsWith('http') ? asset : joinUrl(baseUrl, asset)
    const assetResponse = await requestUrl(assetUrl, { timeoutMs })
    const contentType = assetResponse.headers['content-type'] || ''
    const ok =
      assetResponse.ok && assetResponse.status === 200 && !contentType.includes('text/html')
    results.push(
      result(`admin asset reachable: ${asset}`, ok, {
        status: assetResponse.status,
        contentType,
        error: assetResponse.error
      })
    )
  }

  return results
}

async function checkWebRedirect(baseUrl, timeoutMs) {
  const response = await requestUrl(joinUrl(baseUrl, '/web'), { timeoutMs })
  const ok = response.ok && [200, 301, 302, 303, 307, 308].includes(response.status)
  return result('legacy /web route is reachable or redirects', ok, {
    status: response.status,
    location: response.headers.location || '',
    error: response.error
  })
}

async function checkImagesRouteRequiresAuth(baseUrl, timeoutMs) {
  const body = JSON.stringify({
    model: 'gpt-image-2',
    prompt: 'readiness smoke, no upstream call should happen without auth',
    size: '1024x1024',
    quality: 'low',
    n: 1
  })
  const response = await requestUrl(joinUrl(baseUrl, '/openai/v1/images/generations'), {
    method: 'POST',
    timeoutMs,
    body,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    }
  })
  const ok = response.ok && [401, 403].includes(response.status)
  return result('OpenAI images route is mounted and requires auth', ok, {
    status: response.status,
    error: response.error || (response.status === 404 ? 'route returned 404' : undefined)
  })
}

async function checkResponsesRouteRequiresAuth(baseUrl, timeoutMs) {
  const body = JSON.stringify({ model: 'gpt-5', input: 'readiness smoke' })
  const response = await requestUrl(joinUrl(baseUrl, '/openai/v1/responses'), {
    method: 'POST',
    timeoutMs,
    body,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    }
  })
  const ok = response.ok && [401, 403].includes(response.status)
  return result('OpenAI responses route is mounted and requires auth', ok, {
    status: response.status,
    error: response.error || (response.status === 404 ? 'route returned 404' : undefined)
  })
}

async function runReadinessChecks(options = {}) {
  const baseUrl = options.baseUrl || 'http://127.0.0.1:3000'
  const timeoutMs = options.timeoutMs || 5000

  const checks = []
  checks.push(await checkHealth(baseUrl, timeoutMs))
  checks.push(await checkRootRedirect(baseUrl, timeoutMs))
  checks.push(...(await checkAdminSpa(baseUrl, timeoutMs)))
  checks.push(await checkWebRedirect(baseUrl, timeoutMs))
  checks.push(await checkResponsesRouteRequiresAuth(baseUrl, timeoutMs))
  checks.push(await checkImagesRouteRequiresAuth(baseUrl, timeoutMs))

  return {
    baseUrl,
    ok: checks.every((check) => check.ok),
    checks
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const summary = await runReadinessChecks({ baseUrl: args.baseUrl, timeoutMs: args.timeoutMs })
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(`CRS runtime readiness: ${summary.baseUrl}`)
    for (const check of summary.checks) {
      const marker = check.ok ? '✅' : '❌'
      const status = check.status ? ` status=${check.status}` : ''
      const error = check.error ? ` error=${check.error}` : ''
      console.log(`${marker} ${check.name}${status}${error}`)
    }
  }

  if (!summary.ok) {
    process.exitCode = 1
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = {
  extractAdminAssets,
  runReadinessChecks,
  requestUrl
}
