import { Component, type ErrorInfo, type ReactNode } from 'react';
import { claimError } from './globalErrors';

interface Props {
  /** Human-readable name of what this boundary wraps, e.g. the tab label. */
  screen: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Per-screen boundary. A render throw inside one tab must cost that tab only —
 * the tab bar and every other screen keep working. Without this, the throw
 * unmounts the whole tree and the bug report is "blank page".
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    claimError(error); // keep the global banner quiet — this panel owns the report
    console.error(`[${this.props.screen}] render error`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-panel" role="alert">
        <h2>The {this.props.screen} screen crashed</h2>
        <p className="error">{error.message}</p>
        {error.stack && (
          <details>
            <summary>Stack trace</summary>
            <pre>{error.stack}</pre>
          </details>
        )}
        <button onClick={this.reset}>Try again</button>
      </div>
    );
  }
}
