import React from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

// Dynamically import App so module-evaluation/runtime errors can be caught
(async function mountApp() {
  try {
    const mod = await import('./App');
    const App = mod.default;

    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  } catch (err: any) {
    console.error('Failed to load App module:', err);
    const rootEl = document.getElementById('root');
    if (rootEl) {
      rootEl.innerHTML = `<div style="padding:24px;color:#fff;background:#7f1d1d;font-family:Inter, sans-serif;"><h2>Application failed to load</h2><pre style="white-space:pre-wrap">${String(err)}</pre></div>`;
    }
  }
})();