/**
 * Inbound email is single-user in v0: one configured local part, one configured capture user.
 * Nothing in the message decides who a capture belongs to — the envelope is captured data, so
 * treating a `To:` address as an identity would let a sender pick the owner of the row.
 */
export const DEFAULT_EMAIL_MAX_BYTES = 5 * 1024 * 1024;
export const EMAIL_MAX_BYTES_CEILING = 20 * 1024 * 1024;

/** Beyond this the stored representation stays private but is never read into a model request. */
export const REPRESENTATION_MODEL_READ_LIMIT = 5 * 1024 * 1024;

export class EmailError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "EmailError";
  }
}

export interface EmailWebhookConfiguration {
  /** Resend's signing secret for this endpoint. Verification only; never an API credential. */
  webhookSecret: string;
  inboundToken: string;
  captureUserId: string;
}

export interface EmailRetrievalConfiguration {
  apiKey: string;
  apiBaseUrl: string;
  maxBytes: number;
}

function boundedMaxBytes(raw: string | undefined): number {
  const maxBytes = Number(raw ?? DEFAULT_EMAIL_MAX_BYTES);

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > EMAIL_MAX_BYTES_CEILING) {
    throw new EmailError("email_configuration_invalid");
  }

  return maxBytes;
}

export function configuredEmailWebhook(
  env: Record<string, string | undefined> = process.env,
): EmailWebhookConfiguration {
  return {
    webhookSecret: env.RESEND_WEBHOOK_SECRET ?? "",
    inboundToken: env.EMAIL_INBOUND_TOKEN ?? "",
    captureUserId: env.EMAIL_CAPTURE_USER_ID ?? "",
  };
}

export function configuredEmailRetrieval(
  env: Record<string, string | undefined> = process.env,
): EmailRetrievalConfiguration {
  const apiBaseUrl = env.RESEND_API_BASE_URL ?? "https://api.resend.com";

  if (!env.RESEND_API_KEY?.trim() || !/^https:\/\/[^\s/]+$/u.test(apiBaseUrl)) {
    throw new EmailError("email_configuration_invalid");
  }

  return {
    apiKey: env.RESEND_API_KEY,
    apiBaseUrl,
    maxBytes: boundedMaxBytes(env.EMAIL_MAX_BYTES),
  };
}
