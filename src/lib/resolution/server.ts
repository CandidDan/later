import "server-only";

import { createSourceResolutionAnalyser } from "./anthropic";
import type { SourceResolutionAnalyser } from "./protocol";
import { processNextSourceResolutionJob } from "./process";
import { createCaptureJobStore } from "../jobs/server";

export function createSourceResolutionProcessor() {
  const store = createCaptureJobStore();
  let analyser: SourceResolutionAnalyser | undefined;
  return () => processNextSourceResolutionJob({
    store,
    analyse: (...args) => {
      analyser ??= createSourceResolutionAnalyser();
      return analyser(...args);
    },
  });
}
