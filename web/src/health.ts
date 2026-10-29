import { createContext, useContext } from "react";
import type { HealthResponse } from "@shared/schemas";

/** The flags and key state from `/api/healthz`, read once when the app loads. Null until known. */
export const HealthContext = createContext<HealthResponse | null>(null);

export function useHealth(): HealthResponse | null {
  return useContext(HealthContext);
}
