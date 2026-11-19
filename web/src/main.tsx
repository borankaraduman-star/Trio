import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import './styles-v2.css'
import './styles-v3.css'
import './styles-v4-voice.css'
import './styles-v4-identity.css'
import './styles-v4-messages.css'
import './theme.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
