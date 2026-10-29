import * as React from "react";

// The web client's .tsx files rely on the automatic JSX runtime, which Vite's build turns on. The
// test runner transforms them with esbuild's classic runtime (the root tsconfig sets no `jsx`), which
// calls `React.createElement` on a global. Provide it so the components can be rendered in a test.
(globalThis as { React?: typeof React }).React = React;
