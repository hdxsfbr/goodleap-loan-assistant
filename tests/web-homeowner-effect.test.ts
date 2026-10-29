import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadComponent } from "./helpers/web-components";
import { HOMEOWNER_PROPS } from "./helpers/web-fixtures";

// Returning from the homeowner view crashed the app because its effect returned a value: React
// treats whatever an effect returns as the cleanup function and calls it on unmount. In a current
// browser `window.scrollTo` returns a promise.

const captured = vi.hoisted(() => ({ effects: [] as Array<() => unknown> }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => unknown) => {
      captured.effects.push(effect);
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  captured.effects.length = 0;
});

describe("HomeownerView effect", () => {
  it("scrolls to the top and returns nothing React could call as a cleanup", async () => {
    const HomeownerView = await loadComponent("routes/HomeownerView.tsx", "HomeownerView");
    renderToStaticMarkup(
      h(StaticRouter, { location: { pathname: "/applications/app_demo_001/homeowner", state: HOMEOWNER_PROPS } }, h(HomeownerView)),
    );
    expect(captured.effects).toHaveLength(1);
    const scrollTo = vi.fn(() => Promise.resolve("scrolled"));
    vi.stubGlobal("window", { scrollTo });
    const returned = captured.effects[0]?.();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(returned).toBeUndefined();
  });
});
