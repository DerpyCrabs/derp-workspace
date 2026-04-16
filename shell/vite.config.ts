import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'
import { configDefaults } from 'vitest/config'

const shellRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ command }) => {
  const isBuild = command === 'build'

  return {
    resolve: {
      alias: {
        '@': path.join(shellRoot, 'src'),
      },
    },
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
