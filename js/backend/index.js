// Chooses the backend. Demo mode is used when Firebase is not configured yet,
// or when the address ends in ?demo. The real SDK is only downloaded when needed.

import { isConfigured } from '../config.js';

export async function loadBackend() {
  const forceDemo = new URLSearchParams(location.search).has('demo');
  const module = (forceDemo || !isConfigured())
    ? await import('./demo.js')
    : await import('./firebase.js');
  await module.backend.init();
  return module.backend;
}
