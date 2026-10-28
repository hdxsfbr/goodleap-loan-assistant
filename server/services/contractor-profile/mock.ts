import { AppError } from "../../errors.js";
import { store } from "../../store.js";
import type { ContractorProfile, ContractorProfileService } from "../types.js";

/** In-process stand-in for the contractor profile service: the contractors in the seed file. */
export function createContractorProfileMock(): ContractorProfileService {
  return {
    async getProfile(contractorId): Promise<ContractorProfile> {
      const contractor = store.getContractor(contractorId);
      if (!contractor) {
        // The response text stays the generic `internal` one; the diagnostic rides in `cause`,
        // which the route error handler writes to the server log.
        throw new AppError("internal", undefined, {
          cause: new Error(`No contractor profile exists for ${contractorId}.`),
        });
      }
      return contractor;
    },
  };
}
