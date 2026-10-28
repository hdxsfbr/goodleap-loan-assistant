import type { PlaidService } from "../types.js";

/**
 * Plaid income verification. The prototype integrates with Plaid conceptually: this interface and
 * the production note in services/index.ts are the integration, and calling it fails loudly.
 */
export class PlaidStub implements PlaidService {
  startVerification(applicationId: string): Promise<{ link_token: string }> {
    throw new Error(
      `Plaid income verification is not available in the prototype (application ${applicationId}).`,
    );
  }
}
