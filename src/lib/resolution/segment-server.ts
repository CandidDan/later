import "server-only";

import { createCaptureJobStore } from "../jobs/server";
import { createSegmentResolutionAnalyser } from "./segment-anthropic";
import type { SegmentResolutionAnalyser } from "./segment-protocol";
import { processNextSegmentResolutionJob } from "./segment-process";

export function createSegmentResolutionProcessor() {
  const store = createCaptureJobStore();
  let analyser: SegmentResolutionAnalyser | undefined;
  return () => processNextSegmentResolutionJob({
    store,
    analyse: (...args) => {
      analyser ??= createSegmentResolutionAnalyser();
      return analyser(...args);
    },
  });
}
