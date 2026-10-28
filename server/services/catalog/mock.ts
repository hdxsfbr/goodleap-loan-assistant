import type { Catalog } from "@shared/schemas";
import { AppError } from "../../errors.js";
import type { CatalogService } from "../types.js";

/**
 * In-process stand-in for the loan product catalog service. It serves the products held in
 * `server/domain/catalog.ts`; `source` is that module's catalog. With no source the service
 * reports itself unavailable, which the copilot and the payment-options route surface as
 * `catalog.unavailable`.
 */
export function createCatalogMock(source?: () => Catalog): CatalogService {
  return {
    async getCatalog() {
      if (!source) throw new AppError("catalog.unavailable");
      return structuredClone(source());
    },
  };
}
