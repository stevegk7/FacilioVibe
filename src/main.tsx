import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { installBuildCheck } from './shell/buildCheck';
import { installViewportHeight } from './shell/viewportHeight';

// A stale index.html silently pins old assets — detect and self-heal.
installBuildCheck();
// dvh alone still misreports on some iPadOS configurations.
installViewportHeight();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
