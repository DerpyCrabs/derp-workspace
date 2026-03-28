import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  // Relative asset URLs so `file:///.../dist/index.html` works when loaded by cef_host (OSR).
  base: './',
  plugins: [
    solid(),
    // `crossorigin` on module scripts makes `file://` loads fail (no CORS); UI never mounts → flat white OSR.
    {
      name: 'strip-crossorigin-for-file-url',
      transformIndexHtml(html) {
        return html.replace(/\s+crossorigin(=("[^"]*"|'[^']*'))?/g, '')
      },
    },
  ],
})
