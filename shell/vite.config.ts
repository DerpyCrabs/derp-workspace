import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'
import { configDefaults } from 'vitest/config'

export default defineConfig(({ command }) => {
  const isBuild = command === 'build'

  return {
    base: isBuild ? './' : '/',
    server: {
      host: true,
    },
    test: {
      environment: 'node',
      exclude: [...configDefaults.exclude, 'e2e/**'],
    },
    plugins: [
      solid(),
      tailwindcss(),
      {
        name: 'strip-crossorigin-for-file-url',
        transformIndexHtml(html) {
          return html.replace(/\s+crossorigin(=("[^"]*"|'[^']*'))?/g, '')
        },
      },
    ],
  }
})
