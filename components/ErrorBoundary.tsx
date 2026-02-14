import React from 'react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean; error?: Error | null; info?: React.ErrorInfo | null };

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // keep state and also log to console for dev
    this.setState({ error, info });
    // eslint-disable-next-line no-console
    console.error('Uncaught render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-red-900/90 text-white p-6">
          <div className="max-w-2xl bg-red-800/80 rounded-md p-4 border border-red-600">
            <h2 className="text-lg font-bold mb-2">Application error — see details</h2>
            <div className="text-sm whitespace-pre-wrap break-words mb-3">{this.state.error?.message}</div>
            <details className="text-xs opacity-80 bg-black/20 p-2 rounded">
              <summary className="cursor-pointer">Component stack</summary>
              <pre className="text-xs mt-2">{this.state.info?.componentStack}</pre>
            </details>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
