import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command }) => {
  const isBuild = command === 'build'

  const devHost = process.env.VITE_DEV_HOST
  const devPort = process.env.VITE_DEV_PORT
    ? Number(process.env.VITE_DEV_PORT)
    : undefined
  const hmrHost = process.env.VITE_HMR_HOST ?? devHost
  const hmrPortEnv = process.env.VITE_HMR_PORT
    ? Number(process.env.VITE_HMR_PORT)
    : undefined
  const hmrPort = hmrPortEnv ?? devPort
  const hmrProtocol = process.env.VITE_HMR_PROTOCOL as
    | 'ws'
    | 'wss'
    | undefined

  const hmr =
    !isBuild && (hmrHost || hmrPortEnv !== undefined || devPort !== undefined || hmrProtocol)
      ? {
          ...(hmrHost ? { host: hmrHost } : {}),
          ...(hmrPort !== undefined ? { port: hmrPort } : {}),
          ...(hmrPort !== undefined ? { clientPort: hmrPort } : {}),
          ...(hmrProtocol ? { protocol: hmrProtocol } : {}),
        }
      : !isBuild
        ? true
        : false

  return {
    base: isBuild ? './' : '/',
    server: {
      host: true,
      ...(devPort !== undefined ? { port: devPort } : {}),
      strictPort: !!process.env.VITE_DEV_STRICT_PORT,
      ...(!isBuild ? { hmr } : {}),
    },
    test: {
      environment: 'node',
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
