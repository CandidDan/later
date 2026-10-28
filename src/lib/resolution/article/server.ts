import "server-only";

import { createCaptureJobStore } from "../../jobs/server";
import { processNextArticleExtractionJob } from "./process";

export function createArticleExtractionProcessor() {
  const store = createCaptureJobStore();
  return () => processNextArticleExtractionJob({ store });
}
