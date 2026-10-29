import { fileURLToPath } from "node:url";
import type { ComponentType } from "react";
import "./react-global";

// The web client's components are .tsx files. The tsconfig that type-checks the tests sets no `jsx`,
// so TypeScript refuses a static import of them from a test; Vite has no such limit. Loading them by a
// computed path keeps the tests under the server tsconfig, at the price of untyped props.

export type Component = ComponentType<Record<string, unknown>>;

export async function loadComponent(file: string, name: string): Promise<Component> {
  const path = fileURLToPath(new URL(`../../web/src/${file}`, import.meta.url));
  const module = (await import(/* @vite-ignore */ path)) as Record<string, Component | undefined>;
  const component = module[name];
  if (!component) throw new Error(`${file} does not export ${name}.`);
  return component;
}
