# Private captured media

`persist_capture_with_intent_job` commits one `media_download` job per newly captured
WhatsApp asset in the same transaction as the capture and initial intent job. The
webhook performs no binary work and keeps its fixed acknowledgement. Only new captures
are enqueued; this migration does not backfill old media.

The existing authenticated job endpoint alternates intent and media queues, processing
at most two jobs per request. Deploy the migration before running the new worker code.
Server configuration adds `TWILIO_ACCOUNT_SID` and `CAPTURE_MEDIA_MAX_BYTES` alongside the
existing Twilio auth token. The default ceiling is 5 MiB; allowed configuration is 1 byte
through 20 MiB. No deployment is performed by the task's tests.

Requests permit only HTTPS `api.twilio.com` media paths for the configured account
(`SM` or `MM` message SID and `ME` media SID), or `mms.twiliocdn.com`. Redirects are manual,
limited to three, and revalidated before each request. Account credentials are sent only
to the approved API path; CDN requests receive no Authorization header. Provider URLs
remain in original private metadata, never in the model input snapshot.

Downloads have a 20-second total deadline, enforce the declared and streamed byte size,
and compare webhook MIME, response MIME and known binary signatures. Active HTML/SVG/
JavaScript and recognized executable payloads are rejected. Unknown unsupported binary
formats remain private originals when no known signature contradicts their declaration;
this is format validation, not an antivirus scanner. No binary is transformed. Uploads
use the precomputed path in `capture-assets` with `upsert: false`. A retry first checks for
an already committed object, allowing recovery after upload but before database receipt.
An upload collision must match the original digest; it cannot overwrite the object.
Storage requests have 15-second deadlines.

Invalid destinations, unsafe content, MIME/size mismatches and missing media fail
terminally with allowlisted codes. Transient failures use three total leases, with
one/two-minute retry delays and ten-minute lease expiry. A crashed final attempt becomes
terminal on the next sweep. Captures and original provider metadata are never rewritten.
After all assets are stored/failed and the initial intent job is completed/failed, a
capture lock and unique index schedule one enriched intent job. Its attempts append
analysis rows using separate media prompt/pipeline versions.

Only JPEG, PNG, GIF and WebP content is sent to Anthropic. The image transport is separate
from the persisted snapshot, which records asset ID, SHA-256, observed MIME, byte size,
state and whether content was supplied. Each model image is at most 5 MiB and the batch is
at most 20 images/20 MiB before base64; larger images remain originals with an explicit
metadata-only size-limit reason. Eligible private images load concurrently under the
bounded batch size and are checked against stored size/digest. Audio/video/documents are
always metadata-only. Initial analyses remain metadata-only even if media finished first.

## Validation

Run the configured `pnpm build`, `pnpm lint`, `pnpm test`, and `pnpm test:coverage` gates.
Unit tests always run; real HTTP/storage tests additionally require an isolated Supabase
stack whose API is **http://127.0.0.1:55321**. They refuse any other URL. Generate its local
connection file with `supabase status --workdir <isolated-project> -o env > <local-env-file>`,
then set `LATER_MEDIA_LOCAL_ENV=<local-env-file>` when running the test/coverage commands.
Do not commit that local connection file. These tests create two temporary authenticated
users, exercise signed webhooks and real private object storage, and delete their fixtures.

Run all SQL tests on that isolated stack using `supabase test db --workdir <isolated-project>
--db-url <local-admin-connection>`. The pre-existing independent-session concurrency test
requires the local `supabase_admin` administrator for dblink trust authentication. Never
reset or run these fixtures against a live database.

Protocol references: [Twilio media resource](https://www.twilio.com/docs/messaging/api/media-resource),
[Twilio protected-media domains](https://help.twilio.com/articles/223183748-Prevent-Unauthorized-Access-to-Your-Media-with-HTTP-Basic-Auth),
[Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision).
