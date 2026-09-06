import { describe, it } from "vitest";
import { workflowLocalContinuationContracts } from "../../../fixtures/workflow-local-continuation-contracts.js";

describe("local continuation production-module contracts (fake child sessions, not live proof)", () => {
  for (const contract of workflowLocalContinuationContracts) it(contract.name, contract.run);
});
