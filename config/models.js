/**
 * 模型列表配置
 * 用于前端展示和测试功能
 */

const CLAUDE_MODELS = [
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { value: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1' },
  { value: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' }
]

const GEMINI_MODELS = [
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' }
]

const GROK_MODELS = [
  { value: 'grok-4.7', label: 'Grok 4.7' },
  { value: 'grok-4.6', label: 'Grok 4.6' },
  { value: 'grok-4.5', label: 'Grok 4.5' },
  { value: 'grok-4.3', label: 'Grok 4.3' },
  { value: 'grok-build-0.1', label: 'Grok Build 0.1' },
  { value: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' }
]

const OPENAI_MODELS = [
  { value: 'gpt-6.2-astra', label: 'GPT-6.2 Astra' },
  { value: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' },
  { value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
  { value: 'gpt-6-luna', label: 'GPT-6 Luna' }
]

const BEDROCK_MODELS = [
  { value: 'us.anthropic.claude-opus-4-6-20250610-v1:0', label: 'Claude Opus 4.6' },
  { value: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude Sonnet 4.5' },
  { value: 'us.anthropic.claude-sonnet-4-20250514-v1:0', label: 'Claude Sonnet 4' },
  { value: 'us.anthropic.claude-3-5-haiku-20241022-v1:0', label: 'Claude 3.5 Haiku' }
]

// 其他模型（用于账户编辑的模型映射）
const OTHER_MODELS = [
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'Qwen', label: 'Qwen' },
  { value: 'Kimi', label: 'Kimi' },
  { value: 'GLM', label: 'GLM' }
]

// 各平台测试可用模型
const PLATFORM_TEST_MODELS = {
  claude: CLAUDE_MODELS,
  'claude-console': CLAUDE_MODELS,
  bedrock: BEDROCK_MODELS,
  gemini: GEMINI_MODELS,
  'gemini-api': GEMINI_MODELS,
  'openai-responses': OPENAI_MODELS,
  'azure-openai': [],
  droid: CLAUDE_MODELS,
  grok: GROK_MODELS,
  ccr: CLAUDE_MODELS
}

module.exports = {
  CLAUDE_MODELS,
  GEMINI_MODELS,
  OPENAI_MODELS,
  GROK_MODELS,
  BEDROCK_MODELS,
  OTHER_MODELS,
  PLATFORM_TEST_MODELS,
  // 按服务分组
  getModelsByService: (service) => {
    switch (service) {
      case 'claude':
        return CLAUDE_MODELS
      case 'gemini':
        return GEMINI_MODELS
      case 'openai':
        return OPENAI_MODELS
      case 'grok':
        return GROK_MODELS
      default:
        return []
    }
  },
  // 获取所有模型（用于账户编辑）
  getAllModels: () => [
    ...CLAUDE_MODELS,
    ...GEMINI_MODELS,
    ...OPENAI_MODELS,
    ...GROK_MODELS,
    ...OTHER_MODELS
  ]
}
