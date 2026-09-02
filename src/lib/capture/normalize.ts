export type CaptureKind = "text" | "link" | "attachment" | "mixed" | "unknown";

export type SourcePlatform = "instagram" | "youtube" | "spotify";

export interface CaptureAttachment {
  id?: string;
  contentType?: string;
  fileName?: string;
  url?: string;
  sizeBytes?: number;
  [metadata: string]: unknown;
}

export interface ProviderNeutralCaptureInput {
  channel?: string;
  rawText?: string;
  userNote?: string;
  externalMessageId?: string;
  capturedAt?: string;
  rawProviderPayload?: unknown;
  attachments?: readonly CaptureAttachment[];
}

export interface NormalizedCapture {
  channel?: string;
  kind: CaptureKind;
  rawText?: string;
  userNote?: string;
  externalMessageId?: string;
  capturedAt?: string;
  rawProviderPayload?: unknown;
  attachments?: readonly CaptureAttachment[];
  urls: readonly string[];
  sourcePlatform?: SourcePlatform;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const TRAILING_URL_PUNCTUATION = /[),.;!?\]}]+$/u;

function extractUrls(text: string | undefined): string[] {
  if (text === undefined) {
    return [];
  }

  return Array.from(text.matchAll(URL_PATTERN), ([match]) =>
    match.replace(TRAILING_URL_PUNCTUATION, ""),
  ).filter(Boolean);
}

function classifyUrl(url: string): SourcePlatform | undefined {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/u, "");

    if (hostname === "instagram.com" || hostname.endsWith(".instagram.com")) {
      return "instagram";
    }

    if (
      hostname === "youtu.be" ||
      hostname.endsWith(".youtu.be") ||
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com")
    ) {
      return "youtube";
    }

    if (hostname === "open.spotify.com") {
      return "spotify";
    }
  } catch {
    // Extraction can retain malformed URL-like text. It remains captured but unclassified.
  }

  return undefined;
}

function deriveSourcePlatform(urls: readonly string[]): SourcePlatform | undefined {
  const platforms = new Set(urls.map(classifyUrl).filter((value) => value !== undefined));
  const hasUnrecognizedUrl = urls.some((url) => classifyUrl(url) === undefined);

  if (platforms.size !== 1 || hasUnrecognizedUrl) {
    return undefined;
  }

  return platforms.values().next().value;
}

function textContainsOnlyUrls(text: string, urls: readonly string[]): boolean {
  let remainder = text;
  for (const url of urls) {
    remainder = remainder.replace(url, "");
  }
  return remainder.trim().length === 0;
}

function deriveKind(
  rawText: string | undefined,
  urls: readonly string[],
  attachments: readonly CaptureAttachment[] | undefined,
): CaptureKind {
  const hasAttachments = (attachments?.length ?? 0) > 0;
  const hasNonUrlText =
    rawText !== undefined && rawText.trim().length > 0 && !textContainsOnlyUrls(rawText, urls);
  const hasUrls = urls.length > 0;
  const contentKinds = Number(hasNonUrlText) + Number(hasUrls) + Number(hasAttachments);

  if (contentKinds > 1) return "mixed";
  if (hasNonUrlText) return "text";
  if (hasUrls) return "link";
  if (hasAttachments) return "attachment";
  return "unknown";
}

export function normalizeCaptureInput(input: ProviderNeutralCaptureInput): NormalizedCapture {
  const urls = extractUrls(input.rawText);
  const sourcePlatform = deriveSourcePlatform(urls);

  return {
    channel: input.channel,
    kind: deriveKind(input.rawText, urls, input.attachments),
    rawText: input.rawText,
    userNote: input.userNote,
    externalMessageId: input.externalMessageId,
    capturedAt: input.capturedAt,
    rawProviderPayload: input.rawProviderPayload,
    attachments: input.attachments,
    urls,
    ...(sourcePlatform === undefined ? {} : { sourcePlatform }),
  };
}
