const fs = require('fs')
const path = require('path')

describe('admin SPA build configuration', () => {
  test('does not manually split Element Plus away from the app entry', () => {
    const viteConfig = fs.readFileSync(
      path.join(__dirname, '..', 'web', 'admin-spa', 'vite.config.js'),
      'utf8'
    )

    expect(viteConfig).not.toContain('manualChunks')
    expect(viteConfig).not.toContain("id.includes('element-plus')")
  })
})
