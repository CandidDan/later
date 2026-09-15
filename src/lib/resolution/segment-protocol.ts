import type { SegmentResolutionInputSnapshot } from "./segment-input";
import type { SegmentEvidence, SegmentMaterial } from "./segment-material";
import type { SegmentResolutionResult } from "./segment-result";

export const SEGMENT_PROMPT_VERSION = "segment-resolution-v0.1";
export const SEGMENT_PIPELINE_VERSION = "segment-resolution-pipeline-v0.1";

export class SegmentResolutionAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentResolutionAnalysisError";
  }
}

export interface SegmentResolutionAnalysis {
  result: SegmentResolutionResult;
  modelId: string;
}

export interface SegmentResolutionAnalyser {
  (
    snapshot: SegmentResolutionInputSnapshot,
    material: SegmentMaterial,
    evidence: readonly SegmentEvidence[],
  ): Promise<SegmentResolutionAnalysis>;
}
