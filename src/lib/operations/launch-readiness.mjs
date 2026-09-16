import { pathToFileURL } from "node:url";

export const CAPABILITIES = [
  "WhatsApp capture",
  "media retrieval",
  "inbound email",
  "intent processing",
  "source processing",
  "segment processing",
  "scheduled job dispatch",
  "private research console",
];

const ALL_SERVER_CAPABILITIES = CAPABILITIES.filter(
  (capability) => capability !== "private research console",
);

const nonBlank = (value) => typeof value === "string" && value.trim().length > 0;
const opaque = (minimum = 16) => (value) =>
  nonBlank(value) && value.length >= minimum && !/\s/u.test(value);
const uuid = (value) =>
  nonBlank(value) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const model = (value) => nonBlank(value) && /^[a-z0-9][a-z0-9._:-]*$/iu.test(value);
const boundedInteger = (maximum) => (value) => {
  if (!nonBlank(value) || !/^\d+$/u.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum;
};

function safeHttpsUrl(value, expectedPath) {
  if (!nonBlank(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!expectedPath || url.pathname === expectedPath)
    );
  } catch {
    return false;
  }
}

function notForNowWebhook(value) {
  if (!safeHttpsUrl(value, "/api/inbound/whatsapp")) return false;
  return new URL(value).origin === "https://notfor.now";
}

function httpsOrigin(value) {
  if (!safeHttpsUrl(value)) return false;
  const url = new URL(value);
  return url.pathname === "/" && !url.port;
}

/**
 * The production configuration contract. Values never enter this data structure or its output;
 * only variable names, operational metadata and fixed validation labels do.
 */
export const ENVIRONMENT_CONTRACT = [
  {
    name: "SUPABASE_URL",
    surface: "Vercel server environment",
    sensitivity: "server-only",
    capabilities: ALL_SERVER_CAPABILITIES,
    absent: "server persistence and workers fail closed",
    validate: httpsOrigin,
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    surface: "Vercel server environment",
    sensitivity: "secret",
    capabilities: ALL_SERVER_CAPABILITIES,
    absent: "server persistence and workers fail closed",
    validate: opaque(24),
  },
  {
    name: "TWILIO_AUTH_TOKEN",
    surface: "Vercel server environment",
    sensitivity: "secret",
    capabilities: ["WhatsApp capture", "media retrieval"],
    absent: "webhook rejects and media retrieval is unavailable",
    validate: opaque(24),
  },
  {
    name: "TWILIO_WEBHOOK_URL",
    surface: "Vercel server environment",
    sensitivity: "server-only",
    capabilities: ["WhatsApp capture"],
    absent: "signature verification fails closed",
    validate: notForNowWebhook,
  },
  {
    name: "TWILIO_CAPTURE_USER_ID",
    surface: "Vercel server environment",
    sensitivity: "server-only identifier",
    capabilities: ["WhatsApp capture"],
    absent: "webhook cannot assign an owner and fails closed",
    validate: uuid,
  },
  {
    name: "ANTHROPIC_API_KEY",
    surface: "Vercel server environment",
    sensitivity: "secret",
    capabilities: ["intent processing", "source processing", "segment processing"],
    absent: "model-backed jobs fail without publishing an analysis",
    validate: opaque(24),
  },
  {
    name: "ANTHROPIC_INTENT_MODEL",
    surface: "Vercel server environment",
    sensitivity: "server-only",
    capabilities: ["intent processing"],
    absent: "intent jobs fail closed",
    validate: model,
  },
  {
    name: "ANTHROPIC_RESOLUTION_MODEL",
    surface: "Vercel server environment",
    sensitivity: "server-only",
    capabilities: ["source processing"],
    absent: "source-resolution jobs fail closed",
    validate: model,
  },
  {
    name: "ANTHROPIC_SEGMENT_MODEL",
    surface: "Vercel server environment",
    sensitivity: "server-only",
    capabilities: ["segment processing"],
    absent: "segment-resolution jobs fail closed",
    validate: model,
  },
  {
    name: "SEGMENT_SOURCE_MAX_BYTES",
    surface: "Vercel server environment",
    sensitivity: "server-only",
    capabilities: ["segment processing"],
    absent: "defaults safely to 131072 bytes; invalid values fail the job",
    required: false,
    validate: boundedInteger(2 * 1024 * 1024),
  },
  {
    name: "JOBS_PROCESS_SECRET",
    surface: "Vercel server environment and matching Supabase Vault entry",
    sensitivity: "secret",
    capabilities: ["scheduled job dispatch"],
    absent: "processor endpoint is disabled with HTTP 503",
    validate: opaque(32),
  },
  {
    name: "TWILIO_ACCOUNT_SID",
    surface: "Vercel server environment",
    sensitivity: "server-only identifier",
    capabilities: ["media retrieval"],
    absent: "media jobs fail closed without a download",
    validate: (value) => nonBlank(value) && /^AC[0-9a-f]{32}$/iu.test(value),
  },
  {
    name: "CAPTURE_MEDIA_MAX_BYTES",
    surface: "Vercel server environment",
    sensitivity: "server-only",
    capabilities: ["media retrieval"],
    absent: "defaults safely to 5242880 bytes; invalid values fail the job",
    required: false,
    validate: boundedInteger(20 * 1024 * 1024),
  },
  {
    name: "RESEND_WEBHOOK_SECRET",
    surface: "Vercel server environment",
    sensitivity: "secret",
    capabilities: ["inbound email"],
    absent: "email webhook rejects requests",
    validate: opaque(16),
  },
  {
    name: "EMAIL_INBOUND_TOKEN",
    surface: "Vercel server environment and Resend inbound address",
    sensitivity: "secret routing token",
    capabilities: ["inbound email"],
    absent: "signed mail is acknowledged but not captured",
    validate: (value) => nonBlank(value) && /^[a-z0-9._-]{12,}$/iu.test(value),
  },
  {
    name: "EMAIL_CAPTURE_USER_ID",
    surface: "Vercel server environment",
    sensitivity: "server-only identifier",
    capabilities: ["inbound email"],
    absent: "email webhook cannot assign an owner and fails closed",
    validate: uuid,
  },
  {
    name: "RESEND_API_KEY",
    surface: "Vercel server environment",
    sensitivity: "secret",
    capabilities: ["inbound email"],
    absent: "email enrichment stays unavailable; capture evidence remains",
    validate: opaque(16),
  },
  {
    name: "RESEND_API_BASE_URL",
    surface: "Vercel server environment",
    sensitivity: "server-only",
    capabilities: ["inbound email"],
    absent: "defaults safely to https://api.resend.com; invalid values fail enrichment",
    required: false,
    validate: httpsOrigin,
  },
  {
    name: "EMAIL_MAX_BYTES",
    surface: "Vercel server environment",
    sensitivity: "server-only",
    capabilities: ["inbound email"],
    absent: "defaults safely to 5242880 bytes; invalid values fail enrichment",
    required: false,
    validate: boundedInteger(20 * 1024 * 1024),
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    surface: "Vercel browser environment",
    sensitivity: "browser-safe",
    capabilities: ["private research console"],
    absent: "research API authentication fails closed",
    validate: httpsOrigin,
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    surface: "Vercel browser environment",
    sensitivity: "browser-safe public key",
    capabilities: ["private research console"],
    absent: "research API authentication fails closed",
    validate: opaque(24),
  },
  {
    name: "RESEARCH_USER_ID",
    surface: "Vercel server environment and Supabase Auth user",
    sensitivity: "server-only identifier",
    capabilities: ["private research console"],
    absent: "console denies every evaluator",
    validate: uuid,
  },
];

export const PRODUCTION_ENDPOINTS = [
  "POST /api/inbound/whatsapp",
  "POST /api/inbound/email",
  "POST /api/jobs/process",
  "GET /api/research/next",
  "POST /api/research/recall",
  "GET /api/research/reveal",
  "POST /api/research/rating",
  "GET /research",
];

export const BACKGROUND_QUEUES = [
  "intent_analysis",
  "media_download",
  "email_enrichment",
  "source_resolution",
  "segment_resolution",
];

export function evaluateLaunchReadiness(environment = process.env) {
  const issues = [];

  for (const entry of ENVIRONMENT_CONTRACT) {
    const value = environment[entry.name];
    if (!nonBlank(value)) {
      if (entry.required !== false) {
        issues.push({ name: entry.name, capabilities: entry.capabilities, reason: "missing" });
      }
      continue;
    }
    if (!entry.validate(value)) {
      issues.push({ name: entry.name, capabilities: entry.capabilities, reason: "malformed" });
    }
  }

  if (
    nonBlank(environment.SUPABASE_URL) &&
    nonBlank(environment.NEXT_PUBLIC_SUPABASE_URL) &&
    environment.SUPABASE_URL !== environment.NEXT_PUBLIC_SUPABASE_URL
  ) {
    issues.push({
      name: "NEXT_PUBLIC_SUPABASE_URL",
      capabilities: ["private research console"],
      reason: "does not match SUPABASE_URL",
    });
  }

  const capabilities = CAPABILITIES.map((name) => ({
    name,
    ready: !issues.some((issue) => issue.capabilities.includes(name)),
  }));

  return { ok: issues.length === 0, capabilities, issues };
}

export function formatLaunchReadiness(result) {
  const lines = [`Launch readiness: ${result.ok ? "READY" : "NOT READY"}`];
  for (const capability of result.capabilities) {
    lines.push(`- [${capability.ready ? "ready" : "not ready"}] ${capability.name}`);
  }
  if (result.issues.length > 0) {
    lines.push("Configuration issues:");
    for (const issue of result.issues) lines.push(`- ${issue.name}: ${issue.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {NodeJS.ProcessEnv} environment
 * @param {{ write: (chunk: string) => unknown }} output
 */
export function runLaunchReadiness(environment = process.env, output = process.stdout) {
  const result = evaluateLaunchReadiness(environment);
  output.write(formatLaunchReadiness(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runLaunchReadiness();
}
