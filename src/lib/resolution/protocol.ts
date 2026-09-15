import type { SourceResolutionInputSnapshot } from "./input";
import type { SourceEvidence, SourceResolutionResult } from "./result";

export const SOURCE_PROMPT_VERSION = "source-resolution-v0.1";
export const SOURCE_PIPELINE_VERSION = "source-resolution-pipeline-v0.1";

export class SourceResolutionAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceResolutionAnalysisError";
  }
}
export interface SourceResolutionAnalysis {
  result: SourceResolutionResult;
  modelId: string;
}

export interface SourceResolutionAnalyser {
  (snapshot: SourceResolutionInputSnapshot, evidence: readonly SourceEvidence[]): Promise<SourceResolutionAnalysis>;
}
