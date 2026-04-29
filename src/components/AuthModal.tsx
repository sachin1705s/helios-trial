import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { supabase } from '../lib/supabase';

interface AuthModalProps {
  onClose: () => void;
}

export function AuthModal({ onClose }: AuthModalProps) {
  return (
    <div className="auth-modal-overlay" onClick={onClose}>
      <div className="auth-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="auth-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
        <div className="auth-modal-header">
          <h2>Sign in to Interact Studio</h2>
          <p>Save your progress, unlock character memory, and access custom characters.</p>
        </div>
        <Auth
          supabaseClient={supabase}
          appearance={{
            theme: ThemeSupa,
            variables: {
              default: {
                colors: {
                  brand:        '#7996ff',
                  brandAccent:  '#5c7aff',
                  inputBackground: 'rgba(255,255,255,0.05)',
                  inputText:    '#e7edf6',
                  inputBorder:  'rgba(255,255,255,0.15)',
                  defaultButtonBackground:  'rgba(255,255,255,0.08)',
                  defaultButtonText:        '#e7edf6',
                  defaultButtonBorder:      'rgba(255,255,255,0.15)',
                },
                radii: {
                  borderRadiusButton: '8px',
                  inputBorderRadius:  '8px',
                },
              },
            },
            style: {
              container: { background: 'transparent' },
              label:  { color: 'rgba(231,237,246,0.72)' },
              message: { color: 'rgba(231,237,246,0.6)' },
            },
          }}
          providers={['google']}
          redirectTo={window.location.origin}
          onlyThirdPartyProviders={false}
        />
      </div>
    </div>
  );
}
