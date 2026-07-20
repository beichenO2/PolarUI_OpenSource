import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { PublicProductManifest } from './App';
import { AuthGate } from './auth/AuthGate';
import { applyProductBranding } from './branding';
import './styles.css';
import './skins/taoci.css';

async function bootstrap() {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw new Error(`bootstrap failed: ${response.status}`);
  const body = await response.json();
  const manifest = body.manifest as PublicProductManifest;
  applyProductBranding(manifest.branding);

  createRoot(document.getElementById('root')!).render(
    <StrictMode><AuthGate manifest={manifest} /></StrictMode>,
  );
}

void bootstrap();
