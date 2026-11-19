import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DownloadPage } from './DownloadPage'
import './indir.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <DownloadPage />
  </StrictMode>,
)
