export {
  processNextSourceResolutionJob,
  DIRECT_SOURCE_PROMPT_VERSION,
  type ProcessSourceResolutionDependencies,
  type SourceResolutionOutcome,
} from "./process";
export {
  parseSourceResolutionResult,
  SOURCE_TYPES,
  SourceResolutionResultSchemaError,
  type ResolvedSourceResult,
  type SourceEvidence,
  type SourceResolutionResult,
  type SourceType,
  type UnresolvedSourceResult,
} from "./result";
export {
  buildSourceResolutionInputSnapshot,
  type PublicMetadata,
  type SourceResolutionInputSnapshot,
} from "./input";
export {
  fetchPublicMetadata,
  METADATA_ERROR_CODES,
  MetadataError,
  type MetadataErrorCode,
} from "./metadata";
export {
  fetchPlatformAwareMetadata,
  platformMetadataRoute,
  YOUTUBE_OEMBED_MAX_BYTES,
  YOUTUBE_OEMBED_ORIGIN,
  YOUTUBE_OEMBED_PATH,
  type PlatformMetadataRoute,
} from "./platform";
export { recognizeSource } from "./recognized";
export {
  processNextSegmentResolutionJob,
  UNAVAILABLE_SEGMENT_PROMPT_VERSION,
  type ProcessSegmentResolutionDependencies,
  type SegmentResolutionOutcome,
} from "./segment-process";
export {
  parseSegmentResolutionResult,
  SegmentResolutionResultSchemaError,
  type ResolvedSegmentResult,
  type SegmentResolutionResult,
  type UnresolvedSegmentResult,
} from "./segment-result";
export {
  fetchSegmentMaterial,
  type SegmentEvidence,
  type SegmentMaterial,
  type SegmentRepresentation,
} from "./segment-material";
