const DEFAULT_IMAGE_HOST_MODEL = 'gpt-5.5'

function resolveImageHostModel(env = process.env) {
  const configured = String(env.OPENAI_IMAGES_HOST_MODEL || '').trim()
  return configured || DEFAULT_IMAGE_HOST_MODEL
}

function buildImageGenerationPayload({
  body = {},
  prompt,
  imageModel,
  partialImages = 1,
  hostModel = DEFAULT_IMAGE_HOST_MODEL
}) {
  const tool = {
    type: 'image_generation',
    model: imageModel,
    partial_images: partialImages
  }
  if (body.size) {
    tool.size = String(body.size)
  }
  if (body.quality) {
    tool.quality = String(body.quality)
  }
  if (body.background) {
    tool.background = String(body.background)
  }
  if (body.output_format) {
    tool.output_format = String(body.output_format)
  }
  if (body.moderation) {
    tool.moderation = String(body.moderation)
  }
  if (Number.isInteger(body.output_compression)) {
    tool.output_compression = body.output_compression
  }
  if (Number.isInteger(body.n) && body.n !== 1) {
    tool.n = body.n
  }

  return {
    model: hostModel,
    store: false,
    instructions:
      'You are an assistant that must fulfill image generation requests by using the image_generation tool when provided.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    tools: [tool],
    tool_choice: {
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'image_generation' }]
    },
    stream: true
  }
}

function extractImageGenerationB64(value) {
  let found = null
  if (Array.isArray(value)) {
    for (const child of value) {
      const nested = extractImageGenerationB64(child)
      if (nested) {
        found = nested
      }
    }
    return found
  }
  if (!value || typeof value !== 'object') {
    return null
  }
  if (value.type === 'image_generation_call' && typeof value.result === 'string') {
    found = value.result
  }
  if (typeof value.partial_image_b64 === 'string') {
    found = value.partial_image_b64
  }
  for (const child of Object.values(value)) {
    const nested = extractImageGenerationB64(child)
    if (nested) {
      found = nested
    }
  }
  return found
}

module.exports = {
  DEFAULT_IMAGE_HOST_MODEL,
  resolveImageHostModel,
  buildImageGenerationPayload,
  extractImageGenerationB64
}
