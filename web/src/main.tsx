import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { App } from './App'
import { AppProviders } from './AppProviders'
import { AuthProvider } from './auth/AuthProvider'
import { ConfigErrorScreen } from './ConfigErrorScreen'
import { setConfig, type AppConfig } from './config'
import { loadRuntimeConfig } from './runtimeConfig'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')

// A data router (not <BrowserRouter>) so pages can block navigation with
// useBlocker, e.g. to protect unsaved data entry. One splat route renders the
// app, which declares its own <Routes>.
function Root() {
  return (
    <AuthProvider>
      <AppProviders>
        <App />
      </AppProviders>
    </AuthProvider>
  )
}

function render(config: AppConfig): void {
  setConfig(config)
  createRoot(root!).render(
    <StrictMode>
      <RouterProvider router={createBrowserRouter([{ path: '*', element: <Root /> }])} />
    </StrictMode>,
  )
}

// Misconfiguration (for example a production build without Auth0 settings
// and no /config.json) must be visible, not a blank page.
function renderError(err: unknown): void {
  const message = err instanceof Error ? err.message : 'The app is misconfigured.'
  createRoot(root!).render(<ConfigErrorScreen message={message} />)
}

loadRuntimeConfig({
  env: import.meta.env,
  isProduction: import.meta.env.PROD,
  origin: window.location.origin,
}).then(render, renderError)
