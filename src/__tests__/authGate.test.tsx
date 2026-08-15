import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AuthGate from '../auth/AuthGate';
import type { DataProvider } from '../api/dataProvider';

function failingProvider(login = vi.fn()): DataProvider & { login: ReturnType<typeof vi.fn> } {
  return {
    getCurrentUser: vi.fn().mockRejectedValue(new Error('identity unreachable')),
    login,
    logout: vi.fn(),
    listSites: vi.fn(),
    listSpaces: vi.fn(),
    listAssets: vi.fn(),
    listWorkOrders: vi.fn(),
  } as unknown as DataProvider & { login: ReturnType<typeof vi.fn> };
}

describe('auth gate (1.4)', () => {
  it('waits for a tap instead of redirecting, then calls login() once', async () => {
    const login = vi.fn();

    // First mount: thrown check → auto login(), marker set
    const first = render(
      <AuthGate embedded={false} provider={failingProvider(login)}>
        {() => <p>app</p>}
      </AuthGate>,
    );
    // Nothing happens until the person asks for it. On a phone an instant
    // bounce to SSO leaves no tap target and nothing recoverable if the
    // redirect stalls, so the screen waits.
    const signIn = await screen.findByRole('button', { name: 'Sign in with Facilio' });
    expect(login).not.toHaveBeenCalled();

    await userEvent.click(signIn);
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem('fv.autoLoginAttempted')).toBe('1');
    first.unmount();

    // Second mount (login() didn't navigate — broken round-trip): the screen is
    // still there with the reason attached, and still does not fire on its own.
    render(
      <AuthGate embedded={false} provider={failingProvider(login)}>
        {() => <p>app</p>}
      </AuthGate>,
    );
    expect(await screen.findByRole('button', { name: 'Sign in with Facilio' })).toBeInTheDocument();
    expect(screen.getByText(/identity unreachable/)).toBeInTheDocument();
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('embedded: never auto-redirects, shows open-in-tab sign-in and polls', async () => {
    const login = vi.fn();
    render(
      <AuthGate embedded={true} provider={failingProvider(login)}>
        {() => <p>app</p>}
      </AuthGate>,
    );

    expect(await screen.findByRole('button', { name: 'Sign in with Facilio' })).toBeInTheDocument();
    expect(screen.getByText(/opens Facilio in a new tab/i)).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('renders children with the user when the check succeeds', async () => {
    const provider = failingProvider();
    (provider.getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { uid: 7, email: 'x@y.z', name: 'X', username: 'x' },
      org: { orgId: 2915 },
    });

    render(
      <AuthGate embedded={false} provider={provider}>
        {(me) => <p>hello {me.user.name}</p>}
      </AuthGate>,
    );
    expect(await screen.findByText('hello X')).toBeInTheDocument();
  });
});
