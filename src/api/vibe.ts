import { createVibe } from '@facilio/vibe-sdk';

// The single SDK instance. serverURL defaults to window.location.origin, so
// cookies flow with no config on the deployed app. Only src/api may import this.
export const vibe = createVibe();
