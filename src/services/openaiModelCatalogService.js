const axios = require('axios')
const logger = require('../utils/logger')
const ProxyHelper = require('../utils/proxyHelper')
const unifiedOpenAIScheduler = require('./scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('./account/openaiAccountService')
const openaiResponsesAccountService = require('./account/openaiResponsesAccountService')

const DEFAULT_CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
const DEFAULT_CLIENT_VERSION = '1.0.0'
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULT_REQUEST_TIMEOUT_MS = 5000

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const CODEX_MODELS_URL = process.env.OPENAI_CODEX_MODELS_URL || DEFAULT_CODEX_MODELS_URL
const CODEX_CLIENT_VERSION = process.env.OPENAI_CODEX_CLIENT_VERSION || DEFAULT_CLIENT_VERSION
const CACHE_TTL_MS = parsePositiveInteger(
  process.env.OPENAI_MODELS_CACHE_TTL_MS,
  DEFAULT_CACHE_TTL_MS
)
const REQUEST_TIMEOUT_MS = parsePositiveInteger(
  process.env.OPENAI_MODELS_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS
)

function normalizeModelEntries(payload) {
  const entries = Array.isArray(payload?.models)
    ? payload.models
    : Array.isArray(payload?.data)
      ? payload.data
      : []
  const now = Math.floor(Date.now() / 1000)
  const seen = new Set()

  return entries
    .map((entry, index) => {
      const raw = typeof entry === 'string' ? { id: entry } : entry || {}
      const id = String(raw.slug || raw.id || raw.name || '').trim()
      const visibility = String(raw.visibility || '').toLowerCase()

      if (
        !id ||
        raw.hide === true ||
        raw.supported_in_api === false ||
        visibility === 'hide' ||
        visibility === 'hidden'
      ) {
        return null
      }
      if (seen.has(id)) {
        return null
      }
      seen.add(id)

      const priority = Number(raw.priority)
      return {
        priority: Number.isFinite(priority) ? priority : index,
        model: {
          id,
          object: 'model',
          created: Number.isFinite(Number(raw.created)) ? Number(raw.created) : now,
          owned_by: raw.owned_by || 'openai'
        }
      }
    })
    .filter(Boolean)
    .sort(
      (left, right) => left.priority - right.priority || left.model.id.localeCompare(right.model.id)
    )
    .map((entry) => entry.model)
}

class OpenAIModelCatalogService {
  constructor() {
    this.cache = new Map()
    this.inFlight = new Map()
  }

  async getModelsForRequest(apiKeyData) {
    const selection = await unifiedOpenAIScheduler.selectAccountForApiKey(apiKeyData, null, null)

    if (!selection?.accountId) {
      throw new Error('No available OpenAI account for model discovery')
    }

    const accountType = selection.accountType || 'openai'
    let account
    let accessToken = null

    if (accountType === 'openai-responses') {
      account = await openaiResponsesAccountService.getAccount(selection.accountId)
      if (!account?.apiKey) {
        throw new Error(`OpenAI-Responses account ${selection.accountId} has no API key`)
      }
    } else {
      account = await openaiAccountService.getAccount(selection.accountId)
      if (!account) {
        throw new Error(`OpenAI account ${selection.accountId} was not found`)
      }

      if (openaiAccountService.isTokenExpired(account)) {
        if (!account.refreshToken) {
          throw new Error(`OpenAI account ${selection.accountId} has no refresh token`)
        }
        await openaiAccountService.refreshAccountToken(selection.accountId)
        account = await openaiAccountService.getAccount(selection.accountId)
      }

      accessToken = openaiAccountService.decrypt(account?.accessToken)
      if (!accessToken) {
        throw new Error(`OpenAI account ${selection.accountId} has no access token`)
      }
    }

    return this.getModelsForAccount({
      account,
      accountId: selection.accountId,
      accountType,
      accessToken
    })
  }

  async getModelsForAccount({ account, accountId, accountType, accessToken }) {
    const cacheKey = `${accountType}:${accountId}`
    const cached = this.cache.get(cacheKey)
    const now = Date.now()

    if (cached && cached.expiresAt > now) {
      return { models: cached.models, source: 'cache', accountId }
    }

    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)
    }

    const request = this.fetchModels({ account, accountType, accessToken })
      .then((models) => {
        if (!models.length) {
          throw new Error('Upstream returned an empty OpenAI model catalog')
        }
        this.cache.set(cacheKey, {
          models,
          expiresAt: Date.now() + CACHE_TTL_MS
        })
        return { models, source: 'upstream', accountId }
      })
      .catch((error) => {
        if (cached?.models?.length) {
          logger.warn(`Using stale OpenAI model catalog for account ${accountId}: ${error.message}`)
          return { models: cached.models, source: 'stale', accountId }
        }
        throw error
      })
      .finally(() => {
        this.inFlight.delete(cacheKey)
      })

    this.inFlight.set(cacheKey, request)
    return request
  }

  async fetchModels({ account, accountType, accessToken }) {
    if (accountType === 'openai-responses') {
      return this.fetchOpenAICompatibleModels(account)
    }
    return this.fetchCodexModels(account, accessToken)
  }

  async fetchCodexModels(account, accessToken) {
    const accountId = account.accountId || account.chatgptUserId || account.id
    const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
    const options = {
      params: { client_version: CODEX_CLIENT_VERSION },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'ChatGPT-Account-Id': accountId,
        originator: 'codex_cli_rs',
        'User-Agent': `codex_cli_rs/${CODEX_CLIENT_VERSION}`,
        Accept: 'application/json'
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true
    }

    if (proxyAgent) {
      options.httpAgent = proxyAgent
      options.httpsAgent = proxyAgent
      options.proxy = false
    }

    const response = await axios.get(CODEX_MODELS_URL, options)
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Codex model discovery failed with HTTP ${response.status}`)
    }
    return normalizeModelEntries(response.data)
  }

  async fetchOpenAICompatibleModels(account) {
    const baseApi = String(account.baseApi || '').replace(/\/+$/, '')
    if (!baseApi || !account.apiKey) {
      throw new Error('OpenAI-Responses account is missing baseApi or API key')
    }

    const firstUrl = baseApi.endsWith('/v1') ? `${baseApi}/models` : `${baseApi}/v1/models`
    const secondUrl =
      firstUrl === `${baseApi}/models` ? `${baseApi}/v1/models` : `${baseApi}/models`
    let lastError = null

    for (const url of [firstUrl, secondUrl]) {
      try {
        const response = await this.requestCompatibleModels(url, account)
        if (response.status === 404 && url !== secondUrl) {
          continue
        }
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`OpenAI-compatible model discovery failed with HTTP ${response.status}`)
        }
        return normalizeModelEntries(response.data)
      } catch (error) {
        lastError = error
        if (url !== secondUrl && /HTTP 404/.test(error.message)) {
          continue
        }
        throw error
      }
    }

    throw lastError || new Error('OpenAI-compatible model discovery failed')
  }

  async requestCompatibleModels(url, account) {
    const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
    const options = {
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        Accept: 'application/json'
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true
    }

    if (proxyAgent) {
      options.httpAgent = proxyAgent
      options.httpsAgent = proxyAgent
      options.proxy = false
    }

    return axios.get(url, options)
  }
}

module.exports = new OpenAIModelCatalogService()
module.exports.normalizeModelEntries = normalizeModelEntries
