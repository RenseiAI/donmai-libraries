import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // vitest 4 no longer excludes dist/ by default; tsc emits compiled tests there.
    exclude: [...configDefaults.exclude, 'dist/**'],
  },
})
