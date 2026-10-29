import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { RENDER_FAILURE_MESSAGE, RENDER_FAILURE_TITLE } from "./copy";
import "./styles.css";

/** Catches an error thrown while a screen renders or runs an effect, so the page never goes blank. */
class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("A screen failed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page" role="alert">
        <h1 className="page-title">{RENDER_FAILURE_TITLE}</h1>
        <p>{RENDER_FAILURE_MESSAGE}</p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <RouteErrorBoundary>
        <App />
      </RouteErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
