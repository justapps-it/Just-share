import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // New version: reload, unless a transfer is running.
    if (!hadController || reloaded || document.querySelector('.transfer.sending, .transfer.receiving, .modal')) return;
    reloaded = true;
    location.reload();
  });
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}));
}
