// Deliberate crash screen, reachable only via ?tab=boom. Exists so the
// shell-smoke acceptance ("a thrown screen error shows a readable panel while
// the tab bar still works") stays testable by hand and by vitest forever.
export default function BoomScreen(): never {
  throw new Error('Deliberate crash from ?tab=boom — the shell must survive this.');
}
