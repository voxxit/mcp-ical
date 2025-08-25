import { StytchLogin } from '@stytch/react'
import type { OAuthProviders, Products, StyleConfig, Callbacks } from '@stytch/vanilla-js'

function LoginForm() {
  const redirectUrl = `${window.location.origin}/authenticate`

  const config: {
    products: Products[]
    emailMagicLinksOptions?: {
      loginRedirectURL: string
      signupRedirectURL: string
      loginExpirationMinutes?: number
      signupExpirationMinutes?: number
      createUserAsPending?: boolean
    }
    oauthOptions?: {
      providers: OAuthProviders[]
      loginRedirectURL?: string
      signupRedirectURL?: string
    }
    otpOptions?: {
      methods: Array<'email' | 'sms' | 'whatsapp'>
      expirationMinutes?: number
    }
    sessionOptions?: {
      sessionDurationMinutes?: number
    }
  } = {
    products: ['oauth', 'emailMagicLinks'],
    emailMagicLinksOptions: {
      loginRedirectURL: redirectUrl,
      signupRedirectURL: redirectUrl,
      loginExpirationMinutes: 30,
      signupExpirationMinutes: 30,
      createUserAsPending: false,
    },
    oauthOptions: {
      providers: [
        { type: 'github' },
        { type: 'google' },
      ],
      loginRedirectURL: redirectUrl,
      signupRedirectURL: redirectUrl,
    },
    sessionOptions: {
      sessionDurationMinutes: 1440, // 24 hours
    },
  }

  const styles: StyleConfig = {
    container: {
      width: '400px',
      backgroundColor: '#ffffff',
      borderRadius: '8px',
      borderColor: '#e0e0e0',
    },
    colors: {
      primary: '#0969da',
      secondary: '#6c757d',
      success: '#28a745',
      error: '#dc3545',
    },
    buttons: {
      primary: {
        backgroundColor: '#0969da',
        textColor: '#ffffff',
        borderRadius: '6px',
      },
      secondary: {
        backgroundColor: '#ffffff',
        textColor: '#0969da',
        borderColor: '#0969da',
        borderRadius: '6px',
      },
    },
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    hideHeaderText: false,
  }

  const callbacks: Callbacks = {
    onEvent: ({ type, data }) => {
      if (type === 'MAGIC_LINK_SENT') {
        console.log('Magic link sent to:', data)
      } else if (type === 'OAUTH_START') {
        console.log('OAuth flow started:', data)
      }
    },
    onError: (error) => {
      console.error('Authentication error:', error)
    },
    onSuccess: (data) => {
      console.log('Authentication successful:', data)
    },
  }

  const strings = {
    'login.title': 'Welcome to iCal MCP Server',
    'login.subtitle': 'Sign in to manage your calendar subscriptions',
  }

  return (
    <div className="login-container">
      <StytchLogin
        config={config}
        styles={styles}
        callbacks={callbacks}
        strings={strings}
      />
    </div>
  )
}

export default LoginForm