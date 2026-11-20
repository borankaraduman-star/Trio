import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DownloadPage } from './DownloadPage'
import './downloads.css'
import './site.css'
import './demos.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <DownloadPage />
  </StrictMode>,
)
