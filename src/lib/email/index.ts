export {
  ACKNOWLEDGEMENT,
  handleInboundEmailWebhook,
  type EmailWebhookDependencies,
  type VerifyEmailSignature,
} from "./webhook";
export {
  ATTACHMENT_ROLE,
  EMAIL_CHANNEL,
  REPRESENTATION_FILENAME,
  REPRESENTATION_MEDIA_TYPE,
  REPRESENTATION_ROLE,
  extractUrlsInOrder,
  isAddressedToToken,
  parseReceivedEmailEvent,
  toCaptureInput,
  type ReceivedEmailEvent,
} from "./event";
export {
  EXCERPT_TEXT_LIMIT,
  REPRESENTATION_VERSION,
  buildStoredRepresentation,
  parseStoredRepresentation,
  representationExcerpt,
  serializeRepresentation,
  type RepresentationExcerpt,
  type StoredEmailRepresentation,
} from "./representation";
export {
  DEFAULT_EMAIL_MAX_BYTES,
  EMAIL_MAX_BYTES_CEILING,
  EmailError,
  REPRESENTATION_MODEL_READ_LIMIT,
  configuredEmailRetrieval,
  configuredEmailWebhook,
  type EmailRetrievalConfiguration,
  type EmailWebhookConfiguration,
} from "./config";
export {
  processNextEmailEnrichmentJob,
  type EmailEnrichmentOutcome,
} from "./enrich";
export {
  createEmailEnrichmentStore,
  type EmailAsset,
  type EmailEnrichmentJob,
  type EmailEnrichmentStore,
} from "./store";
