import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './App'
import { AppProviders } from './AppProviders'
import { AuthProvider } from './auth/AuthProvider'
import { ConfigErrorScreen } from './ConfigErrorScreen'
import { getConfig } from './config'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')

function render(): void {
  try {
    getConfig()
  } catch (err) {
    // Misconfiguration (for example a production build without Auth0
    // settings) must be visible, not a blank page.
    const message = err instanceof Error ? err.message : 'The app is misconfigured.'
    createRoot(root!).render(<ConfigErrorScreen message={message} />)
    return
  }
  createRoot(root!).render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <AppProviders>
            <App />
          </AppProviders>
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  )
}

render()
