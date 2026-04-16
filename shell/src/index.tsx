/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Missing #root mount element.')
}

render(() => <App />, root)

if (import.meta.hot) {
  const resyncShellFromCompositor = () => {
    queueMicrotask(() => {
      const fn = window.__derpShellWireSend
      if (typeof fn === 'function') fn('request_compositor_sync')
    })
  }
  import.meta.hot.accept('./App.tsx', resyncShellFromCompositor)
  import.meta.hot.accept('./host/ShellWindowFrame.tsx', resyncShellFromCompositor)
}
