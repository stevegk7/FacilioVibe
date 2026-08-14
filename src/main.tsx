import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { installBuildCheck } from './shell/buildCheck';
import { installViewportHeight } from './shell/viewportHeight';
import { ensureMockProvider } from './api/provider';

// A stale index.html silently pins old assets — detect and self-heal.
installBuildCheck();
// dvh alone still misreports on some iPadOS configurations.
installViewportHeight();

// ?mock=1 only: fetch the fixture lane before anything can read from it. A no-op
// on a real session, which is the point — the demo data is a separate chunk now
// rather than weight on every technician's first paint. Awaited rather than
// fired-and-forgotten because `provider` is synchronous and would otherwise
// throw on the first screen's first read.
//
// .then rather than top-level await: this file is the entry, and a top-level
// await here would force the whole bundle to the async-module path for a branch
// production never takes.
void ensureMockProvider().then(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
