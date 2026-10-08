import "server-only";
import { createResearchDependencies } from "./server";
import { createRevisitDependencies } from "../revisit/server";
import type { ResearchEnrichmentDependencies } from "./enrichment";

export function createResearchEnrichmentDependencies(): ResearchEnrichmentDependencies {
  return { ...createResearchDependencies(), revisitStoreFor: createRevisitDependencies().storeFor };
}
