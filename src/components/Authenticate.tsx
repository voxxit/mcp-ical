import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStytch } from '@stytch/react'

function Authenticate() {
  const stytch = useStytch()
  const navigate = useNavigate()

  useEffect(() => {
    const authenticate = async () => {
      try {
        // Get the token from the URL
        const params = new URLSearchParams(window.location.search)
        const token = params.get('token')
        const stytchTokenType = params.get('stytch_token_type')
        
        if (token && stytchTokenType === 'oauth') {
          // Authenticate OAuth token
          await stytch.oauth.authenticate(token, {
            session_duration_minutes: 1440 // 24 hours
          })
          navigate('/')
        } else if (token && stytchTokenType === 'magic_links') {
          // Authenticate magic link token
          await stytch.magicLinks.authenticate(token, {
            session_duration_minutes: 1440 // 24 hours
          })
          navigate('/')
        } else {
          // No token found, redirect to home
          navigate('/')
        }
      } catch (error) {
        console.error('Authentication failed:', error)
        navigate('/')
      }
    }

    authenticate()
  }, [stytch, navigate])

  return (
    <div className="authenticate-container">
      <div className="loading">
        <div className="spinner"></div>
        <p>Authenticating...</p>
      </div>
    </div>
  )
}

export default Authenticate