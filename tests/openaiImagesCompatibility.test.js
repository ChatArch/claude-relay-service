const {
  DEFAULT_IMAGE_HOST_MODEL,
  resolveImageHostModel,
  buildImageGenerationPayload,
  extractImageGenerationB64
} = require('../src/utils/openaiImages')

describe('OpenAI Images Codex compatibility helpers', () => {
  test('uses gpt-5.5 by default and supports an environment override', () => {
    expect(DEFAULT_IMAGE_HOST_MODEL).toBe('gpt-5.5')
    expect(resolveImageHostModel({})).toBe('gpt-5.5')
    expect(resolveImageHostModel({ OPENAI_IMAGES_HOST_MODEL: ' gpt-5.6 ' })).toBe('gpt-5.6')
  })

  test('builds the current Codex image_generation payload', () => {
    const payload = buildImageGenerationPayload({
      body: {
        size: '1024x1024',
        quality: 'low',
        background: 'opaque',
        output_format: 'png',
        moderation: 'auto',
        output_compression: 90,
        n: 2
      },
      prompt: 'draw an orange paper airplane',
      imageModel: 'gpt-image-2',
      partialImages: 1,
      hostModel: 'gpt-5.5'
    })

    expect(payload).toMatchObject({
      model: 'gpt-5.5',
      store: false,
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'draw an orange paper airplane' }]
        }
      ],
      tools: [
        {
          type: 'image_generation',
          model: 'gpt-image-2',
          partial_images: 1,
          size: '1024x1024',
          quality: 'low',
          background: 'opaque',
          output_format: 'png',
          moderation: 'auto',
          output_compression: 90,
          n: 2
        }
      ],
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [{ type: 'image_generation' }]
      }
    })
    expect(payload.tools[0]).not.toHaveProperty('action')
  })

  test('extracts both partial and final image payloads', () => {
    expect(
      extractImageGenerationB64({
        type: 'response.image_generation_call.partial_image',
        partial_image_b64: 'partial-image'
      })
    ).toBe('partial-image')

    expect(
      extractImageGenerationB64({
        type: 'response.output_item.done',
        item: { type: 'image_generation_call', result: 'final-image' }
      })
    ).toBe('final-image')
  })
})
