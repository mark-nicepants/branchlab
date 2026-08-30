// The one class component in the codebase: React has no hook API for error
// boundaries. Wraps render trees that draw arbitrary model output (markdown,
// tool payloads) so one poisoned entry can't take down the whole view.
import { Component, type ReactNode } from "react";

interface Props {
  /** Static fallback, or a render prop receiving the error + a reset callback
   *  that clears the boundary and re-renders its children. */
  fallback: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const { fallback } = this.props;
    return typeof fallback === "function"
      ? fallback(error, this.reset)
      : fallback;
  }
}
