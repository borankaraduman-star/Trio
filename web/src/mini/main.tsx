import { createRoot } from 'react-dom/client'
import { MINI_READY_EVENT, type MiniController } from './controller'
import { MiniView } from './MiniView'
import './mini.css'

/**
 * `/mini.html` (CONTRACT-V12-WATCHING §6): a mini player window opened by the
 * Trio window. Everything it shows comes from the opener's controller; opened
 * any other way (a bookmark, a reload after the opener closed) it says so.
 */
const root = createRoot(document.getElementById('mini-root') as HTMLElement)

function controller(): MiniController | null {
  return (window as unknown as { __trioMini?: MiniController }).__trioMini ?? null
}

function start(): void {
  const found = controller()
  if (found) {
    root.render(<MiniView controller={found} win={window} />)
    return
  }
  root.render(
    <p className="mini-orphan" data-testid="mini-orphan">
      Bu küçük pencere Trio penceresinden açılır. Kapatabilirsin.
    </p>,
  )
}

if (controller()) start()
else {
  window.addEventListener(MINI_READY_EVENT, start, { once: true })
  // Not opened by Trio (or the opener went away): say so after a moment.
  setTimeout(() => {
    if (!controller()) start()
  }, 3000)
}
