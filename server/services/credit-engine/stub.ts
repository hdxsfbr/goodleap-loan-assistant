import type { CreditEngineService } from "../types.js";

/**
 * The credit decision engine stub. `decide` throws the moment it is called, so any code path
 * that reaches the engine fails a test instead of rendering an answer.
 */
export class CreditEngineStub implements CreditEngineService {
  decide(applicationId: string): Promise<unknown> {
    throw new Error(
      `The credit decision engine must not be called by the assistant (application ${applicationId}).`,
    );
  }
}
