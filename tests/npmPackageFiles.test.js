const packageJson = require('../package.json')

describe('npm package file whitelist', () => {
  test('includes admin SPA ESLint config required by development tooling', () => {
    expect(packageJson.files).toContain('web/admin-spa/.eslintrc.cjs')
  })
})
