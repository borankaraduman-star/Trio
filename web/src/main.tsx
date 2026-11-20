import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './owner/errorReporter'
import './styles.css'
import './styles-v2.css'
import './styles-v3.css'
import './styles-v4-voice.css'
import './styles-v4-identity.css'
import './styles-v4-messages.css'
import './styles-game-status.css'
import './styles-v6-push.css'
import './styles-v6-voice.css'
import './styles-v6-ops.css'
import './styles-v6-media.css'
import './styles-v7-phone.css'
import './styles-v7-reading.css'
import './styles-v8-music.css'
import './theme.css'
import './styles-v9-join.css'
import './styles-v10-groups.css'
import './styles-v11-activity.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
