import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { App } from './App'
import { AppProviders } from './AppProviders'
import { AuthProvider } from './auth/AuthProvider'
import { ConfigErrorScreen } from './ConfigErrorScreen'
import { getConfig } from './config'
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
      <RouterProvider router={createBrowserRouter([{ path: '*', element: <Root /> }])} />
    </StrictMode>,
  )
}

render()
