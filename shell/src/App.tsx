import { createSignal, onCleanup, onMount } from 'solid-js'
import './App.css'

function App() {
  const [hue, setHue] = createSignal(210)

  let timer: ReturnType<typeof setInterval>
  onMount(() => {
    timer = setInterval(() => {
      setHue((h) => (h + 1) % 360)
    }, 48)
  })
  onCleanup(() => clearInterval(timer))

  return (
    <main class="shell-root" style={{ '--shell-hue': `${hue()}` }}>
      <div class="shell-panel">
        <h1 class="shell-title">derp shell</h1>
        <p class="shell-sub">SolidJS → CEF OSR → compositor</p>
      </div>
    </main>
  )
}

export default App
