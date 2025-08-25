import { useStytch, useStytchUser } from '@stytch/react'
import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import CalendarDashboard from './components/CalendarDashboard'
import LoginForm from './components/LoginForm'
import Authenticate from './components/Authenticate'
import './App.css'

function App() {
  const stytch = useStytch()
  const { user } = useStytchUser()
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    // Check if user is already authenticated
    const checkSession = async () => {
      try {
        await stytch.session.getSync()
      } catch (error) {
        console.log('No active session')
      } finally {
        setIsLoading(false)
      }
    }
    checkSession()
  }, [stytch])

  const handleLogout = async () => {
    await stytch.session.revoke()
  }

  if (isLoading) {
    return (
      <div className="app-container">
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <div className="app-container">
        <header className="app-header">
          <h1><img src="/calendar.svg" alt="Calendar" style={
            {
              width: 24,
              height: 24,
              marginRight: 10
            }
          }/> iCal MCP Server</h1>
          {user && (
            <div className="user-info">
              <span>{user.emails?.[0]?.email}</span>
              <button onClick={handleLogout} className="logout-btn">
                Logout
              </button>
            </div>
          )}
        </header>

        <main className="app-main">
          <Routes>
            <Route path="/authenticate" element={<Authenticate />} />
            <Route path="/" element={
              user ? <CalendarDashboard /> : <LoginForm />
            } />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        <footer className="app-footer">
          <p>Connect via MCP: <code>{window.location.origin}/mcp</code></p>
          <p>OAuth Discovery: <code>{window.location.origin}/.well-known/oauth-protected-resource</code></p>
        </footer>
      </div>
    </BrowserRouter>
  )
}

export default App