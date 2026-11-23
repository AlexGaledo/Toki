import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './components/App';
import { connectWs } from './lib/ws';
import { pairFromHash } from './lib/auth';
import { currentPopout } from './lib/popout';
import { PopoutShell } from './components/PopoutShell';
import { initLayout } from './lib/layout';
import '@fontsource-variable/google-sans/wght.css';
import '@fontsource-variable/figtree/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import '@fontsource-variable/nunito/wght.css';
import './index.css';

const popout = currentPopout();
initLayout();

void pairFromHash().finally(() => {
  connectWs();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {popout ? <PopoutShell route={popout} /> : <App />}
    </React.StrictMode>,
  );
});

// The worker caches the app shell only (public/sw.js), never messages or API data.
if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  });
}
