/**
 * My Health Angel CRM — backend Worker (Cloudflare)
 * ------------------------------------------------------------------
 * Three jobs:
 *  1. Compliance Workflow board (GET/POST /monday/*) — reads and writes the
 *     MHA Compliance board directly via Monday's GraphQL API, replacing the
 *     Monday "Vibe" app's generated BoardSDK with hand-written GraphQL. The
 *     Monday API token never touches the browser. Board and column IDs are
 *     resolved BY NAME at request time (not hardcoded), and cached in
 *     COMPLIANCE_KV for 15 minutes to avoid re-resolving on every request.
 *  2. Partner Portal admin (GET/POST /partner-admin/*) — the admin side of
 *     the CRM's Partner Portal (a separate Supabase-backed system). Organization
 *     CRUD and partner user invite/manage, using the Supabase service_role
 *     key (bypasses Row Level Security -- this is the privileged admin path,
 *     deliberately kept server-side). The client-facing partner site is a
 *     separate, standalone deploy and does NOT go through this Worker at all
 *     -- it talks to Supabase directly with the public anon key, protected
 *     by RLS.
 *  3. 1:1 Comparison (POST /compare-summary, POST /fetch-url) — /compare-summary
 *     writes a narrative compliance readout of an already-computed diff
 *     (grouped by document section, compliance-relevant vs. cosmetic). It
 *     does NOT do the diffing itself; the client sends the already-extracted
 *     content changes so the model's job is judgment/narration, not
 *     re-deriving what changed. /fetch-url proxies a live web page server-side
 *     (the browser can't fetch a third-party page itself due to CORS) and
 *     strips it to plain text for the "URL vs document" comparison mode.
 *
 * Required Worker settings (set in the Cloudflare dashboard):
 *   Secret     STORAGE_SHARED_KEY       = a random string (also set as
 *                                         APEX_STORAGE_KEY in index.html —
 *                                         they must match)
 *   Secret     MONDAY_API_TOKEN         = a Monday API v2 token with
 *                                         read/write access to the MHA
 *                                         Compliance board (Monday admin >
 *                                         Admin > API, or a personal token
 *                                         under your avatar > Developers >
 *                                         My Access Tokens)
 *   Secret     SUPABASE_SERVICE_ROLE_KEY = your Supabase project's
 *                                         service_role key (Settings > API)
 *                                         — NOT the anon key, this one
 *                                         bypasses RLS
 *   Variable   SUPABASE_URL             = your Supabase project's URL
 *                                         (e.g. https://your-project-ref.supabase.co)
 *   Secret     ALLEGATION_WEBHOOK_SECRET = a random string the allegations
 *                                         table's INSERT trigger sends back
 *                                         as the x-webhook-secret header on
 *                                         POST /allegations/notify — proves
 *                                         the call came from Supabase's
 *                                         pg_net, not a random request
 *   Secret     RESEND_API_KEY           = a Resend (resend.com) API key —
 *                                         powers the "new allegation"
 *                                         notification email
 *   Variable   ALLEGATION_NOTIFY_EMAIL  = the address (or comma-separated
 *                                         list of addresses) that gets
 *                                         emailed on every new allegation
 *                                         submission — for My Health Angel,
 *                                         that's compliance@myhealthangel.com
 *   Variable   ALLEGATION_NOTIFY_FROM   = the Resend "from" address for the
 *                                         new-allegation email. Falls back to
 *                                         onboarding@resend.dev if unset, but
 *                                         that test sender ONLY delivers to
 *                                         the Resend account owner's own
 *                                         address — so in practice this must
 *                                         be an address on a domain verified
 *                                         in Resend (e.g.
 *                                         compliance@myhealthangel.com)
 *   Secret     TASK_WEBHOOK_SECRET      = same idea as ALLEGATION_WEBHOOK_SECRET
 *                                         but for the tasks table's INSERT
 *                                         trigger -> POST /tasks/notify
 *   Variable   TASK_NOTIFY_FROM         = the Resend "from" address for the
 *                                         "task assigned to you" email sent
 *                                         to the assigned admin. Same
 *                                         verified-domain requirement as
 *                                         ALLEGATION_NOTIFY_FROM.
 *
 *   Secret     ANTHROPIC_API_KEY        = your sk-ant-... key — powers the
 *                                         Video Submission Builder's
 *                                         on-screen-text OCR step
 *                                         (handleVideoOcrScreenshot calls
 *                                         Claude's vision API directly) and
 *                                         the 1:1 Comparison AI summary
 *                                         (handleCompareSummary, job 3 above).
 *   Variable   MODEL (optional)         = claude-sonnet-5   (default if unset)
 *   KV binding COMPLIANCE_KV            = a Workers KV namespace (create one
 *                                         in Storage & Databases > KV, then
 *                                         bind it here under Settings >
 *                                         Bindings)
 *   AI binding AI                       = a Workers AI binding (Settings >
 *                                         Bindings > Add > Workers AI, bind
 *                                         it as `AI`) — powers the Video
 *                                         Submission Builder's voiceover
 *                                         transcription (Whisper). Nothing
 *                                         else in this file depends on it.
 *   R2 binding VIDEO_R2                 = a Cloudflare R2 bucket (Storage &
 *                                         Databases > R2, create a bucket,
 *                                         then bind it here under Settings >
 *                                         Bindings > Add > R2 Bucket, name it
 *                                         VIDEO_R2) — holds the Video
 *                                         Submission Builder's raw video
 *                                         files and scene screenshots.
 *
 * A fourth job, Video Submission Builder (GET/POST /partner-admin/video*),
 * lives in the same Partner Portal admin section as job 2 but is its OWN
 * standalone tool -- it is never nested inside a material record. Admin
 * starts a new video submission, uploads a video, marks scenes by scrubbing
 * through it, and each scene gets a real captured screenshot plus two
 * AI-assisted drafts admin reviews before export -- on-screen text (Claude
 * vision reads the screenshot) and a voiceover transcript (Workers AI
 * Whisper reads that scene's audio, recorded client-side since a Worker
 * can't decode video). Only once admin explicitly finishes does an optional
 * "Create Marketing Material" step create a materials row and link it --
 * the source video and scene screenshots are never copied into the
 * partner-readable materials bucket, so a partner org can never see or
 * reach the video/submission-document tool itself, regardless of sharing.
 * Own tables + own admin-only bucket, same overall pattern as Internal
 * Status and the other admin-only creative details -- except the video/
 * screenshot files themselves live in Cloudflare R2 (binding VIDEO_R2), not
 * Supabase Storage, because Supabase's Free-plan 50MB-per-object cap can't
 * hold a real submission video. Playback/download go through this Worker's
 * own /partner-admin/video/stream route instead of a Supabase signed URL.
 *
 * NOTE ON SECURITY: STORAGE_SHARED_KEY is a static shared secret embedded in
 * the client, not real per-user auth — it stops casual/accidental access,
 * not a determined attacker. If the admin app is hosted somewhere public,
 * consider putting this Worker's routes behind a real access-control layer
 * (e.g. Cloudflare Access on a custom domain) rather than relying on the
 * shared secret alone.
 */

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-apex-key"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (url.pathname === "/monday/items") {
      return handleMondayItems(request, env, cors, url);
    }
    if (url.pathname === "/monday/item/status") {
      return handleMondayUpdateStatus(request, env, cors);
    }
    if (url.pathname === "/monday/item/update") {
      return handleMondayCreateUpdate(request, env, cors);
    }
    if (url.pathname === "/monday/item/create") {
      return handleMondayCreateItem(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs") {
      return handlePartnerOrgsList(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/create") {
      return handlePartnerOrgCreate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/update") {
      return handlePartnerOrgUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/delete") {
      return handlePartnerOrgDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/logo/upload") {
      return handlePartnerOrgLogoUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/logo/delete") {
      return handlePartnerOrgLogoDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/msa-docs") {
      return handleOrgMsaDocsList(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/orgs/msa-docs/upload") {
      return handleOrgMsaDocUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/msa-docs/update") {
      return handleOrgMsaDocUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/msa-docs/delete") {
      return handleOrgMsaDocDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/msa-docs/download-url") {
      return handleOrgMsaDocDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/orgs/submission-form-file/upload") {
      return handlePartnerOrgSubmissionFormFileUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/submission-form-file/delete") {
      return handlePartnerOrgSubmissionFormFileDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/submission-form-file/download-url") {
      return handlePartnerOrgSubmissionFormFileDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/orgs/guideline-docs") {
      return handleOrgGuidelineDocsList(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/orgs/guideline-docs/upload") {
      return handleOrgGuidelineDocUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/guideline-docs/delete") {
      return handleOrgGuidelineDocDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/guideline-docs/download-url") {
      return handleOrgGuidelineDocDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/orgs/portal-logins") {
      return handleOrgPortalLoginsList(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/orgs/portal-logins/create") {
      return handleOrgPortalLoginCreate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/portal-logins/update") {
      return handleOrgPortalLoginUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/portal-logins/delete") {
      return handleOrgPortalLoginDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/submission-forms") {
      return handleOrgSubmissionFormsList(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/orgs/submission-forms/create") {
      return handleOrgSubmissionFormCreate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/submission-forms/update") {
      return handleOrgSubmissionFormUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/orgs/submission-forms/delete") {
      return handleOrgSubmissionFormDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers") {
      return handleCarriersList(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/create") {
      return handleCarrierCreate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/update") {
      return handleCarrierUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/logo/upload") {
      return handleCarrierLogoUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/logo/delete") {
      return handleCarrierLogoDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/submission-form-file/upload") {
      return handleCarrierSubmissionFormFileUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/submission-form-file/delete") {
      return handleCarrierSubmissionFormFileDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/submission-form-file/download-url") {
      return handleCarrierSubmissionFormFileDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/allegations") {
      return handleAllegationsList(request, env, cors);
    }
    if (url.pathname === "/partner-admin/allegations/update") {
      return handleAllegationUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/allegations/delete") {
      return handleAllegationDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/allegations/audio/upload") {
      return handleAllegationAudioUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/allegations/audio/delete") {
      return handleAllegationAudioDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/allegations/audio/download-url") {
      return handleAllegationAudioDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/allegations/documents/upload") {
      return handleAllegationDocumentUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/allegations/documents/delete") {
      return handleAllegationDocumentDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/allegations/documents/download-url") {
      return handleAllegationDocumentDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/allegations/notify") {
      return handleAllegationNotify(request, env, cors);
    }
    if (url.pathname === "/partner-admin/tasks") {
      return handleTasksList(request, env, cors);
    }
    if (url.pathname === "/partner-admin/tasks/create") {
      return handleTaskCreate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/tasks/update") {
      return handleTaskUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/tasks/delete") {
      return handleTaskDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/tasks/files/upload") {
      return handleTaskFileUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/tasks/files/delete") {
      return handleTaskFileDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/tasks/files/download-url") {
      return handleTaskFileDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/admin-users") {
      return handleAdminUsersList(request, env, cors);
    }
    if (url.pathname === "/tasks/notify") {
      return handleTaskNotify(request, env, cors);
    }
    if (url.pathname === "/partner-admin/apex-logins") {
      return handleApexOperationalLoginsList(request, env, cors);
    }
    if (url.pathname === "/partner-admin/apex-logins/create") {
      return handleApexOperationalLoginCreate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/apex-logins/update") {
      return handleApexOperationalLoginUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/apex-logins/delete") {
      return handleApexOperationalLoginDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/apex-logins/logo/upload") {
      return handleApexOperationalLoginLogoUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/apex-logins/logo/delete") {
      return handleApexOperationalLoginLogoDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/guidelines") {
      return handleCarrierGuidelineDocsList(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/carriers/guidelines/upload") {
      return handleCarrierGuidelineDocUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/guidelines/delete") {
      return handleCarrierGuidelineDocDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/guidelines/download-url") {
      return handleCarrierGuidelineDocDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/carriers/contacts") {
      return handleCarrierContactsList(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/carriers/contacts/create") {
      return handleCarrierContactCreate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/contacts/update") {
      return handleCarrierContactUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/carriers/contacts/delete") {
      return handleCarrierContactDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/users") {
      return handlePartnerUsersList(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/users/invite") {
      return handlePartnerUserInvite(request, env, cors);
    }
    if (url.pathname === "/partner-admin/users/update") {
      return handlePartnerUserUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/users/send-reset-email") {
      return handlePartnerUserSendResetEmail(request, env, cors);
    }
    if (url.pathname === "/partner-admin/users/set-password") {
      return handlePartnerUserSetPassword(request, env, cors);
    }
    if (url.pathname === "/partner-admin/users/delete") {
      return handlePartnerUserDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials") {
      return handlePartnerMaterialsList(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/detail") {
      return handlePartnerMaterialDetail(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/materials/create") {
      return handlePartnerMaterialCreate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/update") {
      return handlePartnerMaterialUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/delete") {
      return handlePartnerMaterialDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/geotargeting-grid/link") {
      return handleMaterialGeotargetingGridLink(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/geotargeting-grid/download-url") {
      return handleMaterialGeotargetingGridDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/geotargeting-grids/list") {
      return handleGeotargetingGridsList(request, env, cors);
    }
    if (url.pathname === "/partner-admin/geotargeting-grids/upload") {
      return handleGeotargetingGridUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/geotargeting-grids/replace") {
      return handleGeotargetingGridReplace(request, env, cors);
    }
    if (url.pathname === "/partner-admin/geotargeting-grids/delete") {
      return handleGeotargetingGridDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/optins/upsert") {
      return handlePartnerOptinUpsert(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/optins/delete") {
      return handlePartnerOptinDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/shares/toggle") {
      return handlePartnerShareToggle(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/upload-file") {
      return handlePartnerFileUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/files/delete") {
      return handlePartnerFileDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/files/download-url") {
      return handlePartnerFileDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/materials/messages") {
      return handlePartnerMaterialMessages(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/materials/messages/all") {
      return handlePartnerAllMaterialMessages(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/messages/send") {
      return handlePartnerMaterialMessageSend(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/statuses") {
      return handlePartnerMaterialStatuses(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/materials/statuses/update") {
      return handlePartnerOrgStatusUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/audit") {
      return handlePartnerAudit(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/backup") {
      return handlePartnerBackup(request, env, cors);
    }
    if (url.pathname === "/partner-admin/recent-activity") {
      return handlePartnerRecentActivity(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/video/submissions") {
      return handleVideoSubmissionsList(request, env, cors);
    }
    if (url.pathname === "/partner-admin/video/submissions/create") {
      return handleVideoSubmissionCreate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/video/submissions/update") {
      return handleVideoSubmissionUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/video/submissions/delete") {
      return handleVideoSubmissionDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/video/submissions/create-material") {
      return handleVideoSubmissionCreateMaterial(request, env, cors);
    }
    if (url.pathname === "/partner-admin/video/stream") {
      return handleVideoStream(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/video/upload") {
      return handleVideoUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/video") {
      return handleVideoGet(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/video/delete") {
      return handleVideoDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/video/scenes/create") {
      return handleVideoSceneCreate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/video/scenes/update") {
      return handleVideoSceneUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/video/scenes/delete") {
      return handleVideoSceneDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/video/scenes/screenshot-url") {
      return handleVideoSceneScreenshotUrl(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/video/ocr-screenshot") {
      return handleVideoOcrScreenshot(request, env, cors);
    }
    if (url.pathname === "/partner-admin/video/transcribe-audio") {
      return handleVideoTranscribeAudio(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/internal-status/update") {
      return handlePartnerInternalStatusUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/admin-details/update") {
      return handlePartnerAdminDetailsUpdate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/admin-files/upload") {
      return handlePartnerAdminFileUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/admin-files/delete") {
      return handlePartnerAdminFileDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/admin-files/download-url") {
      return handlePartnerAdminFileDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/partner-admin/materials/updates/create") {
      return handleMaterialUpdateCreate(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/updates/delete") {
      return handleMaterialUpdateDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/updates/files/upload") {
      return handleMaterialUpdateFileUpload(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/updates/files/delete") {
      return handleMaterialUpdateFileDelete(request, env, cors);
    }
    if (url.pathname === "/partner-admin/materials/updates/files/download-url") {
      return handleMaterialUpdateFileDownloadUrl(request, env, cors, url);
    }
    if (url.pathname === "/compare-summary") {
      return handleCompareSummary(request, env, cors);
    }
    if (url.pathname === "/fetch-url") {
      return handleFetchUrl(request, env, cors);
    }

    return json({ ok: false, error: "Not found." }, 404, cors);
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors }
  });
}

// Unguessable placeholder for a partner login's underlying Auth account
// when the admin saves a contact without assigning a real password yet --
// never surfaced to the client, never meant to be used to sign in.
function generateRandomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(36);
  return out.slice(0, 32) + "Aa1!";
}

// ---------- Compliance Workflow board (Monday integration) ----------
// Replaces the Monday "Vibe" app's generated BoardSDK (which only exists
// inside Monday's own build/hosting platform) with direct calls to Monday's
// public GraphQL API. Same auth gate as the rest of this Worker's routes
// (STORAGE_SHARED_KEY via x-apex-key) -- this is an internal-team route, not
// a substitute for real per-user Monday auth.
const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_API_VERSION = "2024-10";
const MONDAY_BOARD_NAMES = { mha: "MHA Compliance" };
// Friendly field -> candidate column titles (checked case-insensitively).
// Lists every title variant actually in use on the board (e.g. the board
// may combine planType/materialType into a single "plan types represented"
// column, or split them) so resolution works without hardcoding one exact
// schema.
const MONDAY_FIELD_TITLES = {
  owner: ["owner"],
  status: ["status"],
  batchId: ["batch id", "batch"],
  previousSmid: ["previous smid", "smid"],
  landingPageUrlSmid: ["landing page url/smid", "landing page url", "landing page"],
  planType: ["plan type", "plan types represented"],
  materialType: ["material type", "type"],
  notes: ["notes"]
};

function mondayAuthCheck(request, env, cors) {
  if (!env.STORAGE_SHARED_KEY) {
    return json({ ok: false, error: "Server is missing STORAGE_SHARED_KEY. Add it as a Worker Secret." }, 500, cors);
  }
  const provided = request.headers.get("x-apex-key") || "";
  if (provided !== env.STORAGE_SHARED_KEY) {
    return json({ ok: false, error: "Unauthorized." }, 401, cors);
  }
  if (!env.MONDAY_API_TOKEN) {
    return json({ ok: false, error: "Server is missing MONDAY_API_TOKEN. Add it in the Worker's Settings > Variables and Secrets." }, 500, cors);
  }
  return null; // ok
}

async function mondayGraphQL(env, query, variables) {
  const resp = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": env.MONDAY_API_TOKEN,
      "API-Version": MONDAY_API_VERSION
    },
    body: JSON.stringify({ query: query, variables: variables || {} })
  });
  const data = await resp.json().catch(function () { return null; });
  if (!resp.ok || !data || data.errors) {
    const msg = (data && data.errors && data.errors.length) ? data.errors.map(function (e) { return e.message; }).join("; ") : ("HTTP " + resp.status);
    throw new Error("Monday API error: " + msg);
  }
  return data.data;
}

// Resolves {mha:{id, columns:{owner:'col_id', status:'col_id', ...}, statusColType:'color'|'text'}}
// by matching board names and column titles, cached in KV for 15 min so a
// page full of item fetches doesn't re-resolve schema every time.
async function resolveMondaySchema(env) {
  const CACHE_KEY = "apex_compliance_monday_schema_v1";
  if (env.COMPLIANCE_KV) {
    const cached = await env.COMPLIANCE_KV.get(CACHE_KEY, "json").catch(function () { return null; });
    if (cached && cached._cachedAt && (Date.now() - cached._cachedAt) < 15 * 60 * 1000) return cached;
  }

  const data = await mondayGraphQL(env, "query { boards (limit: 200) { id name columns { id title type } } }");
  const boards = (data && data.boards) || [];
  const schema = { _cachedAt: Date.now() };

  Object.keys(MONDAY_BOARD_NAMES).forEach(function (key) {
    const wantName = MONDAY_BOARD_NAMES[key].trim().toLowerCase();
    const board = boards.filter(function (b) { return (b.name || "").trim().toLowerCase() === wantName; })[0];
    if (!board) return; // left undefined; callers must check
    const columns = {};
    let statusColType = null;
    Object.keys(MONDAY_FIELD_TITLES).forEach(function (field) {
      const candidates = MONDAY_FIELD_TITLES[field];
      const col = board.columns.filter(function (c) {
        return candidates.indexOf((c.title || "").trim().toLowerCase()) !== -1;
      })[0];
      if (col) {
        columns[field] = col.id;
        if (field === "status") statusColType = col.type;
      }
    });
    schema[key] = { id: board.id, name: board.name, columns: columns, statusColType: statusColType };
  });

  if (env.COMPLIANCE_KV) {
    await env.COMPLIANCE_KV.put(CACHE_KEY, JSON.stringify(schema), { expirationTtl: 900 }).catch(function () {});
  }
  return schema;
}

// Monday's `text` field on column_values gives a decent plain-text rendition
// for every column type (status label, comma-joined people names, comma
// -joined tag names, date, etc.) -- used everywhere here instead of per-type
// GraphQL fragments so this stays robust to column-type differences across
// the three boards without needing to special-case each type.
function mondayItemToCard(item, boardKey, boardLabel, columns) {
  function colText(field) {
    var colId = columns[field];
    if (!colId) return null;
    var cv = (item.column_values || []).filter(function (c) { return c.id === colId; })[0];
    return cv ? cv.text : null;
  }
  var ownerText = colText("owner");
  var batchText = colText("batchId");
  return {
    id: String(item.id),
    name: item.name,
    boardKey: boardKey,
    boardName: boardLabel,
    status: colText("status") || null,
    owner: ownerText ? ownerText.split(",").map(function (n, idx) { return { id: idx, kind: "person", name: n.trim() }; }).filter(function (p) { return p.name; }) : [],
    batchId: batchText ? batchText.split(",").map(function (t, idx) { return { id: idx, tag: t.trim() }; }).filter(function (t) { return t.tag; }) : [],
    previousSmid: colText("previousSmid"),
    landingPageUrlSmid: colText("landingPageUrlSmid"),
    planType: colText("planType"),
    materialType: colText("materialType"),
    notes: colText("notes"),
    updatedAt: item.updated_at || null,
    assets: (item.assets || []).map(function (a) { return { id: a.id, name: a.name, url: a.public_url || a.url }; }),
    updates: (item.updates || []).map(function (u) {
      return {
        id: u.id,
        text_body: u.text_body,
        created_at: u.created_at,
        creator: u.creator ? { name: u.creator.name } : null,
        assets: (u.assets || []).map(function (a) { return { id: a.id, name: a.name, url: a.public_url || a.url }; })
      };
    })
  };
}

async function fetchMondayBoardItems(env, boardEntry, limit) {
  const colIds = Object.keys(boardEntry.columns).map(function (f) { return boardEntry.columns[f]; });
  const query = "query ($boardId: ID!, $limit: Int, $colIds: [String!]) {" +
    " boards (ids: [$boardId]) {" +
    "   items_page (limit: $limit) {" +
    "     items {" +
    "       id name updated_at" +
    "       column_values (ids: $colIds) { id text }" +
    "       assets { id name public_url }" +
    "       updates (limit: 25) { id text_body created_at creator { name } assets { id name public_url } }" +
    "     }" +
    "   }" +
    " }" +
    "}";
  const data = await mondayGraphQL(env, query, { boardId: boardEntry.id, limit: limit || 100, colIds: colIds });
  const board = (data && data.boards && data.boards[0]) || null;
  return board ? (board.items_page.items || []) : [];
}

async function handleMondayItems(request, env, cors, url) {
  const authErr = mondayAuthCheck(request, env, cors);
  if (authErr) return authErr;

  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const statusFilter = url.searchParams.get("status") || "";
  const boardFilter = url.searchParams.get("board") || "all";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 250);

  let schema;
  try { schema = await resolveMondaySchema(env); }
  catch (e) { return json({ ok: false, error: "Could not resolve Monday board schema.", detail: String(e.message || e) }, 502, cors); }

  const wantKeys = (boardFilter === "all") ? Object.keys(MONDAY_BOARD_NAMES) : [boardFilter];
  let results = [];
  try {
    for (const key of wantKeys) {
      const entry = schema[key];
      if (!entry) continue; // board not found under expected name -- skip rather than fail the whole request
      const rawItems = await fetchMondayBoardItems(env, entry, limit);
      results = results.concat(rawItems.map(function (it) { return mondayItemToCard(it, key, entry.name, entry.columns); }));
    }
  } catch (e) {
    return json({ ok: false, error: "Could not fetch items from Monday.", detail: String(e.message || e) }, 502, cors);
  }

  if (search) {
    results = results.filter(function (it) { return (it.name || "").toLowerCase().indexOf(search) !== -1; });
  }
  if (statusFilter) {
    results = results.filter(function (it) { return it.status === statusFilter; });
  }
  results.sort(function (a, b) {
    return (new Date(b.updatedAt || 0).getTime()) - (new Date(a.updatedAt || 0).getTime());
  });

  return json({ ok: true, items: results, boardsFound: Object.keys(schema).filter(function (k) { return k !== "_cachedAt"; }) }, 200, cors);
}

async function handleMondayUpdateStatus(request, env, cors) {
  const authErr = mondayAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const boardKey = body.boardKey, itemId = body.itemId, status = body.status;
  if (!boardKey || !itemId || !status) return json({ ok: false, error: "boardKey, itemId, and status are required." }, 400, cors);

  let schema;
  try { schema = await resolveMondaySchema(env); }
  catch (e) { return json({ ok: false, error: "Could not resolve Monday board schema.", detail: String(e.message || e) }, 502, cors); }
  const entry = schema[boardKey];
  if (!entry || !entry.columns.status) return json({ ok: false, error: "Could not find a Status column on that board." }, 400, cors);

  const valueJson = entry.statusColType === "color" ? JSON.stringify({ label: status }) : JSON.stringify(status);
  const mutation = "mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {" +
    " change_column_value (board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }" +
    "}";
  try {
    await mondayGraphQL(env, mutation, { boardId: entry.id, itemId: itemId, columnId: entry.columns.status, value: valueJson });
  } catch (e) {
    return json({ ok: false, error: "Could not update status in Monday.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleMondayCreateUpdate(request, env, cors) {
  const authErr = mondayAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const itemId = body.itemId, text = (body.text || "").trim();
  if (!itemId || !text) return json({ ok: false, error: "itemId and text are required." }, 400, cors);

  const mutation = "mutation ($itemId: ID!, $body: String!) { create_update (item_id: $itemId, body: $body) { id } }";
  try {
    await mondayGraphQL(env, mutation, { itemId: itemId, body: text });
  } catch (e) {
    return json({ ok: false, error: "Could not post the update to Monday.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleMondayCreateItem(request, env, cors) {
  const authErr = mondayAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const boardKey = body.boardKey, name = (body.name || "").trim(), status = body.status;
  if (!boardKey || !name) return json({ ok: false, error: "boardKey and name are required." }, 400, cors);

  let schema;
  try { schema = await resolveMondaySchema(env); }
  catch (e) { return json({ ok: false, error: "Could not resolve Monday board schema.", detail: String(e.message || e) }, 502, cors); }
  const entry = schema[boardKey];
  if (!entry) return json({ ok: false, error: "Unknown board." }, 400, cors);

  let columnValues = {};
  if (status && entry.columns.status) {
    columnValues[entry.columns.status] = entry.statusColType === "color" ? { label: status } : status;
  }

  const mutation = "mutation ($boardId: ID!, $name: String!, $columnValues: JSON) {" +
    " create_item (board_id: $boardId, item_name: $name, column_values: $columnValues) { id }" +
    "}";
  let created;
  try {
    created = await mondayGraphQL(env, mutation, { boardId: entry.id, name: name, columnValues: JSON.stringify(columnValues) });
  } catch (e) {
    return json({ ok: false, error: "Could not create the item in Monday.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, id: created && created.create_item && created.create_item.id }, 200, cors);
}

// ---------- Partner Portal admin (Supabase) ----------
// Same auth gate as /storage and /monday/* (STORAGE_SHARED_KEY via x-apex-key).
// Uses the Supabase service_role key server-side only, which bypasses Row
// Level Security -- that's what makes this the admin path. The client-facing
// partner site never sees this key; it uses the public anon key and RLS.
//
// "Create organization" and "invite a partner login" are kept as two
// separate actions on purpose (an org can have more than one login), not
// combined into one form.
// Read from a Worker Variable/Secret (set SUPABASE_URL in the Cloudflare
// dashboard to your own Supabase project's URL, e.g.
// https://your-project-ref.supabase.co) rather than hardcoding a project ID.
function getSupabaseUrl(env) {
  if (!env.SUPABASE_URL) throw new Error("Server is missing SUPABASE_URL. Add it in the Worker's Settings > Variables and Secrets.");
  return env.SUPABASE_URL;
}

function partnerAdminAuthCheck(request, env, cors) {
  if (!env.STORAGE_SHARED_KEY) {
    return json({ ok: false, error: "Server is missing STORAGE_SHARED_KEY. Add it as a Worker Secret." }, 500, cors);
  }
  const provided = request.headers.get("x-apex-key") || "";
  if (provided !== env.STORAGE_SHARED_KEY) {
    return json({ ok: false, error: "Unauthorized." }, 401, cors);
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "Server is missing SUPABASE_SERVICE_ROLE_KEY. Add it in the Worker's Settings > Variables and Secrets." }, 500, cors);
  }
  return null; // ok
}

// PostgREST (table data: organizations, users, ...)
async function supabaseRest(env, path, options) {
  const opts = options || {};
  const resp = await fetch(getSupabaseUrl(env) + "/rest/v1/" + path, {
    method: opts.method || "GET",
    headers: Object.assign({
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
      "Prefer": opts.prefer || "return=representation"
    }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) {
    const msg = (data && (data.message || data.error_description || data.error)) || ("HTTP " + resp.status);
    throw new Error("Supabase error: " + msg);
  }
  return data;
}

// Auth Admin API (auth.users: invite, delete)
async function supabaseAuthAdmin(env, path, options) {
  const opts = options || {};
  const resp = await fetch(getSupabaseUrl(env) + "/auth/v1/" + path, {
    method: opts.method || "GET",
    headers: Object.assign({
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json"
    }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) {
    const msg = (data && (data.msg || data.message || data.error_description || data.error)) || ("HTTP " + resp.status);
    throw new Error("Supabase Auth error: " + msg);
  }
  return data;
}

async function handlePartnerOrgsList(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  let orgs;
  try {
    orgs = await supabaseRest(env, "organizations?select=id,name,active,created_at,submission_form_url,compliance_portal_url,med_supp_submission_form_url,med_supp_compliance_portal_url,logo_path,submission_form_file_path,submission_form_file_name,py26_materials_needing_submitted,py27_materials_needing_submitted,material_types_not_accepted,users(count)&order=name.asc");
  } catch (e) {
    return json({ ok: false, error: "Could not load organizations from Supabase.", detail: String(e.message || e) }, 502, cors);
  }
  const results = await Promise.all((orgs || []).map(async function (o) {
    let logoUrl = null;
    if (o.logo_path) {
      try { logoUrl = await supabaseStorageSignedUrl(env, o.logo_path, 1800, ORG_LOGO_BUCKET); } catch (e) { /* best-effort */ }
    }
    return {
      id: o.id, name: o.name, active: o.active, createdAt: o.created_at,
      userCount: (o.users && o.users[0] && o.users[0].count) || 0,
      submissionFormUrl: o.submission_form_url, compliancePortalUrl: o.compliance_portal_url,
      medSuppSubmissionFormUrl: o.med_supp_submission_form_url, medSuppCompliancePortalUrl: o.med_supp_compliance_portal_url,
      hasLogo: !!o.logo_path, logoUrl: logoUrl,
      submissionFormFileName: o.submission_form_file_name || null,
      py26MaterialsNeedingSubmitted: !!o.py26_materials_needing_submitted,
      py27MaterialsNeedingSubmitted: !!o.py27_materials_needing_submitted,
      materialTypesNotAccepted: o.material_types_not_accepted || []
    };
  }));
  return json({ ok: true, organizations: results }, 200, cors);
}

async function handlePartnerOrgCreate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const name = (body.name || "").trim();
  if (!name) return json({ ok: false, error: "name is required." }, 400, cors);
  const insertBody = { name: name };

  let created;
  try {
    created = await supabaseRest(env, "organizations", { method: "POST", body: insertBody });
  } catch (e) {
    return json({ ok: false, error: "Could not create the organization.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, organization: created && created[0] }, 200, cors);
}

async function handlePartnerOrgUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  const patch = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.active === "boolean") patch.active = body.active;
  if (Object.prototype.hasOwnProperty.call(body, "submissionFormUrl")) patch.submission_form_url = (body.submissionFormUrl || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "compliancePortalUrl")) patch.compliance_portal_url = (body.compliancePortalUrl || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "medSuppSubmissionFormUrl")) patch.med_supp_submission_form_url = (body.medSuppSubmissionFormUrl || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "medSuppCompliancePortalUrl")) patch.med_supp_compliance_portal_url = (body.medSuppCompliancePortalUrl || "").trim() || null;
  if (typeof body.py26MaterialsNeedingSubmitted === "boolean") patch.py26_materials_needing_submitted = body.py26MaterialsNeedingSubmitted;
  if (typeof body.py27MaterialsNeedingSubmitted === "boolean") patch.py27_materials_needing_submitted = body.py27MaterialsNeedingSubmitted;
  if (Object.prototype.hasOwnProperty.call(body, "materialTypesNotAccepted")) patch.material_types_not_accepted = Array.isArray(body.materialTypesNotAccepted) ? body.materialTypesNotAccepted : null;
  if (Object.keys(patch).length === 0) return json({ ok: false, error: "Nothing to update." }, 400, cors);

  let updated;
  try {
    updated = await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(id), { method: "PATCH", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the organization.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, organization: updated && updated[0] }, 200, cors);
}

// Permanently deletes an organization. Every child table's org_id foreign
// key is "on delete cascade" (portal logins, guideline docs, MSA docs,
// submission forms, material shares, ...), so
// deleting the row here cascades all of it
// automatically. Two things do NOT cascade and need explicit cleanup first:
// (1) each user's actual auth.users account (users.org_id cascades the
// public.users profile row, but not the Supabase Auth account itself --
// deleting the auth user is the same call handlePartnerUserDelete uses,
// which in turn cascades the profile row); (2) Storage objects (logo, MSA/
// guideline/submission-form-file documents), which just become orphaned
// bytes in the bucket, not a data-integrity problem, but worth clearing.
async function handlePartnerOrgDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const orgRows = await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(id) + "&select=id,name,logo_path,submission_form_file_path");
    const org = orgRows && orgRows[0];
    if (!org) return json({ ok: false, error: "Organization not found." }, 404, cors);

    const [users, msaDocs, guidelineDocs] = await Promise.all([
      supabaseRest(env, "users?org_id=eq." + encodeURIComponent(id) + "&select=id").catch(function () { return []; }),
      supabaseRest(env, "organization_msa_documents?org_id=eq." + encodeURIComponent(id) + "&select=file_path").catch(function () { return []; }),
      supabaseRest(env, "organization_guideline_documents?org_id=eq." + encodeURIComponent(id) + "&select=file_path").catch(function () { return []; })
    ]);

    // Auth accounts don't cascade from the org row -- delete each one first
    // (best-effort; a stray failure here shouldn't block the org deletion).
    await Promise.all((users || []).map(function (u) {
      return supabaseAuthAdmin(env, "admin/users/" + u.id, { method: "DELETE" }).catch(function () {});
    }));

    await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });

    // Storage cleanup, best-effort, after the row (and its FK-cascaded
    // children) are already gone -- a failure here just leaves orphaned
    // bytes in the bucket, never a dangling DB reference.
    const cleanupTasks = [];
    if (org.logo_path) cleanupTasks.push(supabaseStorageDelete(env, org.logo_path, ORG_LOGO_BUCKET));
    if (org.submission_form_file_path) cleanupTasks.push(supabaseStorageDelete(env, org.submission_form_file_path, ORG_DOCS_BUCKET));
    (msaDocs || []).forEach(function (d) { if (d.file_path) cleanupTasks.push(supabaseStorageDelete(env, d.file_path, ORG_DOCS_BUCKET)); });
    (guidelineDocs || []).forEach(function (d) { if (d.file_path) cleanupTasks.push(supabaseStorageDelete(env, d.file_path, ORG_DOCS_BUCKET)); });
    await Promise.all(cleanupTasks);

    await insertAudit(env, { kind: "organization", action: "Organization deleted", target: org.name, detail: "Permanently deleted org " + id + " and all associated data." });
  } catch (e) {
    return json({ ok: false, error: "Could not delete the organization.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerOrgLogoUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const orgId = form.get("orgId");
  const file = form.get("file");
  if (!orgId || !file || typeof file === "string") {
    return json({ ok: false, error: "orgId and file are required." }, 400, cors);
  }

  const safeName = String(file.name || "logo").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "orgs/" + orgId + "/" + Date.now() + "-" + safeName;

  try {
    const oldRows = await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(orgId) + "&select=logo_path").catch(function () { return []; });
    const oldPath = oldRows && oldRows[0] && oldRows[0].logo_path;
    await supabaseStorageUpload(env, path, file, file.type, ORG_LOGO_BUCKET);
    await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(orgId), { method: "PATCH", prefer: "return=minimal", body: { logo_path: path } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, ORG_LOGO_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not upload the logo.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerOrgLogoDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const orgId = body.orgId;
  if (!orgId) return json({ ok: false, error: "orgId is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(orgId) + "&select=logo_path");
    const oldPath = rows && rows[0] && rows[0].logo_path;
    await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(orgId), { method: "PATCH", prefer: "return=minimal", body: { logo_path: null } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, ORG_LOGO_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not remove the logo.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleOrgMsaDocsList(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const orgId = url.searchParams.get("orgId");
  if (!orgId) return json({ ok: false, error: "orgId is required." }, 400, cors);
  let rows;
  try {
    rows = await supabaseRest(env, "organization_msa_documents?org_id=eq." + encodeURIComponent(orgId) + "&select=id,org_id,assigned_org_id,file_path,file_name,created_at&order=created_at.asc");
  } catch (e) {
    return json({ ok: false, error: "Could not load MSA documents.", detail: String(e.message || e) }, 502, cors);
  }
  const results = (rows || []).map(function (r) {
    return { id: r.id, orgId: r.org_id, assignedOrgId: r.assigned_org_id, fileName: r.file_name, createdAt: r.created_at };
  });
  return json({ ok: true, documents: results }, 200, cors);
}

async function handleOrgMsaDocUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const orgId = form.get("orgId");
  const assignedOrgId = form.get("assignedOrgId") || null;
  const file = form.get("file");
  if (!orgId || !file || typeof file === "string") {
    return json({ ok: false, error: "orgId and file are required." }, 400, cors);
  }

  const safeName = String(file.name || "msa").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "orgs/" + orgId + "/" + Date.now() + "-" + safeName;

  let created;
  try {
    await supabaseStorageUpload(env, path, file, file.type, ORG_DOCS_BUCKET);
    created = await supabaseRest(env, "organization_msa_documents", { method: "POST", body: { org_id: orgId, assigned_org_id: assignedOrgId || null, file_path: path, file_name: file.name || safeName } });
  } catch (e) {
    return json({ ok: false, error: "Could not upload the MSA.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, document: created && created[0] }, 200, cors);
}

async function handleOrgMsaDocUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  if (!Object.prototype.hasOwnProperty.call(body, "assignedOrgId")) return json({ ok: false, error: "Nothing to update." }, 400, cors);

  let updated;
  try {
    updated = await supabaseRest(env, "organization_msa_documents?id=eq." + encodeURIComponent(id), { method: "PATCH", body: { assigned_org_id: body.assignedOrgId || null } });
  } catch (e) {
    return json({ ok: false, error: "Could not update the MSA document.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, document: updated && updated[0] }, 200, cors);
}

async function handleOrgMsaDocDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "organization_msa_documents?id=eq." + encodeURIComponent(id) + "&select=file_path");
    const oldPath = rows && rows[0] && rows[0].file_path;
    await supabaseRest(env, "organization_msa_documents?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    if (oldPath) await supabaseStorageDelete(env, oldPath, ORG_DOCS_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not delete the MSA document.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleOrgMsaDocDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "organization_msa_documents?id=eq." + encodeURIComponent(id) + "&select=file_path,file_name");
    const row = rows && rows[0];
    if (!row || !row.file_path) return json({ ok: false, error: "That MSA document could not be found." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, row.file_path, 300, ORG_DOCS_BUCKET, row.file_name);
    return json({ ok: true, url: signedUrl, fileName: row.file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a download link.", detail: String(e.message || e) }, 502, cors);
  }
}

// A partner's submission form isn't always a web link -- some hand Apex an
// actual document instead, so this is a separate uploaded-file slot
// alongside the plain submission_form_url link, any file type, same
// admin-only bucket the MSA already uses.
async function handlePartnerOrgSubmissionFormFileUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const orgId = form.get("orgId");
  const file = form.get("file");
  if (!orgId || !file || typeof file === "string") {
    return json({ ok: false, error: "orgId and file are required." }, 400, cors);
  }

  const safeName = String(file.name || "submission-form").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "orgs/" + orgId + "/" + Date.now() + "-" + safeName;

  try {
    const oldRows = await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(orgId) + "&select=submission_form_file_path").catch(function () { return []; });
    const oldPath = oldRows && oldRows[0] && oldRows[0].submission_form_file_path;
    await supabaseStorageUpload(env, path, file, file.type, ORG_DOCS_BUCKET);
    await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(orgId), { method: "PATCH", prefer: "return=minimal", body: { submission_form_file_path: path, submission_form_file_name: file.name || safeName } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, ORG_DOCS_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not upload the submission form file.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerOrgSubmissionFormFileDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const orgId = body.orgId;
  if (!orgId) return json({ ok: false, error: "orgId is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(orgId) + "&select=submission_form_file_path");
    const oldPath = rows && rows[0] && rows[0].submission_form_file_path;
    await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(orgId), { method: "PATCH", prefer: "return=minimal", body: { submission_form_file_path: null, submission_form_file_name: null } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, ORG_DOCS_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not remove the submission form file.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerOrgSubmissionFormFileDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const orgId = url.searchParams.get("orgId");
  if (!orgId) return json({ ok: false, error: "orgId is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "organizations?id=eq." + encodeURIComponent(orgId) + "&select=submission_form_file_path,submission_form_file_name");
    const row = rows && rows[0];
    if (!row || !row.submission_form_file_path) return json({ ok: false, error: "No submission form file on file for this organization." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, row.submission_form_file_path, 300, ORG_DOCS_BUCKET, row.submission_form_file_name);
    return json({ ok: true, url: signedUrl, fileName: row.submission_form_file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a download link.", detail: String(e.message || e) }, 502, cors);
  }
}

// Submission Guide: a separate uploaded reference document, any file type,
// same admin-only bucket as MSA and the submission form file.
async function handleOrgGuidelineDocsList(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const orgId = url.searchParams.get("orgId");
  if (!orgId) return json({ ok: false, error: "orgId is required." }, 400, cors);
  let rows;
  try {
    rows = await supabaseRest(env, "organization_guideline_documents?org_id=eq." + encodeURIComponent(orgId) + "&select=id,org_id,file_path,file_name,created_at&order=created_at.asc");
  } catch (e) {
    return json({ ok: false, error: "Could not load guideline documents.", detail: String(e.message || e) }, 502, cors);
  }
  const results = (rows || []).map(function (r) {
    return { id: r.id, orgId: r.org_id, fileName: r.file_name, createdAt: r.created_at };
  });
  return json({ ok: true, documents: results }, 200, cors);
}

async function handleOrgGuidelineDocUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const orgId = form.get("orgId");
  const file = form.get("file");
  if (!orgId || !file || typeof file === "string") {
    return json({ ok: false, error: "orgId and file are required." }, 400, cors);
  }

  const safeName = String(file.name || "guideline.pdf").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "orgs/" + orgId + "/" + Date.now() + "-" + safeName;

  let created;
  try {
    await supabaseStorageUpload(env, path, file, file.type, ORG_DOCS_BUCKET);
    created = await supabaseRest(env, "organization_guideline_documents", { method: "POST", body: { org_id: orgId, file_path: path, file_name: file.name || safeName } });
  } catch (e) {
    return json({ ok: false, error: "Could not upload the guideline document.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, document: created && created[0] }, 200, cors);
}

async function handleOrgGuidelineDocDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "organization_guideline_documents?id=eq." + encodeURIComponent(id) + "&select=file_path");
    const oldPath = rows && rows[0] && rows[0].file_path;
    await supabaseRest(env, "organization_guideline_documents?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    if (oldPath) await supabaseStorageDelete(env, oldPath, ORG_DOCS_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not delete the guideline document.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleOrgGuidelineDocDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "organization_guideline_documents?id=eq." + encodeURIComponent(id) + "&select=file_path,file_name");
    const row = rows && rows[0];
    if (!row || !row.file_path) return json({ ok: false, error: "That guideline document could not be found." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, row.file_path, 300, ORG_DOCS_BUCKET, row.file_name);
    return json({ ok: true, url: signedUrl, fileName: row.file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a download link.", detail: String(e.message || e) }, 502, cors);
  }
}

// ---------------------------------------------------------------------------
// Carrier Organizations -- a separate concept from "organizations" above
// (Apex's selling partners). A Carrier Organization is the insurance
// carrier itself: its own submission form link, a repeatable list of named
// contacts, and an uploaded Guidelines/Guardrails PDF.
// ---------------------------------------------------------------------------

async function handleCarriersList(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  let carriers;
  try {
    carriers = await supabaseRest(env, "carrier_organizations?select=id,name,active,created_at,submission_form_url,main_submission_email,logo_path,submission_form_file_path,submission_form_file_name,color,carrier_contacts(count)&order=name.asc");
  } catch (e) {
    return json({ ok: false, error: "Could not load carrier organizations from Supabase.", detail: String(e.message || e) }, 502, cors);
  }
  const results = await Promise.all((carriers || []).map(async function (c) {
    let logoUrl = null;
    if (c.logo_path) {
      try { logoUrl = await supabaseStorageSignedUrl(env, c.logo_path, 1800, CARRIER_LOGO_BUCKET); } catch (e) { /* best-effort */ }
    }
    return {
      id: c.id, name: c.name, active: c.active, createdAt: c.created_at,
      submissionFormUrl: c.submission_form_url,
      mainSubmissionEmail: c.main_submission_email,
      hasLogo: !!c.logo_path, logoUrl: logoUrl,
      submissionFormFileName: c.submission_form_file_name || null,
      color: c.color || null,
      contactCount: (c.carrier_contacts && c.carrier_contacts[0] && c.carrier_contacts[0].count) || 0
    };
  }));
  return json({ ok: true, carriers: results }, 200, cors);
}

async function handleCarrierCreate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const name = (body.name || "").trim();
  if (!name) return json({ ok: false, error: "name is required." }, 400, cors);

  let created;
  try {
    created = await supabaseRest(env, "carrier_organizations", { method: "POST", body: { name: name } });
  } catch (e) {
    return json({ ok: false, error: "Could not create the carrier organization.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, carrier: created && created[0] }, 200, cors);
}

async function handleCarrierUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  const patch = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.active === "boolean") patch.active = body.active;
  if (Object.prototype.hasOwnProperty.call(body, "submissionFormUrl")) patch.submission_form_url = (body.submissionFormUrl || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "mainSubmissionEmail")) patch.main_submission_email = (body.mainSubmissionEmail || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "color")) patch.color = (body.color || "").trim() || null;
  if (Object.keys(patch).length === 0) return json({ ok: false, error: "Nothing to update." }, 400, cors);

  let updated;
  try {
    updated = await supabaseRest(env, "carrier_organizations?id=eq." + encodeURIComponent(id), { method: "PATCH", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the carrier organization.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, carrier: updated && updated[0] }, 200, cors);
}

async function handleCarrierLogoUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const carrierId = form.get("carrierId");
  const file = form.get("file");
  if (!carrierId || !file || typeof file === "string") {
    return json({ ok: false, error: "carrierId and file are required." }, 400, cors);
  }

  const safeName = String(file.name || "logo").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "carriers/" + carrierId + "/" + Date.now() + "-" + safeName;

  try {
    const oldRows = await supabaseRest(env, "carrier_organizations?id=eq." + encodeURIComponent(carrierId) + "&select=logo_path").catch(function () { return []; });
    const oldPath = oldRows && oldRows[0] && oldRows[0].logo_path;
    await supabaseStorageUpload(env, path, file, file.type, CARRIER_LOGO_BUCKET);
    await supabaseRest(env, "carrier_organizations?id=eq." + encodeURIComponent(carrierId), { method: "PATCH", prefer: "return=minimal", body: { logo_path: path } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, CARRIER_LOGO_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not upload the logo.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleCarrierLogoDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const carrierId = body.carrierId;
  if (!carrierId) return json({ ok: false, error: "carrierId is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "carrier_organizations?id=eq." + encodeURIComponent(carrierId) + "&select=logo_path");
    const oldPath = rows && rows[0] && rows[0].logo_path;
    await supabaseRest(env, "carrier_organizations?id=eq." + encodeURIComponent(carrierId), { method: "PATCH", prefer: "return=minimal", body: { logo_path: null } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, CARRIER_LOGO_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not remove the logo.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleCarrierSubmissionFormFileUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const carrierId = form.get("carrierId");
  const file = form.get("file");
  if (!carrierId || !file || typeof file === "string") {
    return json({ ok: false, error: "carrierId and file are required." }, 400, cors);
  }

  const safeName = String(file.name || "submission-form").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "carriers/" + carrierId + "/" + Date.now() + "-" + safeName;

  try {
    const oldRows = await supabaseRest(env, "carrier_organizations?id=eq." + encodeURIComponent(carrierId) + "&select=submission_form_file_path").catch(function () { return []; });
    const oldPath = oldRows && oldRows[0] && oldRows[0].submission_form_file_path;
    await supabaseStorageUpload(env, path, file, file.type, CARRIER_GUIDELINES_BUCKET);
    await supabaseRest(env, "carrier_organizations?id=eq." + encodeURIComponent(carrierId), { method: "PATCH", prefer: "return=minimal", body: { submission_form_file_path: path, submission_form_file_name: file.name || safeName } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, CARRIER_GUIDELINES_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not upload the submission form file.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleCarrierSubmissionFormFileDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const carrierId = body.carrierId;
  if (!carrierId) return json({ ok: false, error: "carrierId is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "carrier_organizations?id=eq." + encodeURIComponent(carrierId) + "&select=submission_form_file_path");
    const oldPath = rows && rows[0] && rows[0].submission_form_file_path;
    await supabaseRest(env, "carrier_organizations?id=eq." + encodeURIComponent(carrierId), { method: "PATCH", prefer: "return=minimal", body: { submission_form_file_path: null, submission_form_file_name: null } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, CARRIER_GUIDELINES_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not remove the submission form file.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleCarrierSubmissionFormFileDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const carrierId = url.searchParams.get("carrierId");
  if (!carrierId) return json({ ok: false, error: "carrierId is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "carrier_organizations?id=eq." + encodeURIComponent(carrierId) + "&select=submission_form_file_path,submission_form_file_name");
    const row = rows && rows[0];
    if (!row || !row.submission_form_file_path) return json({ ok: false, error: "No submission form file on file for this carrier." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, row.submission_form_file_path, 300, CARRIER_GUIDELINES_BUCKET, row.submission_form_file_name);
    return json({ ok: true, url: signedUrl, fileName: row.submission_form_file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a download link.", detail: String(e.message || e) }, 502, cors);
  }
}

// ---------------------------------------------------------------------------
// Allegations -- buyers/partners/clients submit an allegation/audit request
// via a fully public, unauthenticated form (no Partner Portal login) that
// writes directly to Supabase under RLS's open insert policy, NOT through
// this Worker. The Worker only handles the admin review side: listing every
// request and updating its investigation status/notes -- same service-role-
// key pattern as every other admin-side CRUD in this file. Field set
// matches the real source form exactly (Receival/Due/Lead dates, Organization
// Name, Submitter Name/Email, Email Thread Title, Allegation Form Link, Lead
// Phone/Name, Call Duration) -- no file upload field exists on the real form.
// ---------------------------------------------------------------------------

const ALLEGATION_FIELDS = "id,receival_date,due_date,email_thread_title,allegation_form_link,org_name,submitter_name,submitter_email,lead_date,lead_phone_country_code,lead_phone_number,lead_name,call_duration,smid,corresponding_url,audio_file_path,audio_file_name,status,investigation_notes,resolved_at,created_at,updated_at";
const ALLEGATION_EVIDENCE_BUCKET = "allegation-evidence";

async function handleAllegationsList(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  let rows;
  try {
    rows = await supabaseRest(env, "allegations?select=" + encodeURIComponent(ALLEGATION_FIELDS + ",allegation_documents(id,file_name,uploaded_at)") + "&order=created_at.desc");
  } catch (e) {
    return json({ ok: false, error: "Could not load allegations from Supabase.", detail: String(e.message || e) }, 502, cors);
  }
  const results = (rows || []).map(function (r) {
    return {
      id: r.id, receivalDate: r.receival_date, dueDate: r.due_date, emailThreadTitle: r.email_thread_title,
      allegationFormLink: r.allegation_form_link, orgName: r.org_name, submitterName: r.submitter_name,
      submitterEmail: r.submitter_email, leadDate: r.lead_date,
      leadPhoneCountryCode: r.lead_phone_country_code, leadPhoneNumber: r.lead_phone_number,
      leadName: r.lead_name, callDuration: r.call_duration,
      smid: r.smid, correspondingUrl: r.corresponding_url, audioFileName: r.audio_file_name,
      documents: (r.allegation_documents || []).map(function (d) {
        return { id: d.id, fileName: d.file_name, uploadedAt: d.uploaded_at };
      }),
      status: r.status, investigationNotes: r.investigation_notes, resolvedAt: r.resolved_at,
      createdAt: r.created_at, updatedAt: r.updated_at
    };
  });
  return json({ ok: true, allegations: results }, 200, cors);
}

const ALLEGATION_UPDATE_FIELD_MAP = { status: "status", investigationNotes: "investigation_notes", receivalDate: "receival_date", dueDate: "due_date", emailThreadTitle: "email_thread_title", allegationFormLink: "allegation_form_link", orgName: "org_name", submitterName: "submitter_name", submitterEmail: "submitter_email", leadDate: "lead_date", leadPhoneCountryCode: "lead_phone_country_code", leadPhoneNumber: "lead_phone_number", leadName: "lead_name", callDuration: "call_duration", smid: "smid", correspondingUrl: "corresponding_url" };

async function handleAllegationUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  if (body.status && ["Open", "Investigating", "Resolved", "Dismissed"].indexOf(body.status) === -1) {
    return json({ ok: false, error: "Invalid status." }, 400, cors);
  }
  const patch = pickDefined(body, Object.keys(ALLEGATION_UPDATE_FIELD_MAP));
  const dbPatch = {};
  Object.keys(patch).forEach(function (k) { dbPatch[ALLEGATION_UPDATE_FIELD_MAP[k]] = patch[k]; });
  if (Object.prototype.hasOwnProperty.call(patch, "status")) { dbPatch.resolved_at = (patch.status === "Resolved" || patch.status === "Dismissed") ? new Date().toISOString() : null; }
  if (Object.keys(dbPatch).length === 0) return json({ ok: false, error: "Nothing to update." }, 400, cors);
  let updated;
  try {
    updated = await supabaseRest(env, "allegations?id=eq." + encodeURIComponent(id), { method: "PATCH", body: dbPatch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the allegation.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, allegation: updated && updated[0] }, 200, cors);
}

async function handleAllegationAudioUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }
  const id = form.get("id");
  const file = form.get("audio");
  if (!id || !file || typeof file === "string") {
    return json({ ok: false, error: "id and audio are required." }, 400, cors);
  }
  const safeName = String(file.name || "audio").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "allegations/" + id + "/" + Date.now() + "-" + safeName;
  try {
    const oldRows = await supabaseRest(env, "allegations?id=eq." + encodeURIComponent(id) + "&select=audio_file_path").catch(function () { return []; });
    const oldPath = oldRows && oldRows[0] && oldRows[0].audio_file_path;
    await supabaseStorageUpload(env, path, file, file.type, ALLEGATION_EVIDENCE_BUCKET);
    await supabaseRest(env, "allegations?id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: { audio_file_path: path, audio_file_name: file.name || safeName } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, ALLEGATION_EVIDENCE_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not upload the audio recording.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleAllegationAudioDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  try {
    const rows = await supabaseRest(env, "allegations?id=eq." + encodeURIComponent(id) + "&select=audio_file_path");
    const oldPath = rows && rows[0] && rows[0].audio_file_path;
    await supabaseRest(env, "allegations?id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: { audio_file_path: null, audio_file_name: null } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, ALLEGATION_EVIDENCE_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not remove the audio recording.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleAllegationAudioDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  try {
    const rows = await supabaseRest(env, "allegations?id=eq." + encodeURIComponent(id) + "&select=audio_file_path,audio_file_name");
    const row = rows && rows[0];
    if (!row || !row.audio_file_path) return json({ ok: false, error: "No audio recording on file for this allegation." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, row.audio_file_path, 300, ALLEGATION_EVIDENCE_BUCKET, row.audio_file_name);
    return json({ ok: true, url: signedUrl, fileName: row.audio_file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a download link.", detail: String(e.message || e) }, 502, cors);
  }
}

async function handleAllegationDocumentUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }
  const id = form.get("id");
  const file = form.get("document");
  if (!id || !file || typeof file === "string") {
    return json({ ok: false, error: "id and document are required." }, 400, cors);
  }
  const safeName = String(file.name || "document").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "allegations/" + id + "/documents/" + Date.now() + "-" + safeName;
  let docRow;
  try {
    await supabaseStorageUpload(env, path, file, file.type, ALLEGATION_EVIDENCE_BUCKET);
    const inserted = await supabaseRest(env, "allegation_documents", {
      method: "POST",
      body: { allegation_id: id, file_name: file.name || safeName, storage_path: path }
    });
    docRow = inserted && inserted[0];
  } catch (e) {
    return json({ ok: false, error: "Could not upload the document.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, document: docRow && { id: docRow.id, fileName: docRow.file_name, uploadedAt: docRow.uploaded_at } }, 200, cors);
}

async function handleAllegationDocumentDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  try {
    const rows = await supabaseRest(env, "allegation_documents?id=eq." + encodeURIComponent(id) + "&select=storage_path");
    const docRow = rows && rows[0];
    await supabaseRest(env, "allegation_documents?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    if (docRow && docRow.storage_path) await supabaseStorageDelete(env, docRow.storage_path, ALLEGATION_EVIDENCE_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not delete the document.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleAllegationDocumentDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  try {
    const rows = await supabaseRest(env, "allegation_documents?id=eq." + encodeURIComponent(id) + "&select=storage_path,file_name");
    const docRow = rows && rows[0];
    if (!docRow) return json({ ok: false, error: "Document not found." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, docRow.storage_path, 300, ALLEGATION_EVIDENCE_BUCKET, docRow.file_name);
    return json({ ok: true, url: signedUrl, fileName: docRow.file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a download link.", detail: String(e.message || e) }, 502, cors);
  }
}

async function handleAllegationDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  try {
    await supabaseRest(env, "allegations?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
  } catch (e) {
    return json({ ok: false, error: "Could not delete the allegation.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// Fired by a Postgres trigger (see the allegations migration's
// notify_new_allegation() function) immediately after a new row lands in
// `allegations`, via pg_net -- NOT called by either partner-facing client.
// Auth is a shared secret header rather than partnerAdminAuthCheck's admin
// key, since the caller here is the database itself, not a logged-in admin.
async function handleAllegationNotify(request, env, cors) {
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  const secret = request.headers.get("x-webhook-secret");
  if (!env.ALLEGATION_WEBHOOK_SECRET || secret !== env.ALLEGATION_WEBHOOK_SECRET) {
    return json({ ok: false, error: "Unauthorized." }, 401, cors);
  }
  let a;
  try { a = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  if (!env.RESEND_API_KEY || !env.ALLEGATION_NOTIFY_EMAIL) {
    return json({ ok: false, error: "Email notification is not configured (RESEND_API_KEY / ALLEGATION_NOTIFY_EMAIL missing)." }, 500, cors);
  }
  // ALLEGATION_NOTIFY_EMAIL may be a single address or a comma-separated
  // list (e.g. "compliance@myhealthangel.com, ops@myhealthangel.com") --
  // every recipient gets the same notification.
  const notifyRecipients = String(env.ALLEGATION_NOTIFY_EMAIL).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  const esc = function (v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
  const row = function (label, value) { return "<tr><td style=\"padding:4px 12px 4px 0;color:#5a6b7b;font-size:13px;white-space:nowrap;vertical-align:top;\">" + esc(label) + "</td><td style=\"padding:4px 0;font-size:13px;color:#12283c;\">" + (value || "&mdash;") + "</td></tr>"; };
  const html = "<div style=\"font-family:Arial,sans-serif;max-width:560px;\">" +
    "<h2 style=\"color:#4D4D4D;font-size:17px;margin:0 0 14px;\">New Allegation/Audit Request Submitted</h2>" +
    "<table style=\"border-collapse:collapse;\">" +
    row("Organization", esc(a.org_name)) +
    row("Submitter", esc(a.submitter_name)) +
    row("Submitter Email", esc(a.submitter_email)) +
    row("Receival Date", esc(a.receival_date)) +
    row("Due Date", esc(a.due_date)) +
    row("Lead Name", esc(a.lead_name)) +
    row("Lead Phone", esc(((a.lead_phone_country_code || "") + " " + (a.lead_phone_number || "")).trim())) +
    row("Call Duration", esc(a.call_duration)) +
    row("Email Thread Title", esc(a.email_thread_title)) +
    row("Allegation Form Link", a.allegation_form_link ? esc(a.allegation_form_link) : "") +
    "</table>" +
    "<p style=\"margin-top:16px;font-size:12.5px;color:#5a6b7b;\">Review and update its status in the CRM Admin Portal's Allegations tab.</p>" +
    "</div>";
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.ALLEGATION_NOTIFY_FROM || "onboarding@resend.dev",
        to: notifyRecipients,
        subject: "New Allegation/Audit Request" + (a.org_name ? " — " + a.org_name : ""),
        html: html
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(function () { return ""; });
      return json({ ok: false, error: "Resend API error", detail: errText }, 502, cors);
    }
  } catch (e) {
    return json({ ok: false, error: "Could not send the notification email.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// ---------------------------------------------------------------------------
// Tasks -- a simple assignable to-do list for the CRM Admin Portal.
// assigned_to/created_by store an admin's email directly (see the tasks
// migration), matching the admin_users allowlist used by the login screen.
// Same service-role-key admin CRUD pattern as everything else in this file.
// ---------------------------------------------------------------------------

const TASK_FIELDS = "id,title,description,assigned_to,created_by,status,due_date,submission_date,org_id,direct_client_org_id,carrier_id,portal_link,email_thread_title,created_at,updated_at";
// Attachments on a task (any number, addable after the task is saved). Rows
// in task_files, bytes in the private task-files bucket -- admin-only like
// tasks themselves.
const TASK_FILES_BUCKET = "task-files";

async function handleTasksList(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  let rows;
  try {
    rows = await supabaseRest(env, "tasks?select=" + encodeURIComponent(TASK_FIELDS + ",task_files(id,file_name,uploaded_at)") + "&order=created_at.desc");
  } catch (e) {
    return json({ ok: false, error: "Could not load tasks from Supabase.", detail: String(e.message || e) }, 502, cors);
  }
  const results = (rows || []).map(function (r) {
    const files = (r.task_files || []).slice().sort(function (a, b) { return String(a.uploaded_at).localeCompare(String(b.uploaded_at)); });
    return {
      id: r.id, title: r.title, description: r.description, assignedTo: r.assigned_to,
      createdBy: r.created_by, status: r.status, dueDate: r.due_date, submissionDate: r.submission_date,
      orgId: r.org_id, directClientOrgId: r.direct_client_org_id, carrierId: r.carrier_id, portalLink: r.portal_link, emailThreadTitle: r.email_thread_title,
      files: files.map(function (f) { return { id: f.id, fileName: f.file_name, uploadedAt: f.uploaded_at }; }),
      createdAt: r.created_at, updatedAt: r.updated_at
    };
  });
  return json({ ok: true, tasks: results }, 200, cors);
}

async function handleTaskCreate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const title = (body.title || "").trim();
  const assignedTo = (body.assignedTo || "").trim().toLowerCase();
  if (!title) return json({ ok: false, error: "title is required." }, 400, cors);
  if (!assignedTo) return json({ ok: false, error: "assignedTo is required." }, 400, cors);
  let created;
  try {
    created = await supabaseRest(env, "tasks", {
      method: "POST",
      body: {
        title: title,
        description: (body.description || "").trim() || null,
        assigned_to: assignedTo,
        created_by: (body.createdBy || "").trim().toLowerCase() || null,
        status: body.status || "Open",
        due_date: body.dueDate || null,
        submission_date: body.submissionDate || null,
        org_id: body.orgId || null,
        direct_client_org_id: body.directClientOrgId || null,
        carrier_id: body.carrierId || null,
        portal_link: (body.portalLink || "").trim() || null,
        email_thread_title: (body.emailThreadTitle || "").trim() || null
      }
    });
  } catch (e) {
    return json({ ok: false, error: "Could not create the task.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, task: created && created[0] }, 200, cors);
}

async function handleTaskUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  if (body.status && ["Open", "In Progress", "Completed"].indexOf(body.status) === -1) {
    return json({ ok: false, error: "Invalid status." }, 400, cors);
  }
  const patch = { updated_at: new Date().toISOString() };
  if (Object.prototype.hasOwnProperty.call(body, "title")) patch.title = (body.title || "").trim();
  if (Object.prototype.hasOwnProperty.call(body, "description")) patch.description = (body.description || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "assignedTo")) patch.assigned_to = (body.assignedTo || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(body, "status")) patch.status = body.status;
  if (Object.prototype.hasOwnProperty.call(body, "dueDate")) patch.due_date = body.dueDate || null;
  if (Object.prototype.hasOwnProperty.call(body, "submissionDate")) patch.submission_date = body.submissionDate || null;
  if (Object.prototype.hasOwnProperty.call(body, "orgId")) patch.org_id = body.orgId || null;
  if (Object.prototype.hasOwnProperty.call(body, "directClientOrgId")) patch.direct_client_org_id = body.directClientOrgId || null;
  if (Object.prototype.hasOwnProperty.call(body, "carrierId")) patch.carrier_id = body.carrierId || null;
  if (Object.prototype.hasOwnProperty.call(body, "portalLink")) patch.portal_link = (body.portalLink || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "emailThreadTitle")) patch.email_thread_title = (body.emailThreadTitle || "").trim() || null;
  let updated;
  try {
    updated = await supabaseRest(env, "tasks?id=eq." + encodeURIComponent(id), { method: "PATCH", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the task.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, task: updated && updated[0] }, 200, cors);
}

async function handleTaskDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  try {
    const files = await supabaseRest(env, "task_files?task_id=eq." + encodeURIComponent(id) + "&select=storage_path").catch(function () { return []; });
    await supabaseRest(env, "tasks?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    await Promise.all((files || []).map(function (f) { return supabaseStorageDelete(env, f.storage_path, TASK_FILES_BUCKET).catch(function () {}); }));
  } catch (e) {
    return json({ ok: false, error: "Could not delete the task.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleTaskFileUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }
  const taskId = form.get("taskId");
  const file = form.get("file");
  if (!taskId || !file || typeof file === "string") {
    return json({ ok: false, error: "taskId and file are required." }, 400, cors);
  }
  const safeName = String(file.name || "upload").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "tasks/" + taskId + "/" + Date.now() + "-" + safeName;
  let fileRow;
  try {
    await supabaseStorageUpload(env, path, file, file.type, TASK_FILES_BUCKET);
    const inserted = await supabaseRest(env, "task_files", {
      method: "POST",
      body: { task_id: taskId, file_name: file.name || safeName, storage_path: path }
    });
    fileRow = inserted && inserted[0];
  } catch (e) {
    return json({ ok: false, error: "Could not upload the file.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, file: fileRow && { id: fileRow.id, fileName: fileRow.file_name, uploadedAt: fileRow.uploaded_at } }, 200, cors);
}

async function handleTaskFileDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  try {
    const rows = await supabaseRest(env, "task_files?id=eq." + encodeURIComponent(id) + "&select=storage_path");
    const fileRow = rows && rows[0];
    await supabaseRest(env, "task_files?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    if (fileRow && fileRow.storage_path) await supabaseStorageDelete(env, fileRow.storage_path, TASK_FILES_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not remove the file.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleTaskFileDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  try {
    const rows = await supabaseRest(env, "task_files?id=eq." + encodeURIComponent(id) + "&select=storage_path,file_name");
    const fileRow = rows && rows[0];
    if (!fileRow) return json({ ok: false, error: "File not found." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, fileRow.storage_path, 300, TASK_FILES_BUCKET, fileRow.file_name);
    return json({ ok: true, url: signedUrl, fileName: fileRow.file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a download link.", detail: String(e.message || e) }, 502, cors);
  }
}

// Powers the assignee dropdown on the New/Edit Task form -- the admin_users
// allowlist table has no client access at all (see its migration), so this
// is the only way the browser ever sees the list of admin emails, same
// service-role-key pattern as every other admin-side read in this file.
async function handleAdminUsersList(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  let rows;
  try {
    rows = await supabaseRest(env, "admin_users?select=email&order=email.asc");
  } catch (e) {
    return json({ ok: false, error: "Could not load admin users from Supabase.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, emails: (rows || []).map(function (r) { return r.email; }) }, 200, cors);
}

// Fired by a Postgres trigger (see the tasks migration's notify_new_task()
// function) immediately after a new row lands in `tasks`, via pg_net --
// emails the assigned admin the task's details. Auth is a shared secret
// header rather than partnerAdminAuthCheck's admin key, since the caller
// here is the database itself, not a logged-in admin.
async function handleTaskNotify(request, env, cors) {
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  const secret = request.headers.get("x-webhook-secret");
  if (!env.TASK_WEBHOOK_SECRET || secret !== env.TASK_WEBHOOK_SECRET) {
    return json({ ok: false, error: "Unauthorized." }, 401, cors);
  }
  let t;
  try { t = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  if (!env.RESEND_API_KEY) {
    return json({ ok: false, error: "Email notification is not configured (RESEND_API_KEY missing)." }, 500, cors);
  }
  if (!t.assigned_to) {
    return json({ ok: false, error: "Task has no assigned_to address." }, 400, cors);
  }
  const esc = function (v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
  const row = function (label, value) { return "<tr><td style=\"padding:4px 12px 4px 0;color:#5a6b7b;font-size:13px;white-space:nowrap;vertical-align:top;\">" + esc(label) + "</td><td style=\"padding:4px 0;font-size:13px;color:#12283c;\">" + (value || "&mdash;") + "</td></tr>"; };
  const html = "<div style=\"font-family:Arial,sans-serif;max-width:560px;\">" +
    "<h2 style=\"color:#4D4D4D;font-size:17px;margin:0 0 14px;\">New Task Assigned To You</h2>" +
    "<table style=\"border-collapse:collapse;\">" +
    row("Title", esc(t.title)) +
    row("Description", t.description ? esc(t.description).replace(/\n/g, "<br>") : "") +
    row("Due Date", esc(t.due_date)) +
    row("Assigned By", esc(t.created_by)) +
    row("Status", esc(t.status)) +
    "</table>" +
    "<p style=\"margin-top:16px;font-size:12.5px;color:#5a6b7b;\">Review and update it in the CRM Admin Portal's Tasks tab.</p>" +
    "</div>";
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.TASK_NOTIFY_FROM || "onboarding@resend.dev",
        to: [t.assigned_to],
        subject: "New Task Assigned" + (t.title ? ": " + t.title : ""),
        html: html
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(function () { return ""; });
      return json({ ok: false, error: "Resend API error", detail: errText }, 502, cors);
    }
  } catch (e) {
    return json({ ok: false, error: "Could not send the notification email.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// ---------------------------------------------------------------------------
// Apex Operational Logins -- Apex's own internal tool/portal credentials,
// not tied to any partner org or carrier.
// ---------------------------------------------------------------------------

async function handleApexOperationalLoginsList(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  let rows;
  try {
    rows = await supabaseRest(env, "apex_operational_logins?select=id,label,portal_url,username,password,requires_2fa,logo_path,created_at&order=label.asc");
  } catch (e) {
    return json({ ok: false, error: "Could not load Internal Operational Logins.", detail: String(e.message || e) }, 502, cors);
  }
  const results = await Promise.all((rows || []).map(async function (r) {
    let logoUrl = null;
    if (r.logo_path) {
      try { logoUrl = await supabaseStorageSignedUrl(env, r.logo_path, 1800, APEX_OP_LOGIN_LOGO_BUCKET); } catch (e) { /* best-effort */ }
    }
    return {
      id: r.id, label: r.label, portalUrl: r.portal_url, username: r.username, password: r.password,
      requires2fa: !!r.requires_2fa, hasLogo: !!r.logo_path, logoUrl: logoUrl, createdAt: r.created_at
    };
  }));
  return json({ ok: true, logins: results }, 200, cors);
}

async function handleApexOperationalLoginCreate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const label = (body.label || "").trim();
  if (!label) return json({ ok: false, error: "label is required." }, 400, cors);

  let created;
  try {
    created = await supabaseRest(env, "apex_operational_logins", {
      method: "POST",
      body: { label: label, portal_url: (body.portalUrl || "").trim() || null, username: (body.username || "").trim() || null, password: body.password || null, requires_2fa: !!body.requires2fa }
    });
  } catch (e) {
    return json({ ok: false, error: "Could not create the login.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, login: created && created[0] }, 200, cors);
}

async function handleApexOperationalLoginUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  const patch = { updated_at: new Date().toISOString() };
  if (Object.prototype.hasOwnProperty.call(body, "label")) patch.label = (body.label || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "portalUrl")) patch.portal_url = (body.portalUrl || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "username")) patch.username = (body.username || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "password")) patch.password = body.password || null;
  if (Object.prototype.hasOwnProperty.call(body, "requires2fa")) patch.requires_2fa = !!body.requires2fa;

  let updated;
  try {
    updated = await supabaseRest(env, "apex_operational_logins?id=eq." + encodeURIComponent(id), { method: "PATCH", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the login.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, login: updated && updated[0] }, 200, cors);
}

async function handleApexOperationalLoginDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "apex_operational_logins?id=eq." + encodeURIComponent(id) + "&select=logo_path");
    const oldPath = rows && rows[0] && rows[0].logo_path;
    await supabaseRest(env, "apex_operational_logins?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    if (oldPath) await supabaseStorageDelete(env, oldPath, APEX_OP_LOGIN_LOGO_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not delete the login.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleApexOperationalLoginLogoUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const id = form.get("id");
  const file = form.get("file");
  if (!id || !file || typeof file === "string") {
    return json({ ok: false, error: "id and file are required." }, 400, cors);
  }

  const safeName = String(file.name || "logo").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "logins/" + id + "/" + Date.now() + "-" + safeName;

  try {
    const oldRows = await supabaseRest(env, "apex_operational_logins?id=eq." + encodeURIComponent(id) + "&select=logo_path").catch(function () { return []; });
    const oldPath = oldRows && oldRows[0] && oldRows[0].logo_path;
    await supabaseStorageUpload(env, path, file, file.type, APEX_OP_LOGIN_LOGO_BUCKET);
    await supabaseRest(env, "apex_operational_logins?id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: { logo_path: path } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, APEX_OP_LOGIN_LOGO_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not upload the logo.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleApexOperationalLoginLogoDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "apex_operational_logins?id=eq." + encodeURIComponent(id) + "&select=logo_path");
    const oldPath = rows && rows[0] && rows[0].logo_path;
    await supabaseRest(env, "apex_operational_logins?id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: { logo_path: null } });
    if (oldPath) await supabaseStorageDelete(env, oldPath, APEX_OP_LOGIN_LOGO_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not remove the logo.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}


async function handleCarrierGuidelineDocsList(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const carrierId = url.searchParams.get("carrierId");
  if (!carrierId) return json({ ok: false, error: "carrierId is required." }, 400, cors);
  let rows;
  try {
    rows = await supabaseRest(env, "carrier_guideline_documents?carrier_id=eq." + encodeURIComponent(carrierId) + "&select=id,carrier_id,plan_year,file_path,file_name,created_at&order=created_at.asc");
  } catch (e) {
    return json({ ok: false, error: "Could not load Guidelines/Guardrails documents.", detail: String(e.message || e) }, 502, cors);
  }
  const results = (rows || []).map(function (r) {
    return { id: r.id, carrierId: r.carrier_id, planYear: r.plan_year, fileName: r.file_name, createdAt: r.created_at };
  });
  return json({ ok: true, documents: results }, 200, cors);
}

async function handleCarrierGuidelineDocUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const carrierId = form.get("carrierId");
  const planYear = form.get("planYear");
  const file = form.get("file");
  if (!carrierId || !file || typeof file === "string") {
    return json({ ok: false, error: "carrierId and file are required." }, 400, cors);
  }
  if (planYear !== "PY26" && planYear !== "PY27") {
    return json({ ok: false, error: "planYear must be 'PY26' or 'PY27'." }, 400, cors);
  }

  const safeName = String(file.name || "guidelines.pdf").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "carriers/" + carrierId + "/" + Date.now() + "-" + safeName;

  let created;
  try {
    await supabaseStorageUpload(env, path, file, file.type, CARRIER_GUIDELINES_BUCKET);
    created = await supabaseRest(env, "carrier_guideline_documents", { method: "POST", body: { carrier_id: carrierId, plan_year: planYear, file_path: path, file_name: file.name || safeName } });
  } catch (e) {
    return json({ ok: false, error: "Could not upload the Guidelines/Guardrails PDF.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, document: created && created[0] }, 200, cors);
}

async function handleCarrierGuidelineDocDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "carrier_guideline_documents?id=eq." + encodeURIComponent(id) + "&select=file_path");
    const oldPath = rows && rows[0] && rows[0].file_path;
    await supabaseRest(env, "carrier_guideline_documents?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    if (oldPath) await supabaseStorageDelete(env, oldPath, CARRIER_GUIDELINES_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not delete the Guidelines/Guardrails PDF.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleCarrierGuidelineDocDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "carrier_guideline_documents?id=eq." + encodeURIComponent(id) + "&select=file_path,file_name");
    const row = rows && rows[0];
    if (!row || !row.file_path) return json({ ok: false, error: "That Guidelines/Guardrails PDF could not be found." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, row.file_path, 300, CARRIER_GUIDELINES_BUCKET, row.file_name);
    return json({ ok: true, url: signedUrl, fileName: row.file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a view link.", detail: String(e.message || e) }, 502, cors);
  }
}

async function handleCarrierContactsList(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const carrierId = url.searchParams.get("carrierId");
  if (!carrierId) return json({ ok: false, error: "carrierId is required." }, 400, cors);

  let contacts;
  try {
    contacts = await supabaseRest(env, "carrier_contacts?carrier_org_id=eq." + encodeURIComponent(carrierId) + "&select=id,carrier_org_id,first_name,last_name,email,assigned_org_ids,created_at&order=created_at.asc");
  } catch (e) {
    return json({ ok: false, error: "Could not load carrier contacts from Supabase.", detail: String(e.message || e) }, 502, cors);
  }
  const results = (contacts || []).map(function (c) {
    return { id: c.id, carrierId: c.carrier_org_id, firstName: c.first_name, lastName: c.last_name, email: c.email, assignedOrgIds: c.assigned_org_ids || [], createdAt: c.created_at };
  });
  return json({ ok: true, contacts: results }, 200, cors);
}

async function handleCarrierContactCreate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const carrierId = body.carrierId;
  if (!carrierId) return json({ ok: false, error: "carrierId is required." }, 400, cors);

  const insertBody = {
    carrier_org_id: carrierId,
    first_name: (body.firstName || "").trim() || null,
    last_name: (body.lastName || "").trim() || null,
    email: (body.email || "").trim() || null,
    assigned_org_ids: Array.isArray(body.assignedOrgIds) && body.assignedOrgIds.length ? body.assignedOrgIds : null
  };

  let created;
  try {
    created = await supabaseRest(env, "carrier_contacts", { method: "POST", body: insertBody });
  } catch (e) {
    return json({ ok: false, error: "Could not add the carrier contact.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, contact: created && created[0] }, 200, cors);
}

async function handleCarrierContactUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, "firstName")) patch.first_name = (body.firstName || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "lastName")) patch.last_name = (body.lastName || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "email")) patch.email = (body.email || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "assignedOrgIds")) patch.assigned_org_ids = (Array.isArray(body.assignedOrgIds) && body.assignedOrgIds.length) ? body.assignedOrgIds : null;
  if (Object.keys(patch).length === 0) return json({ ok: false, error: "Nothing to update." }, 400, cors);

  let updated;
  try {
    updated = await supabaseRest(env, "carrier_contacts?id=eq." + encodeURIComponent(id), { method: "PATCH", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the carrier contact.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, contact: updated && updated[0] }, 200, cors);
}

async function handleCarrierContactDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    await supabaseRest(env, "carrier_contacts?id=eq." + encodeURIComponent(id), { method: "DELETE" });
  } catch (e) {
    return json({ ok: false, error: "Could not delete the carrier contact.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// A repeatable list, separate from organizations' own single submission-form
// URL: some orgs have more than one carrier/portal login Apex staff use, and
// each one can optionally be handed off to a specific partner login (from
// that same org's Partner Logins) for day-to-day use. Same admin-only
// pattern as everything else in this file -- the password field here is
// reference data for Apex staff's OWN use of a third-party portal, not a
// partner login credential to this app (those stay Supabase Auth-hashed
// and are never readable, here or anywhere else).
async function handleOrgPortalLoginsList(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const orgId = url.searchParams.get("orgId");
  if (!orgId) return json({ ok: false, error: "orgId is required." }, 400, cors);

  let rows;
  try {
    rows = await supabaseRest(env, "organization_portal_logins?org_id=eq." + encodeURIComponent(orgId) + "&select=id,org_id,label,portal_url,username,password,assigned_user_id,line_of_business,notes,no_submission_portal,submission_email,created_at,users(first_name,last_name,email)&order=created_at.asc");
  } catch (e) {
    return json({ ok: false, error: "Could not load portal logins.", detail: String(e.message || e) }, 502, cors);
  }
  const results = (rows || []).map(function (r) {
    return {
      id: r.id, orgId: r.org_id, label: r.label, portalUrl: r.portal_url,
      username: r.username, password: r.password, assignedUserId: r.assigned_user_id,
      lineOfBusiness: r.line_of_business,
      notes: r.notes, noSubmissionPortal: !!r.no_submission_portal, submissionEmail: r.submission_email,
      assignedUserName: r.users ? [r.users.first_name, r.users.last_name].filter(Boolean).join(" ") || r.users.email : null,
      createdAt: r.created_at
    };
  });
  return json({ ok: true, portalLogins: results }, 200, cors);
}

async function handleOrgPortalLoginCreate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const orgId = body.orgId;
  if (!orgId) return json({ ok: false, error: "orgId is required." }, 400, cors);

  const insertBody = {
    org_id: orgId,
    label: (body.label || "").trim() || null,
    portal_url: (body.portalUrl || "").trim() || null,
    username: (body.username || "").trim() || null,
    password: body.password || null,
    assigned_user_id: body.assignedUserId || null,
    line_of_business: body.lineOfBusiness || null,
    notes: (body.notes || "").trim() || null,
    no_submission_portal: !!body.noSubmissionPortal,
    submission_email: (body.submissionEmail || "").trim() || null
  };

  let created;
  try {
    created = await supabaseRest(env, "organization_portal_logins", { method: "POST", body: insertBody });
  } catch (e) {
    return json({ ok: false, error: "Could not create the portal login.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, portalLogin: created && created[0] }, 200, cors);
}

async function handleOrgPortalLoginUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  const patch = { updated_at: new Date().toISOString() };
  if (Object.prototype.hasOwnProperty.call(body, "label")) patch.label = (body.label || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "portalUrl")) patch.portal_url = (body.portalUrl || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "username")) patch.username = (body.username || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "password")) patch.password = body.password || null;
  if (Object.prototype.hasOwnProperty.call(body, "assignedUserId")) patch.assigned_user_id = body.assignedUserId || null;
  if (Object.prototype.hasOwnProperty.call(body, "lineOfBusiness")) patch.line_of_business = body.lineOfBusiness || null;
  if (Object.prototype.hasOwnProperty.call(body, "notes")) patch.notes = (body.notes || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "noSubmissionPortal")) patch.no_submission_portal = !!body.noSubmissionPortal;
  if (Object.prototype.hasOwnProperty.call(body, "submissionEmail")) patch.submission_email = (body.submissionEmail || "").trim() || null;

  let updated;
  try {
    updated = await supabaseRest(env, "organization_portal_logins?id=eq." + encodeURIComponent(id), { method: "PATCH", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the portal login.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, portalLogin: updated && updated[0] }, 200, cors);
}

async function handleOrgPortalLoginDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    await supabaseRest(env, "organization_portal_logins?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
  } catch (e) {
    return json({ ok: false, error: "Could not delete the portal login.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// Both "Partner Submission Form" and "Medicare Supplement Submission Form"
// are repeatable lists (one entry per plan year), form_type distinguishes
// which of the two original fields an entry belongs to.
async function handleOrgSubmissionFormsList(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const orgId = url.searchParams.get("orgId");
  if (!orgId) return json({ ok: false, error: "orgId is required." }, 400, cors);

  let rows;
  try {
    rows = await supabaseRest(env, "organization_submission_forms?org_id=eq." + encodeURIComponent(orgId) + "&select=id,org_id,form_type,url,plan_years,created_at&order=created_at.asc");
  } catch (e) {
    return json({ ok: false, error: "Could not load submission forms.", detail: String(e.message || e) }, 502, cors);
  }
  const results = (rows || []).map(function (r) {
    return { id: r.id, orgId: r.org_id, formType: r.form_type, url: r.url, planYears: r.plan_years, createdAt: r.created_at };
  });
  return json({ ok: true, submissionForms: results }, 200, cors);
}

async function handleOrgSubmissionFormCreate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const orgId = body.orgId;
  const formType = body.formType;
  const url2 = (body.url || "").trim();
  const planYears = Array.isArray(body.planYears) ? body.planYears : [];
  if (!orgId) return json({ ok: false, error: "orgId is required." }, 400, cors);
  if (formType !== "standard" && formType !== "medicare_supplement" && formType !== "final_expense") return json({ ok: false, error: "formType must be 'standard', 'medicare_supplement', or 'final_expense'." }, 400, cors);
  if (!url2) return json({ ok: false, error: "url is required." }, 400, cors);
  if (!planYears.length || planYears.some(function (y) { return y !== "PY26" && y !== "PY27"; })) {
    return json({ ok: false, error: "planYears must be a non-empty array of 'PY26'/'PY27'." }, 400, cors);
  }

  let created;
  try {
    created = await supabaseRest(env, "organization_submission_forms", { method: "POST", body: { org_id: orgId, form_type: formType, url: url2, plan_years: planYears } });
  } catch (e) {
    return json({ ok: false, error: "Could not add the submission form.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, submissionForm: created && created[0] }, 200, cors);
}

async function handleOrgSubmissionFormUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, "formType")) {
    if (body.formType !== "standard" && body.formType !== "medicare_supplement" && body.formType !== "final_expense") {
      return json({ ok: false, error: "formType must be 'standard', 'medicare_supplement', or 'final_expense'." }, 400, cors);
    }
    patch.form_type = body.formType;
  }
  if (Object.prototype.hasOwnProperty.call(body, "url")) {
    const trimmedUrl = (body.url || "").trim();
    if (!trimmedUrl) return json({ ok: false, error: "url cannot be blank." }, 400, cors);
    patch.url = trimmedUrl;
  }
  if (Object.prototype.hasOwnProperty.call(body, "planYears")) {
    const planYears = Array.isArray(body.planYears) ? body.planYears : [];
    if (!planYears.length || planYears.some(function (y) { return y !== "PY26" && y !== "PY27"; })) {
      return json({ ok: false, error: "planYears must be a non-empty array of 'PY26'/'PY27'." }, 400, cors);
    }
    patch.plan_years = planYears;
  }
  if (Object.keys(patch).length === 0) return json({ ok: false, error: "Nothing to update." }, 400, cors);

  let updated;
  try {
    updated = await supabaseRest(env, "organization_submission_forms?id=eq." + encodeURIComponent(id), { method: "PATCH", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the submission form.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, submissionForm: updated && updated[0] }, 200, cors);
}

async function handleOrgSubmissionFormDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    await supabaseRest(env, "organization_submission_forms?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
  } catch (e) {
    return json({ ok: false, error: "Could not delete the submission form.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

const CONTACT_TYPES = ["Compliance", "Operations", "Owner", "Media Buyer"];

async function handlePartnerUsersList(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const orgId = url.searchParams.get("orgId") || "";

  let path = "users?select=id,email,role,org_id,active,created_at,last_login_at,first_name,last_name,phone_number,contact_type,organizations(name)&order=created_at.desc";
  if (orgId) path += "&org_id=eq." + encodeURIComponent(orgId);

  let users;
  try { users = await supabaseRest(env, path); }
  catch (e) { return json({ ok: false, error: "Could not load partner logins from Supabase.", detail: String(e.message || e) }, 502, cors); }

  const results = (users || []).map(function (u) {
    return {
      id: u.id, email: u.email, role: u.role, orgId: u.org_id,
      orgName: u.organizations && u.organizations.name,
      active: u.active, createdAt: u.created_at, lastLoginAt: u.last_login_at,
      firstName: u.first_name, lastName: u.last_name, phone: u.phone_number, contactType: u.contact_type
    };
  });
  return json({ ok: true, users: results }, 200, cors);
}

// Separate action from org-create on purpose: an org can have more than one
// partner login, so inviting a login is not part of creating the org.
async function handlePartnerUserInvite(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const email = (body.email || "").trim().toLowerCase();
  const orgId = body.orgId;
  const firstName = (body.firstName || "").trim() || null;
  const lastName = (body.lastName || "").trim() || null;
  const phone = (body.phone || "").trim() || null;
  const contactType = CONTACT_TYPES.indexOf(body.contactType) !== -1 ? body.contactType : null;
  const passwordProvided = !!body.password;
  const password = body.password || "";
  if (!email || !orgId) return json({ ok: false, error: "email and orgId are required." }, 400, cors);
  if (passwordProvided && password.length < 8) return json({ ok: false, error: "Password must be at least 8 characters." }, 400, cors);

  // A password is not required to save a contact -- users.id is a foreign
  // key to auth.users(id) though (see initial_schema.sql), so some Supabase
  // Auth account must exist underneath every row in `users` regardless.
  // When the admin leaves the field blank, generate an unguessable
  // placeholder here and never surface it: the account exists but has no
  // usable credentials until the admin comes back and uses "Assign
  // Password" (already wired up) to set a real one. No Supabase invite
  // email is ever sent either way -- admin relays credentials themselves.
  const effectivePassword = passwordProvided ? password : generateRandomPassword();
  let authUserId;
  try {
    const created = await supabaseAuthAdmin(env, "admin/users", {
      method: "POST",
      body: { email: email, password: effectivePassword, email_confirm: true }
    });
    authUserId = created && created.id;
  } catch (e) {
    return json({ ok: false, error: "Could not create the account.", detail: String(e.message || e) }, 502, cors);
  }

  if (!authUserId) return json({ ok: false, error: "Supabase did not return a user id." }, 502, cors);

  try {
    await supabaseRest(env, "users", {
      method: "POST",
      body: { id: authUserId, email: email, role: "partner", org_id: orgId, active: true, first_name: firstName, last_name: lastName, phone_number: phone, contact_type: contactType }
    });
  } catch (e) {
    // Roll back the auth-only account so a failed profile write doesn't
    // leave an orphaned login with no organization profile row.
    await supabaseAuthAdmin(env, "admin/users/" + authUserId, { method: "DELETE" }).catch(function () {});
    return json({ ok: false, error: "The account was created but the partner profile could not be saved; it was rolled back.", detail: String(e.message || e) }, 502, cors);
  }

  return json({ ok: true, id: authUserId, passwordSet: passwordProvided }, 200, cors);
}

async function handlePartnerUserUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  const patch = {};
  if (typeof body.active === "boolean") patch.active = body.active;
  if (Object.prototype.hasOwnProperty.call(body, "firstName")) patch.first_name = (body.firstName || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "lastName")) patch.last_name = (body.lastName || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "phone")) patch.phone_number = (body.phone || "").trim() || null;
  if (Object.prototype.hasOwnProperty.call(body, "contactType")) patch.contact_type = CONTACT_TYPES.indexOf(body.contactType) !== -1 ? body.contactType : null;
  if (Object.keys(patch).length === 0) return json({ ok: false, error: "Nothing to update." }, 400, cors);

  let updated;
  try {
    updated = await supabaseRest(env, "users?id=eq." + encodeURIComponent(id), { method: "PATCH", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the partner login.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, user: updated && updated[0] }, 200, cors);
}

// Two admin actions for a partner who can't log in -- neither one ever puts
// a plaintext password through this app's own storage or logs beyond the
// single response used to show it to admin once:
//  - send-reset-email: standard, safest path -- Supabase emails the partner
//    a reset link, same as their own "Forgot Password?" would.
//  - set-password: for when the partner has no email access right now --
//    admin sets a temporary password directly (now that logins carry a
//    phone number, admin can relay it by phone) via the Auth Admin API.
async function handlePartnerUserSendResetEmail(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  let rows;
  try { rows = await supabaseRest(env, "users?id=eq." + encodeURIComponent(id) + "&select=email"); }
  catch (e) { return json({ ok: false, error: "Could not look up the login.", detail: String(e.message || e) }, 502, cors); }
  const email = rows && rows[0] && rows[0].email;
  if (!email) return json({ ok: false, error: "Login not found." }, 404, cors);

  try {
    await fetch(getSupabaseUrl(env) + "/auth/v1/recover", {
      method: "POST",
      headers: { "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email })
    });
  } catch (e) {
    return json({ ok: false, error: "Could not send the reset email.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerUserSetPassword(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  const password = body.password || "";
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  if (password.length < 8) return json({ ok: false, error: "Password must be at least 8 characters." }, 400, cors);

  try {
    await supabaseAuthAdmin(env, "admin/users/" + encodeURIComponent(id), { method: "PUT", body: { password: password } });
  } catch (e) {
    return json({ ok: false, error: "Could not set the password.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerUserDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    // Deletes from auth.users; users.id -> auth.users(id) on delete cascade
    // removes the public.users profile row too.
    await supabaseAuthAdmin(env, "admin/users/" + id, { method: "DELETE" });
  } catch (e) {
    return json({ ok: false, error: "Could not delete the partner login.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// ---------- Partner Portal admin (Supabase) — materials, opt-ins, org sharing, files ----------
// A material becomes visible to a partner organization purely by the
// presence of a material_shares (material_id, org_id) row -- there is no
// concept of sharing with an individual login. Toggling a share here grants
// or revokes access for every user under that organization at once, since
// every partner-side RLS policy resolves access through current_org_id(),
// never a specific user id.
const MATERIAL_FIELDS = [
  "smid", "status", "plan_year", "batch_id", "classification", "is_annual_resubmission",
  "medium", "benefit_type", "distribution_area", "time_period",
  "start_date", "end_date", "hpms_filing_date", "media_type"
];
const STORAGE_BUCKET = "material-files";
// Separate, admin-only bucket -- End Screen Disclaimers, Social Ad Image
// Proof, Google Search Ad Proof. No partner-facing Storage policy exists
// on this bucket at all, unlike STORAGE_BUCKET.
const ADMIN_STORAGE_BUCKET = "material-admin-files";
// Org-level admin-only assets: a partner's logo (shown in the admin's own
// view of that org) and their signed Master Service Agreement. Never
// exposed to a partner's own session, same as ADMIN_STORAGE_BUCKET.
const ORG_LOGO_BUCKET = "organization-logos";
const ORG_DOCS_BUCKET = "organization-documents";
// Carrier Organizations are a separate concept from the "organizations"
// table above (Apex's selling partners) -- this is the insurance carrier
// itself, and its Guidelines/Guardrails PDF is its own admin-only bucket.
const CARRIER_GUIDELINES_BUCKET = "carrier-guidelines";
const CARRIER_LOGO_BUCKET = "carrier-logos";
const APEX_OP_LOGIN_LOGO_BUCKET = "apex-operational-login-logos";

function pickDefined(body, fields) {
  const out = {};
  fields.forEach(function (f) {
    if (Object.prototype.hasOwnProperty.call(body, f) && body[f] !== undefined) out[f] = body[f];
  });
  return out;
}

const AUDIT_ACTOR_NAME = "My Health Angel Compliance";

// Best-effort -- an audit-logging failure should never block the real
// operation it's describing. material_shares grant/revoke is already
// logged automatically by the DB trigger (audit_share_change()); every
// other admin write logs itself explicitly here.
async function insertAudit(env, entry) {
  try {
    await supabaseRest(env, "audit_log", {
      method: "POST",
      headers: { "Prefer": "return=minimal" },
      body: Object.assign({ actor_type: "admin", actor_name: AUDIT_ACTOR_NAME }, entry)
    });
  } catch (e) { /* best-effort */ }
}

async function supabaseStorageUpload(env, path, blob, contentType, bucket) {
  const resp = await fetch(getSupabaseUrl(env) + "/storage/v1/object/" + (bucket || STORAGE_BUCKET) + "/" + path, {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": contentType || "application/octet-stream",
      "x-upsert": "true"
    },
    body: blob
  });
  const text = await resp.text().catch(function () { return ""; });
  if (!resp.ok) throw new Error("Supabase Storage upload error: " + text);
}

// Admin's browser never holds a Supabase session (Compliance Portal auth is
// Cloudflare Access, not Supabase Auth) -- so unlike the partner client,
// which can call Storage directly with its own JWT under RLS, admin
// downloads have to go through the Worker's service_role key too, same as
// every other admin write in this section.
// downloadFileName, when passed, makes the browser save the file under that
// exact name (via Supabase Storage's `?download=` query param, which sets a
// real Content-Disposition: attachment header on the response) instead of
// whatever the storage path's own segment happens to be -- storage paths are
// timestamp-prefixed/sanitized for uniqueness and are never the name a user
// should actually see land in their Downloads folder.
async function supabaseStorageSignedUrl(env, path, expiresIn, bucket, downloadFileName) {
  const resp = await fetch(getSupabaseUrl(env) + "/storage/v1/object/sign/" + (bucket || STORAGE_BUCKET) + "/" + path, {
    method: "POST",
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ expiresIn: expiresIn || 300 })
  });
  const data = await resp.json().catch(function () { return null; });
  if (!resp.ok || !data || !data.signedURL) {
    throw new Error("Supabase Storage sign error: " + (data && (data.message || data.error) || ("HTTP " + resp.status)));
  }
  let url = getSupabaseUrl(env) + "/storage/v1" + data.signedURL;
  if (downloadFileName) url += "&download=" + encodeURIComponent(downloadFileName);
  return url;
}

async function supabaseStorageDelete(env, path, bucket) {
  await fetch(getSupabaseUrl(env) + "/storage/v1/object/" + (bucket || STORAGE_BUCKET) + "/" + path, {
    method: "DELETE",
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
    }
  }).catch(function () {});
}

async function handlePartnerMaterialsList(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  let rows;
  try {
    rows = await supabaseRest(env, "materials?select=" + encodeURIComponent(MATERIAL_FIELDS.concat(["id", "updated_at"]).join(",") + ",material_shares(count),material_internal_status(status)") + "&deleted_at=is.null&order=updated_at.desc");
  } catch (e) {
    return json({ ok: false, error: "Could not load materials from Supabase.", detail: String(e.message || e) }, 502, cors);
  }
  const results = (rows || []).map(function (m) {
    const out = Object.assign({}, m);
    out.shareCount = (m.material_shares && m.material_shares[0] && m.material_shares[0].count) || 0;
    out.internalStatus = (m.material_internal_status && m.material_internal_status.status) || null;
    delete out.material_shares;
    delete out.material_internal_status;
    return out;
  });
  return json({ ok: true, materials: results }, 200, cors);
}

async function handlePartnerMaterialDetail(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const material = await supabaseRest(env, "materials?id=eq." + encodeURIComponent(id) + "&select=*");
    if (!material || !material[0]) return json({ ok: false, error: "Material not found." }, 404, cors);
    const optins = await supabaseRest(env, "material_carrier_optins?material_id=eq." + encodeURIComponent(id) + "&select=*&order=carrier");
    const files = await supabaseRest(env, "material_files?material_id=eq." + encodeURIComponent(id) + "&select=*&order=uploaded_at");
    const shares = await supabaseRest(env, "material_shares?material_id=eq." + encodeURIComponent(id) + "&select=org_id");
    const internalRows = await supabaseRest(env, "material_internal_status?material_id=eq." + encodeURIComponent(id) + "&select=status");
    const adminDetailRows = await supabaseRest(env, "material_admin_creative_details?material_id=eq." + encodeURIComponent(id) + "&select=end_screen_disclaimer");
    const adminFiles = await supabaseRest(env, "material_admin_files?material_id=eq." + encodeURIComponent(id) + "&select=*&order=uploaded_at");
    const updateRows = await supabaseRest(env, "material_updates?material_id=eq." + encodeURIComponent(id) + "&select=" + encodeURIComponent("*,material_update_files(*)") + "&order=created_at.desc");
    const updates = (updateRows || []).map(function (u) {
      const ufiles = (u.material_update_files || []).slice().sort(function (a, b) { return String(a.uploaded_at).localeCompare(String(b.uploaded_at)); });
      return { id: u.id, body: u.body, carrier_tags: u.carrier_tags || [], author_name: u.author_name, created_at: u.created_at, files: ufiles };
    });
    return json({
      ok: true,
      material: material[0],
      optins: optins || [],
      files: files || [],
      shareOrgIds: (shares || []).map(function (s) { return s.org_id; }),
      internalStatus: (internalRows && internalRows[0] && internalRows[0].status) || null,
      endScreenDisclaimer: (adminDetailRows && adminDetailRows[0] && adminDetailRows[0].end_screen_disclaimer) || "",
      adminFiles: adminFiles || [],
      updates: updates
    }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not load the material.", detail: String(e.message || e) }, 502, cors);
  }
}

async function handlePartnerMaterialCreate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const smid = (body.smid || "").trim();
  if (!smid || !body.plan_year) return json({ ok: false, error: "smid and plan_year are required." }, 400, cors);

  const insertBody = pickDefined(body, MATERIAL_FIELDS);
  insertBody.smid = smid;

  let created;
  try {
    created = await supabaseRest(env, "materials", { method: "POST", body: insertBody });
  } catch (e) {
    return json({ ok: false, error: "Could not create the material.", detail: String(e.message || e) }, 502, cors);
  }
  const materialRow = created && created[0];
  if (materialRow) {
    await insertAudit(env, { kind: "item", action: "Material created", target: materialRow.smid, material_id: materialRow.id });
  }
  return json({ ok: true, material: materialRow }, 200, cors);
}

async function handlePartnerMaterialUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  const patch = pickDefined(body, MATERIAL_FIELDS);
  if (Object.keys(patch).length === 0) return json({ ok: false, error: "Nothing to update." }, 400, cors);

  let updated;
  try {
    updated = await supabaseRest(env, "materials?id=eq." + encodeURIComponent(id), { method: "PATCH", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the material.", detail: String(e.message || e) }, 502, cors);
  }
  const materialRow = updated && updated[0];
  if (materialRow) {
    const changedFields = Object.keys(patch).join(", ");
    await insertAudit(env, { kind: patch.status ? "status" : "item", action: "Material updated", target: materialRow.smid, detail: changedFields, material_id: materialRow.id });
  }
  return json({ ok: true, material: materialRow }, 200, cors);
}

// Geotargeting Grid -- admin uploads a grid once into the shared library
// (below) and links it to any number of materials, instead of every
// material carrying its own duplicate upload. materials.geotargeting_grid_id
// records which library grid (if any) a material is linked to;
// geotargeting_grid_file_path/file_name are kept in sync on every link
// change and whenever the library file is replaced, so the Partner Portal
// client's own reads/downloads (which key off those two columns directly,
// via Supabase Storage under its own session) need no changes at all.
async function handleMaterialGeotargetingGridLink(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const materialId = body.materialId;
  if (!materialId) return json({ ok: false, error: "materialId is required." }, 400, cors);
  const gridId = body.gridId || null;

  try {
    let patch = { geotargeting_grid_id: null, geotargeting_grid_file_path: null, geotargeting_grid_file_name: null };
    if (gridId) {
      const gridRows = await supabaseRest(env, "geotargeting_grids?id=eq." + encodeURIComponent(gridId) + "&select=storage_path,file_name");
      const grid = gridRows && gridRows[0];
      if (!grid) return json({ ok: false, error: "That Geotargeting Grid could not be found." }, 404, cors);
      patch = { geotargeting_grid_id: gridId, geotargeting_grid_file_path: grid.storage_path, geotargeting_grid_file_name: grid.file_name };
    }
    await supabaseRest(env, "materials?id=eq." + encodeURIComponent(materialId), { method: "PATCH", prefer: "return=minimal", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the Geotargeting Grid.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// Every library grid, plus how many materials currently link to it (so the
// library view can warn before a delete that would orphan materials).
async function handleGeotargetingGridsList(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;

  try {
    const grids = await supabaseRest(env, "geotargeting_grids?select=*&order=uploaded_at.desc");
    const links = await supabaseRest(env, "materials?geotargeting_grid_id=not.is.null&select=geotargeting_grid_id");
    const counts = {};
    (links || []).forEach(function (m) { counts[m.geotargeting_grid_id] = (counts[m.geotargeting_grid_id] || 0) + 1; });
    const results = (grids || []).map(function (g) { return Object.assign({}, g, { materialCount: counts[g.id] || 0 }); });
    return json({ ok: true, grids: results }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not load the Geotargeting Grid library.", detail: String(e.message || e) }, 502, cors);
  }
}

// Adds a new grid to the library only -- does not link it to any material.
async function handleGeotargetingGridUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const file = form.get("file");
  const planYear = form.get("planYear");
  if (!file || typeof file === "string") return json({ ok: false, error: "file is required." }, 400, cors);

  const safeName = String(file.name || "geotargeting-grid.xlsx").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "geotargeting-grids/" + Date.now() + "-" + safeName;

  let gridRow;
  try {
    await supabaseStorageUpload(env, path, file, file.type);
    const inserted = await supabaseRest(env, "geotargeting_grids", {
      method: "POST",
      body: { file_name: file.name || safeName, storage_path: path, plan_year: planYear ? Number(planYear) : null }
    });
    gridRow = inserted && inserted[0];
  } catch (e) {
    return json({ ok: false, error: "Could not upload the Geotargeting Grid.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, grid: gridRow }, 200, cors);
}

// Replaces a library grid's file content in place (same row id, new storage
// object) and cascades the new path/name onto every material currently
// linked to it -- this is the December-CMS-reissue workflow: replace once,
// every linked material's partner-visible download reflects it immediately.
async function handleGeotargetingGridReplace(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const id = form.get("id");
  const file = form.get("file");
  if (!id || !file || typeof file === "string") return json({ ok: false, error: "id and file are required." }, 400, cors);

  const safeName = String(file.name || "geotargeting-grid.xlsx").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "geotargeting-grids/" + Date.now() + "-" + safeName;

  try {
    const oldRows = await supabaseRest(env, "geotargeting_grids?id=eq." + encodeURIComponent(id) + "&select=storage_path");
    const oldPath = oldRows && oldRows[0] && oldRows[0].storage_path;
    if (!oldRows || !oldRows[0]) return json({ ok: false, error: "That Geotargeting Grid could not be found." }, 404, cors);

    await supabaseStorageUpload(env, path, file, file.type);
    await supabaseRest(env, "geotargeting_grids?id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: { file_name: file.name || safeName, storage_path: path } });
    await supabaseRest(env, "materials?geotargeting_grid_id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: { geotargeting_grid_file_path: path, geotargeting_grid_file_name: file.name || safeName } });
    if (oldPath) await supabaseStorageDelete(env, oldPath).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not replace the Geotargeting Grid.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// Removes a grid from the library entirely -- clears the link (and the
// synced file_path/file_name) on every material that used it, then deletes
// the storage object and the row.
async function handleGeotargetingGridDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "geotargeting_grids?id=eq." + encodeURIComponent(id) + "&select=storage_path");
    const oldPath = rows && rows[0] && rows[0].storage_path;
    await supabaseRest(env, "materials?geotargeting_grid_id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: { geotargeting_grid_id: null, geotargeting_grid_file_path: null, geotargeting_grid_file_name: null } });
    await supabaseRest(env, "geotargeting_grids?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    if (oldPath) await supabaseStorageDelete(env, oldPath).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not delete the Geotargeting Grid.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleMaterialGeotargetingGridDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const materialId = url.searchParams.get("materialId");
  if (!materialId) return json({ ok: false, error: "materialId is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "materials?id=eq." + encodeURIComponent(materialId) + "&select=geotargeting_grid_file_path,geotargeting_grid_file_name");
    const row = rows && rows[0];
    if (!row || !row.geotargeting_grid_file_path) return json({ ok: false, error: "No Geotargeting Grid on file for this material." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, row.geotargeting_grid_file_path, 300, undefined, row.geotargeting_grid_file_name);
    return json({ ok: true, url: signedUrl, fileName: row.geotargeting_grid_file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a view link.", detail: String(e.message || e) }, 502, cors);
  }
}

// Soft delete only -- CMS marketing-material retention rules mean deletion
// must be deliberate and logged, never a hard DELETE.
async function handlePartnerMaterialDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "materials?id=eq." + encodeURIComponent(id) + "&select=smid");
    await supabaseRest(env, "materials?id=eq." + encodeURIComponent(id), { method: "PATCH", body: { deleted_at: new Date().toISOString() } });
    await insertAudit(env, { kind: "item", action: "Material deleted", target: rows && rows[0] && rows[0].smid, material_id: id });
  } catch (e) {
    return json({ ok: false, error: "Could not delete the material.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerOptinUpsert(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const materialId = body.materialId, carrier = (body.carrier || "").trim();
  if (!materialId || !carrier) return json({ ok: false, error: "materialId and carrier are required." }, 400, cors);

  const row = {
    material_id: materialId,
    carrier: carrier,
    opted_in: !!body.optedIn,
    optin_date: body.optinDate || null,
    pre_approval_date: body.preApprovalDate || null
  };
  let result;
  try {
    result = await supabaseRest(env, "material_carrier_optins?on_conflict=material_id,carrier", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
      body: row
    });
  } catch (e) {
    return json({ ok: false, error: "Could not save the carrier opt-in.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, optin: result && result[0] }, 200, cors);
}

async function handlePartnerOptinDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    await supabaseRest(env, "material_carrier_optins?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
  } catch (e) {
    return json({ ok: false, error: "Could not remove the carrier opt-in.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// The one feature that actually controls partner visibility: granting or
// revoking here immediately affects every login under that organization,
// since access is resolved per-org (current_org_id()), never per-user.
// material_shares' own INSERT/DELETE triggers write the audit_log entry
// automatically -- nothing extra to log here.
async function handlePartnerShareToggle(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const materialId = body.materialId, orgId = body.orgId;
  if (!materialId || !orgId || typeof body.share !== "boolean") {
    return json({ ok: false, error: "materialId, orgId, and share (boolean) are required." }, 400, cors);
  }

  try {
    if (body.share) {
      await supabaseRest(env, "material_shares", { method: "POST", headers: { "Prefer": "resolution=ignore-duplicates,return=minimal" }, body: { material_id: materialId, org_id: orgId } });
    } else {
      await supabaseRest(env, "material_shares?material_id=eq." + encodeURIComponent(materialId) + "&org_id=eq." + encodeURIComponent(orgId), { method: "DELETE", prefer: "return=minimal" });
    }
  } catch (e) {
    return json({ ok: false, error: "Could not update sharing.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerFileUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const materialId = form.get("materialId");
  const category = form.get("category") || "";
  const optinId = form.get("optinId"); // optional: link this upload as that carrier opt-in's confirmation file
  const statusOrgId = form.get("statusOrgId"); // optional: link this upload as that org's approval confirmation file
  const file = form.get("file");
  if (!materialId || !file || typeof file === "string") {
    return json({ ok: false, error: "materialId and file are required." }, 400, cors);
  }

  const safeName = String(file.name || "upload").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "materials/" + materialId + "/" + Date.now() + "-" + safeName;

  let fileRow;
  try {
    await supabaseStorageUpload(env, path, file, file.type);
    const inserted = await supabaseRest(env, "material_files", {
      method: "POST",
      body: { material_id: materialId, file_name: file.name || safeName, category: category, storage_path: path, uploaded_by: null }
    });
    fileRow = inserted && inserted[0];
    if (optinId && fileRow) {
      await supabaseRest(env, "material_carrier_optins?id=eq." + encodeURIComponent(optinId), { method: "PATCH", body: { confirmation_file_id: fileRow.id } });
    }
    if (statusOrgId && fileRow) {
      // status is NOT NULL with no default -- if this org has no status row
      // yet, fall back to 'Submitted' so the insert half of the upsert
      // never fails; if a row already exists, merge-duplicates leaves its
      // real status untouched (Postgres upsert only overwrites the columns
      // actually listed as excluded/updated -- here that's just this column).
      const existingStatus = await supabaseRest(env, "material_org_status?material_id=eq." + encodeURIComponent(materialId) + "&org_id=eq." + encodeURIComponent(statusOrgId) + "&select=status").catch(function () { return null; });
      const statusForUpsert = (existingStatus && existingStatus[0] && existingStatus[0].status) || "Submitted";
      await supabaseRest(env, "material_org_status?on_conflict=material_id,org_id", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: { material_id: materialId, org_id: statusOrgId, status: statusForUpsert, approval_confirmation_file_id: fileRow.id }
      });
    }
  } catch (e) {
    return json({ ok: false, error: "Could not upload the file.", detail: String(e.message || e) }, 502, cors);
  }
  if (fileRow) {
    const matRows = await supabaseRest(env, "materials?id=eq." + encodeURIComponent(materialId) + "&select=smid").catch(function () { return null; });
    await insertAudit(env, { kind: "file", action: "Document added", target: matRows && matRows[0] && matRows[0].smid, detail: fileRow.file_name, material_id: materialId });
  }
  return json({ ok: true, file: fileRow }, 200, cors);
}

async function handlePartnerFileDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "material_files?id=eq." + encodeURIComponent(id) + "&select=storage_path,file_name,material_id");
    const fileRow = rows && rows[0];
    // material_carrier_optins.confirmation_file_id is ON DELETE SET NULL, so
    // deleting this row automatically un-links any opt-in pointing at it.
    await supabaseRest(env, "material_files?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    if (fileRow && fileRow.storage_path) await supabaseStorageDelete(env, fileRow.storage_path);
    if (fileRow) {
      const matRows = await supabaseRest(env, "materials?id=eq." + encodeURIComponent(fileRow.material_id) + "&select=smid").catch(function () { return null; });
      await insertAudit(env, { kind: "file", action: "Document removed", target: matRows && matRows[0] && matRows[0].smid, detail: fileRow.file_name, material_id: fileRow.material_id });
    }
  } catch (e) {
    return json({ ok: false, error: "Could not delete the file.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerFileDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "material_files?id=eq." + encodeURIComponent(id) + "&select=storage_path,file_name");
    const fileRow = rows && rows[0];
    if (!fileRow) return json({ ok: false, error: "File not found." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, fileRow.storage_path, 300, undefined, fileRow.file_name);
    return json({ ok: true, url: signedUrl, fileName: fileRow.file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a download link.", detail: String(e.message || e) }, 502, cors);
  }
}

// Admin sees every organization's thread for a material (never possible for
// a partner, whose RLS scopes messages to their own org_id only) -- the
// frontend groups these by org_id into one panel per organization, mirroring
// how each partner's conversation with Apex is a separate, private thread.
async function handlePartnerMaterialMessages(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const materialId = url.searchParams.get("materialId");
  if (!materialId) return json({ ok: false, error: "materialId is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "messages?material_id=eq." + encodeURIComponent(materialId) + "&select=*&order=created_at");
    return json({ ok: true, messages: rows || [] }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not load messages.", detail: String(e.message || e) }, 502, cors);
  }
}

// Every message across every material, for the top-level Discussions tab --
// the client groups these by (material_id, org_id) into one row per
// conversation. Raw rows only (no SMID/org-name join) since the admin
// frontend already has the full materials and orgs lists loaded to cross-
// reference against.
async function handlePartnerAllMaterialMessages(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;

  try {
    const rows = await supabaseRest(env, "messages?select=*&order=created_at.desc");
    return json({ ok: true, messages: rows || [] }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not load discussions.", detail: String(e.message || e) }, 502, cors);
  }
}

async function handlePartnerMaterialMessageSend(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const materialId = body.materialId, orgId = body.orgId, text = (body.body || "").trim();
  if (!materialId || !orgId || !text) return json({ ok: false, error: "materialId, orgId, and body are required." }, 400, cors);

  let inserted;
  try {
    inserted = await supabaseRest(env, "messages", {
      method: "POST",
      body: { material_id: materialId, org_id: orgId, author_type: "admin", author_name: AUDIT_ACTOR_NAME, body: text }
    });
  } catch (e) {
    return json({ ok: false, error: "Could not send the message.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, message: inserted && inserted[0] }, 200, cors);
}

// Every organization's status for this material, in one call -- a partner
// can never see this (RLS scopes material_org_status to their own org_id),
// which is exactly why it's admin-only and lives here.
async function handlePartnerMaterialStatuses(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const materialId = url.searchParams.get("materialId");
  if (!materialId) return json({ ok: false, error: "materialId is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "material_org_status?material_id=eq." + encodeURIComponent(materialId) + "&select=org_id,status,updated_at,submission_date,approval_date,approval_confirmation_file_id");
    return json({ ok: true, statuses: rows || [] }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not load partner statuses.", detail: String(e.message || e) }, 502, cors);
  }
}

// Answers the developer handoff's open question ("should Apex see
// partner-set statuses only, or be able to override them?") -- yes, admin
// can set/override any organization's status directly, with an optional
// approval date. The confirmation file itself is attached via the regular
// upload route (statusOrgId param), not here.
async function handlePartnerOrgStatusUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const materialId = body.materialId, orgId = body.orgId, status = body.status;
  if (!materialId || !orgId || !status) return json({ ok: false, error: "materialId, orgId, and status are required." }, 400, cors);

  const row = { material_id: materialId, org_id: orgId, status: status };
  if (body.approvalDate !== undefined) row.approval_date = body.approvalDate || null;
  if (body.submissionDate !== undefined) row.submission_date = body.submissionDate || null;

  try {
    const prevRows = await supabaseRest(env, "material_org_status?material_id=eq." + encodeURIComponent(materialId) + "&org_id=eq." + encodeURIComponent(orgId) + "&select=status").catch(function () { return null; });
    const prevStatus = prevRows && prevRows[0] && prevRows[0].status;
    await supabaseRest(env, "material_org_status?on_conflict=material_id,org_id", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: row
    });
    if (prevStatus !== status) {
      await supabaseRest(env, "material_status_history", {
        method: "POST",
        body: { material_id: materialId, org_id: orgId, from_status: prevStatus || null, to_status: status, changed_by: AUDIT_ACTOR_NAME }
      });
      const matRows = await supabaseRest(env, "materials?id=eq." + encodeURIComponent(materialId) + "&select=smid").catch(function () { return null; });
      await insertAudit(env, { kind: "status", action: "Status changed", target: matRows && matRows[0] && matRows[0].smid, detail: (prevStatus || "—") + " → " + status + " (admin override)", material_id: materialId, org_id: orgId });
    }
  } catch (e) {
    return json({ ok: false, error: "Could not update the partner status.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerAudit(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;

  const materialId = url.searchParams.get("materialId") || "";
  const kind = url.searchParams.get("kind") || "";
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);

  let path = "audit_log?select=*&order=occurred_at.desc&limit=" + limit;
  if (materialId) path += "&material_id=eq." + encodeURIComponent(materialId);
  if (kind) path += "&kind=eq." + encodeURIComponent(kind);

  let rows;
  try {
    rows = await supabaseRest(env, path);
  } catch (e) {
    return json({ ok: false, error: "Could not load the audit log.", detail: String(e.message || e) }, 502, cors);
  }
  if (q) {
    rows = (rows || []).filter(function (r) {
      const hay = ((r.action || "") + " " + (r.target || "") + " " + (r.detail || "") + " " + (r.actor_name || "")).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }
  return json({ ok: true, entries: rows || [] }, 200, cors);
}

// Internal status lives in its own table with no partner-facing RLS policy
// at all (see the migration) -- a partner can never read this, regardless
// of what a compromised or modified client happened to ask for.
async function handlePartnerInternalStatusUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const materialId = body.materialId, status = (body.status || "").trim();
  if (!materialId || !status) return json({ ok: false, error: "materialId and status are required." }, 400, cors);

  try {
    await supabaseRest(env, "material_internal_status?on_conflict=material_id", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: { material_id: materialId, status: status }
    });
    const matRows = await supabaseRest(env, "materials?id=eq." + encodeURIComponent(materialId) + "&select=smid").catch(function () { return null; });
    await insertAudit(env, { kind: "status", action: "Internal status updated", target: matRows && matRows[0] && matRows[0].smid, detail: status, material_id: materialId });
  } catch (e) {
    return json({ ok: false, error: "Could not update the internal status.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// ---------- Admin-only creative details (End Screen Disclaimers, Social Ad
// Image Proof, Google Search Ad Proof) -- own table/bucket, no partner
// policy exists anywhere in this chain. See the migration's comment. ----------

async function handlePartnerAdminDetailsUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const materialId = body.materialId;
  if (!materialId) return json({ ok: false, error: "materialId is required." }, 400, cors);

  try {
    await supabaseRest(env, "material_admin_creative_details?on_conflict=material_id", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
      body: { material_id: materialId, end_screen_disclaimer: body.endScreenDisclaimer || null }
    });
  } catch (e) {
    return json({ ok: false, error: "Could not save.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerAdminFileUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const materialId = form.get("materialId");
  const category = form.get("category") || "";
  const file = form.get("file");
  if (!materialId || !category || !file || typeof file === "string") {
    return json({ ok: false, error: "materialId, category, and file are required." }, 400, cors);
  }

  const safeName = String(file.name || "upload").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "materials/" + materialId + "/" + Date.now() + "-" + safeName;

  let fileRow;
  try {
    await supabaseStorageUpload(env, path, file, file.type, ADMIN_STORAGE_BUCKET);
    const inserted = await supabaseRest(env, "material_admin_files", {
      method: "POST",
      body: { material_id: materialId, category: category, file_name: file.name || safeName, storage_path: path }
    });
    fileRow = inserted && inserted[0];
  } catch (e) {
    return json({ ok: false, error: "Could not upload the file.", detail: String(e.message || e) }, 502, cors);
  }
  if (fileRow) {
    const matRows = await supabaseRest(env, "materials?id=eq." + encodeURIComponent(materialId) + "&select=smid").catch(function () { return null; });
    await insertAudit(env, { kind: "file", action: category + " added", target: matRows && matRows[0] && matRows[0].smid, detail: fileRow.file_name, material_id: materialId });
  }
  return json({ ok: true, file: fileRow }, 200, cors);
}

async function handlePartnerAdminFileDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "material_admin_files?id=eq." + encodeURIComponent(id) + "&select=storage_path,file_name,material_id,category");
    const fileRow = rows && rows[0];
    await supabaseRest(env, "material_admin_files?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    if (fileRow && fileRow.storage_path) await supabaseStorageDelete(env, fileRow.storage_path, ADMIN_STORAGE_BUCKET);
    if (fileRow) {
      const matRows = await supabaseRest(env, "materials?id=eq." + encodeURIComponent(fileRow.material_id) + "&select=smid").catch(function () { return null; });
      await insertAudit(env, { kind: "file", action: fileRow.category + " removed", target: matRows && matRows[0] && matRows[0].smid, detail: fileRow.file_name, material_id: fileRow.material_id });
    }
  } catch (e) {
    return json({ ok: false, error: "Could not delete the file.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handlePartnerAdminFileDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "material_admin_files?id=eq." + encodeURIComponent(id) + "&select=storage_path,file_name");
    const fileRow = rows && rows[0];
    if (!fileRow) return json({ ok: false, error: "File not found." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, fileRow.storage_path, 300, ADMIN_STORAGE_BUCKET, fileRow.file_name);
    return json({ ok: true, url: signedUrl, fileName: fileRow.file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a download link.", detail: String(e.message || e) }, 502, cors);
  }
}

// ---------- Material Updates (admin-only) ----------
// Dated admin notes on a material, each with optional carrier tags and any
// number of attached files. Admin-only by construction: the rows live in
// material_updates / material_update_files (RLS enabled, no policies -- only
// the service-role key used here can read them; the Partner Portal client
// never queries them) and the files go in the admin-only bucket
// (ADMIN_STORAGE_BUCKET), which has no partner Storage policy either.

async function handleMaterialUpdateCreate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const materialId = body.materialId;
  const text = String(body.body || "").trim();
  if (!materialId || !text) return json({ ok: false, error: "materialId and body are required." }, 400, cors);
  const carrierTags = Array.isArray(body.carrierTags)
    ? body.carrierTags.map(function (c) { return String(c || "").trim(); }).filter(Boolean)
    : [];
  let row;
  try {
    const inserted = await supabaseRest(env, "material_updates", {
      method: "POST",
      body: { material_id: materialId, body: text, carrier_tags: carrierTags, author_name: AUDIT_ACTOR_NAME }
    });
    row = inserted && inserted[0];
  } catch (e) {
    return json({ ok: false, error: "Could not post the update.", detail: String(e.message || e) }, 502, cors);
  }
  if (row) {
    const matRows = await supabaseRest(env, "materials?id=eq." + encodeURIComponent(materialId) + "&select=smid").catch(function () { return null; });
    await insertAudit(env, { kind: "item", action: "Update posted", target: matRows && matRows[0] && matRows[0].smid, detail: text.slice(0, 120), material_id: materialId });
  }
  return json({ ok: true, update: row }, 200, cors);
}

async function handleMaterialUpdateDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  try {
    const files = await supabaseRest(env, "material_update_files?update_id=eq." + encodeURIComponent(id) + "&select=storage_path");
    await supabaseRest(env, "material_updates?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    await Promise.all((files || []).map(function (f) { return supabaseStorageDelete(env, f.storage_path, ADMIN_STORAGE_BUCKET).catch(function () {}); }));
  } catch (e) {
    return json({ ok: false, error: "Could not delete the update.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleMaterialUpdateFileUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }
  const updateId = form.get("updateId");
  const file = form.get("file");
  if (!updateId || !file || typeof file === "string") {
    return json({ ok: false, error: "updateId and file are required." }, 400, cors);
  }
  let fileRow;
  try {
    const updates = await supabaseRest(env, "material_updates?id=eq." + encodeURIComponent(updateId) + "&select=material_id");
    const update = updates && updates[0];
    if (!update) return json({ ok: false, error: "Update not found." }, 404, cors);
    const safeName = String(file.name || "upload").replace(/[^A-Za-z0-9._-]/g, "_");
    const path = "materials/" + update.material_id + "/updates/" + updateId + "/" + Date.now() + "-" + safeName;
    await supabaseStorageUpload(env, path, file, file.type, ADMIN_STORAGE_BUCKET);
    const inserted = await supabaseRest(env, "material_update_files", {
      method: "POST",
      body: { update_id: updateId, file_name: file.name || safeName, storage_path: path }
    });
    fileRow = inserted && inserted[0];
  } catch (e) {
    return json({ ok: false, error: "Could not upload the file.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, file: fileRow }, 200, cors);
}

async function handleMaterialUpdateFileDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  try {
    const rows = await supabaseRest(env, "material_update_files?id=eq." + encodeURIComponent(id) + "&select=storage_path");
    const fileRow = rows && rows[0];
    await supabaseRest(env, "material_update_files?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    if (fileRow && fileRow.storage_path) await supabaseStorageDelete(env, fileRow.storage_path, ADMIN_STORAGE_BUCKET).catch(function () {});
  } catch (e) {
    return json({ ok: false, error: "Could not remove the file.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleMaterialUpdateFileDownloadUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);
  try {
    const rows = await supabaseRest(env, "material_update_files?id=eq." + encodeURIComponent(id) + "&select=storage_path,file_name");
    const fileRow = rows && rows[0];
    if (!fileRow) return json({ ok: false, error: "File not found." }, 404, cors);
    const signedUrl = await supabaseStorageSignedUrl(env, fileRow.storage_path, 300, ADMIN_STORAGE_BUCKET, fileRow.file_name);
    return json({ ok: true, url: signedUrl, fileName: fileRow.file_name }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a download link.", detail: String(e.message || e) }, 502, cors);
  }
}

// ---------- Manual data backup ----------
// Not a real pg_dump (no schema, no exact SQL) -- the schema itself is
// already fully version-controlled via supabase/migrations/*.sql in the
// partner portal's repo, so recovery is: replay the migrations, then
// restore this JSON. Excludes auth.users (Supabase's own auth store,
// backed up separately by Supabase itself) and Storage file bytes
// (material-files / material-admin-files buckets -- only the metadata
// rows pointing at them are included here).
const BACKUP_TABLES = [
  "organizations", "users", "materials", "material_carrier_optins",
  "material_files", "material_shares", "material_org_status",
  "material_status_history", "messages", "audit_log",
  "material_internal_status", "material_admin_creative_details", "material_admin_files"
];

async function handlePartnerBackup(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;

  const out = { generatedAt: new Date().toISOString(), tables: {} };
  for (const table of BACKUP_TABLES) {
    try {
      out.tables[table] = await supabaseRest(env, table + "?select=*");
    } catch (e) {
      out.tables[table] = { error: String(e.message || e) };
    }
  }
  return json(out, 200, cors);
}

// Partner-originated activity feed for the Apex Master Material Dashboard --
// discussion posts a partner leaves, and status changes a partner actions
// from their own side (org_id is not null on material_status_history,
// which is only ever set when the change came from a specific
// organization -- an Apex-level change leaves it null). Admin-originated
// activity is already covered by materials.updated_at, no extra query
// needed for that half of the dashboard.
async function handlePartnerRecentActivity(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const limit = Math.min(parseInt((url.searchParams.get("limit") || "20"), 10) || 20, 50);

  let messages = [], statusChanges = [];
  try {
    messages = await supabaseRest(env, "messages?author_type=eq.partner&select=id,material_id,org_id,author_name,body,created_at,materials(smid),organizations(name)&order=created_at.desc&limit=" + limit);
  } catch (e) { /* best-effort */ }
  try {
    // org_id is not null covers both a real partner action and an admin
    // override on that org's behalf (see /materials/statuses/update) --
    // exclude AUDIT_ACTOR_NAME so this feed is only what a partner
    // genuinely actioned themselves, not something admin set for them.
    statusChanges = await supabaseRest(env, "material_status_history?org_id=not.is.null&changed_by=neq." + encodeURIComponent(AUDIT_ACTOR_NAME) + "&select=id,material_id,org_id,from_status,to_status,changed_by,changed_at,materials(smid),organizations(name)&order=changed_at.desc&limit=" + limit);
  } catch (e) { /* best-effort */ }

  return json({ ok: true, messages: messages || [], statusChanges: statusChanges || [] }, 200, cors);
}

// ---------- Video Submission Builder (standalone, admin-only) ----------
// A video_submissions row is NOT a materials row -- this tool is its own
// workspace, not a field gated on a material's medium. Admin starts a
// submission, uploads a video, marks scenes by scrubbing through it, and
// for each scene gets: a real captured frame (screenshot), an AI-drafted
// on-screen-text transcription (Claude vision reads the screenshot), and an
// AI-drafted voiceover transcript (Cloudflare Workers AI Whisper reads that
// scene's audio clip, recorded client-side via captureStream()+
// MediaRecorder since there's no server-side video decoding available in a
// Worker). Both AI drafts are meant to be reviewed/edited by admin before
// export. video_submissions.material_id is null until admin explicitly
// chooses "Create Marketing Material" -- and even then only the material's
// metadata (smid, plan year, etc) is created; the video file and scene
// screenshots stay in the video R2 bucket forever and are never copied
// into the partner-readable materials bucket. Never visible to a partner,
// own bucket + own tables, same pattern as every other admin-only feature
// in this file.
//
// Lives in Cloudflare R2 (binding VIDEO_R2), not Supabase Storage like
// everything else in this file: real submission videos routinely exceed
// Supabase's 50MB-per-object limit (a hard cap on the Free plan, and only
// raisable per-bucket on paid plans), while R2 has no comparable small-file
// ceiling and no egress fees. R2 bindings have no built-in signed-URL
// helper the way Supabase Storage does, so playback/download goes through
// handleVideoStream below instead -- a thin authenticated proxy that reads
// the object out of R2 and streams it back.
async function r2Put(env, key, blob, contentType) {
  await env.VIDEO_R2.put(key, blob, { httpMetadata: { contentType: contentType || "application/octet-stream" } });
}
async function r2Delete(env, key) {
  if (!key) return;
  try { await env.VIDEO_R2.delete(key); } catch (e) { /* best-effort, matches supabaseStorageDelete callers */ }
}
// Query-string key (not just the x-apex-key header) because a <video src=...>
// or <img src=...> element makes its own browser-initiated GET with no way
// to attach a custom header -- same tradeoff APEX_STORAGE_KEY already makes
// by being embedded in client-side JS everywhere else in this app.
function r2StreamUrl(request, env, key) {
  const origin = new URL(request.url).origin;
  return origin + "/partner-admin/video/stream?path=" + encodeURIComponent(key) + "&key=" + encodeURIComponent(env.STORAGE_SHARED_KEY || "");
}

async function handleVideoStream(request, env, cors, url) {
  const providedKey = request.headers.get("x-apex-key") || url.searchParams.get("key") || "";
  if (!env.STORAGE_SHARED_KEY || providedKey !== env.STORAGE_SHARED_KEY) {
    return json({ ok: false, error: "Unauthorized." }, 401, cors);
  }
  const key = url.searchParams.get("path") || "";
  if (!key) return json({ ok: false, error: "path is required." }, 400, cors);

  let obj;
  try { obj = await env.VIDEO_R2.get(key); }
  catch (e) { return json({ ok: false, error: "Could not read the file.", detail: String(e.message || e) }, 502, cors); }
  if (!obj) return json({ ok: false, error: "Not found." }, 404, cors);

  const headers = new Headers(cors);
  headers.set("content-type", (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream");
  headers.set("content-length", String(obj.size));
  headers.set("cache-control", "private, max-age=0");
  return new Response(obj.body, { status: 200, headers: headers });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function handleVideoSubmissionsList(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  try {
    const rows = await supabaseRest(env, "video_submissions?select=*,video_submission_scenes(count)&order=updated_at.desc");
    const submissions = (rows || []).map(function (r) {
      const sceneCount = (r.video_submission_scenes && r.video_submission_scenes[0] && r.video_submission_scenes[0].count) || 0;
      delete r.video_submission_scenes;
      r.sceneCount = sceneCount;
      return r;
    });
    return json({ ok: true, submissions: submissions }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not load video submissions.", detail: String(e.message || e) }, 502, cors);
  }
}

async function handleVideoSubmissionCreate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const title = (body.title || "").trim();
  if (!title) return json({ ok: false, error: "title is required." }, 400, cors);

  let created;
  try {
    created = await supabaseRest(env, "video_submissions", { method: "POST", body: { title: title } });
  } catch (e) {
    return json({ ok: false, error: "Could not create the video submission.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, submission: created && created[0] }, 200, cors);
}

async function handleVideoSubmissionUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  const patch = pickDefined(body, ["title", "end_screen_disclaimer", "template", "smid", "previous_smid", "corresponding_urls"]);
  if (Object.keys(patch).length === 0) return json({ ok: false, error: "Nothing to update." }, 400, cors);

  try {
    await supabaseRest(env, "video_submissions?id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the video submission.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleVideoSubmissionDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const scenes = await supabaseRest(env, "video_submission_scenes?submission_id=eq." + encodeURIComponent(id) + "&select=screenshot_path").catch(function () { return []; });
    for (const s of (scenes || [])) { if (s.screenshot_path) await r2Delete(env, s.screenshot_path); }

    const subRows = await supabaseRest(env, "video_submissions?id=eq." + encodeURIComponent(id) + "&select=storage_path").catch(function () { return []; });
    if (subRows && subRows[0] && subRows[0].storage_path) await r2Delete(env, subRows[0].storage_path);
    await supabaseRest(env, "video_submissions?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
  } catch (e) {
    return json({ ok: false, error: "Could not delete the video submission.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

// Only fires when the admin explicitly finishes a submission and chooses to
// bring it into the shell. This creates a normal materials row -- the raw
// video and scene screenshots stay in the admin-only VIDEO_R2 bucket and are
// NEVER copied into STORAGE_BUCKET (the partner-readable materials bucket),
// so partners never gain access to the source video regardless of sharing.
async function handleVideoSubmissionCreateMaterial(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const submissionId = body.submissionId;
  const smid = (body.smid || "").trim();
  if (!submissionId) return json({ ok: false, error: "submissionId is required." }, 400, cors);
  if (!smid || !body.plan_year) return json({ ok: false, error: "smid and plan_year are required." }, 400, cors);

  const insertBody = pickDefined(body, MATERIAL_FIELDS);
  insertBody.smid = smid;
  if (!insertBody.medium) insertBody.medium = "Video";

  let materialRow;
  try {
    const created = await supabaseRest(env, "materials", { method: "POST", body: insertBody });
    materialRow = created && created[0];
    if (!materialRow) throw new Error("Material insert returned no row.");
    await supabaseRest(env, "video_submissions?id=eq." + encodeURIComponent(submissionId), { method: "PATCH", prefer: "return=minimal", body: { material_id: materialRow.id } });
  } catch (e) {
    return json({ ok: false, error: "Could not create the material.", detail: String(e.message || e) }, 502, cors);
  }
  await insertAudit(env, { kind: "item", action: "Material created from video submission", target: materialRow.smid, material_id: materialRow.id });
  return json({ ok: true, material: materialRow }, 200, cors);
}

async function handleVideoUpload(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const submissionId = form.get("submissionId");
  const durationSeconds = form.get("durationSeconds");
  const file = form.get("video");
  if (!submissionId || !file || typeof file === "string") {
    return json({ ok: false, error: "submissionId and video are required." }, 400, cors);
  }

  const safeName = String(file.name || "video").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = "submissions/" + submissionId + "/" + Date.now() + "-" + safeName;

  try {
    // Replacing a video starts a fresh scene list -- old screenshots would
    // no longer correspond to anything meaningful.
    const oldScenes = await supabaseRest(env, "video_submission_scenes?submission_id=eq." + encodeURIComponent(submissionId) + "&select=screenshot_path").catch(function () { return []; });
    for (const s of (oldScenes || [])) { if (s.screenshot_path) await r2Delete(env, s.screenshot_path); }
    await supabaseRest(env, "video_submission_scenes?submission_id=eq." + encodeURIComponent(submissionId), { method: "DELETE", prefer: "return=minimal" });

    const oldSub = await supabaseRest(env, "video_submissions?id=eq." + encodeURIComponent(submissionId) + "&select=storage_path").catch(function () { return []; });
    if (oldSub && oldSub[0] && oldSub[0].storage_path) await r2Delete(env, oldSub[0].storage_path);

    await r2Put(env, path, file, file.type);
    await supabaseRest(env, "video_submissions?id=eq." + encodeURIComponent(submissionId), {
      method: "PATCH",
      prefer: "return=minimal",
      body: { video_file_name: file.name || safeName, storage_path: path, duration_seconds: durationSeconds ? Number(durationSeconds) : null }
    });
  } catch (e) {
    return json({ ok: false, error: "Could not upload the video.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleVideoGet(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const submissionId = url.searchParams.get("submissionId");
  if (!submissionId) return json({ ok: false, error: "submissionId is required." }, 400, cors);

  try {
    const subRows = await supabaseRest(env, "video_submissions?id=eq." + encodeURIComponent(submissionId) + "&select=*");
    const scenes = await supabaseRest(env, "video_submission_scenes?submission_id=eq." + encodeURIComponent(submissionId) + "&select=*&order=scene_order");
    const submission = (subRows && subRows[0]) || null;
    let videoUrl = null;
    if (submission && submission.storage_path) {
      videoUrl = r2StreamUrl(request, env, submission.storage_path);
    }
    return json({ ok: true, submission: submission, videoUrl: videoUrl, scenes: scenes || [] }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not load the video submission.", detail: String(e.message || e) }, 502, cors);
  }
}

async function handleVideoDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const submissionId = body.submissionId;
  if (!submissionId) return json({ ok: false, error: "submissionId is required." }, 400, cors);

  try {
    const scenes = await supabaseRest(env, "video_submission_scenes?submission_id=eq." + encodeURIComponent(submissionId) + "&select=screenshot_path").catch(function () { return []; });
    for (const s of (scenes || [])) { if (s.screenshot_path) await r2Delete(env, s.screenshot_path); }
    await supabaseRest(env, "video_submission_scenes?submission_id=eq." + encodeURIComponent(submissionId), { method: "DELETE", prefer: "return=minimal" });

    const subRows = await supabaseRest(env, "video_submissions?id=eq." + encodeURIComponent(submissionId) + "&select=storage_path").catch(function () { return []; });
    if (subRows && subRows[0] && subRows[0].storage_path) await r2Delete(env, subRows[0].storage_path);
    await supabaseRest(env, "video_submissions?id=eq." + encodeURIComponent(submissionId), { method: "PATCH", prefer: "return=minimal", body: { video_file_name: null, storage_path: null, duration_seconds: null } });
  } catch (e) {
    return json({ ok: false, error: "Could not delete the video.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleVideoSceneCreate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }

  const submissionId = form.get("submissionId");
  const sceneOrder = parseInt(form.get("sceneOrder") || "0", 10);
  const startSeconds = Number(form.get("startSeconds") || 0);
  const endSeconds = Number(form.get("endSeconds") || 0);
  const screenshot = form.get("screenshot");
  if (!submissionId || !screenshot || typeof screenshot === "string") {
    return json({ ok: false, error: "submissionId and screenshot are required." }, 400, cors);
  }

  const path = "submissions/" + submissionId + "/scenes/" + Date.now() + "-scene.png";
  let sceneRow;
  try {
    await r2Put(env, path, screenshot, screenshot.type || "image/png");
    const inserted = await supabaseRest(env, "video_submission_scenes", {
      method: "POST",
      body: { submission_id: submissionId, scene_order: sceneOrder, start_seconds: startSeconds, end_seconds: endSeconds, screenshot_path: path }
    });
    sceneRow = inserted && inserted[0];
  } catch (e) {
    return json({ ok: false, error: "Could not save the scene.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true, scene: sceneRow }, 200, cors);
}

async function handleVideoSceneUpdate(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  const patch = pickDefined(body, ["scene_order", "start_seconds", "end_seconds", "on_screen_language", "voiceover_script"]);
  if (Object.keys(patch).length === 0) return json({ ok: false, error: "Nothing to update." }, 400, cors);

  try {
    await supabaseRest(env, "video_submission_scenes?id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: patch });
  } catch (e) {
    return json({ ok: false, error: "Could not update the scene.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleVideoSceneDelete(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const id = body.id;
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "video_submission_scenes?id=eq." + encodeURIComponent(id) + "&select=screenshot_path");
    const path = rows && rows[0] && rows[0].screenshot_path;
    await supabaseRest(env, "video_submission_scenes?id=eq." + encodeURIComponent(id), { method: "DELETE", prefer: "return=minimal" });
    if (path) await r2Delete(env, path);
  } catch (e) {
    return json({ ok: false, error: "Could not delete the scene.", detail: String(e.message || e) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

async function handleVideoSceneScreenshotUrl(request, env, cors, url) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "id is required." }, 400, cors);

  try {
    const rows = await supabaseRest(env, "video_submission_scenes?id=eq." + encodeURIComponent(id) + "&select=screenshot_path");
    const path = rows && rows[0] && rows[0].screenshot_path;
    if (!path) return json({ ok: false, error: "No screenshot for that scene." }, 404, cors);
    const signedUrl = r2StreamUrl(request, env, path);
    return json({ ok: true, url: signedUrl }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not generate a download link.", detail: String(e.message || e) }, 502, cors);
  }
}

async function handleVideoOcrScreenshot(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  if (!env.ANTHROPIC_API_KEY) {
    return json({ ok: false, error: "Server is missing ANTHROPIC_API_KEY." }, 500, cors);
  }

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }
  const file = form.get("image");
  if (!file || typeof file === "string") return json({ ok: false, error: "image is required." }, 400, cors);

  const base64 = arrayBufferToBase64(await file.arrayBuffer());
  const mediaType = file.type || "image/png";

  let apiResp;
  try {
    apiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: env.MODEL || "claude-sonnet-5",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: "This is a single frame from a Medicare marketing video, captured for a carrier compliance submission. Transcribe EXACTLY the on-screen text visible in this frame -- banners, subtitles, disclaimers, any overlaid text -- preserving line breaks between distinct text elements. Do not describe the image or add commentary. If there is no readable on-screen text, respond with exactly: (no on-screen text)" }
          ]
        }]
      })
    });
  } catch (e) {
    return json({ ok: false, error: "Could not reach the AI service.", detail: String(e) }, 502, cors);
  }
  if (!apiResp.ok) {
    const detail = await apiResp.text();
    return json({ ok: false, error: "AI request failed (" + apiResp.status + ").", detail: detail.slice(0, 600) }, 502, cors);
  }
  const data = await apiResp.json();
  const blocks = (data && Array.isArray(data.content)) ? data.content : [];
  const text = blocks.filter(function (b) { return b && b.type === "text"; }).map(function (b) { return b.text; }).join("\n").trim();
  return json({ ok: true, text: text }, 200, cors);
}

async function handleVideoTranscribeAudio(request, env, cors) {
  const authErr = partnerAdminAuthCheck(request, env, cors);
  if (authErr) return authErr;
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  if (!env.AI) {
    return json({ ok: false, error: "Server is missing the Workers AI binding. Add it under the Worker's Settings > Bindings > Workers AI." }, 500, cors);
  }

  let form;
  try { form = await request.formData(); }
  catch { return json({ ok: false, error: "Expected multipart/form-data." }, 400, cors); }
  const file = form.get("audio");
  if (!file || typeof file === "string") return json({ ok: false, error: "audio is required." }, 400, cors);

  try {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    const result = await env.AI.run("@cf/openai/whisper", { audio: bytes });
    return json({ ok: true, text: (result && result.text) || "" }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: "Could not transcribe the audio.", detail: String(e.message || e) }, 502, cors);
  }
}

// ---------- 1:1 Comparison: AI compliance summary (POST /compare-summary) ----------
const COMPARE_SUMMARY_SYSTEM_PROMPT = [
  "You are a senior Medicare marketing compliance reviewer at a multi-carrier TPMO, judging how two versions of the same marketing piece (or a document vs. a live page) differ.",
  "You are given a JSON payload describing an ALREADY-COMPUTED comparison: overall similarity, whether the SMID fields match, whether each document has reviewer comments or tracked changes (informational only -- never compare or quote comment/tracked-change content), and a 'changes' array -- the actual content differences, each with the section of the document it falls in, the baseline wording, and the other document/page's wording. A count of purely spacing/punctuation-only differences is also given -- these are NOT in the changes array and must never be treated as a reason the documents don't match.",
  "Do not invent, re-derive, merge, or skip the differences you're given -- judge exactly what's in the 'changes' array, one verdict per change, in the same order, same count.",
  "",
  "For EACH change, decide two things using general CMS/Medicare Communications and Marketing Guidelines (MCMG) knowledge:",
  "1. relevant: true if this difference actually changes something a compliance reviewer would care about -- a disclaimer/disclosure added, removed, or materially altered; named benefits, cost-sharing, premiums, or eligibility conditions; Star Ratings or other substantiated claims; contact/phone requirements; anything that changes what a beneficiary is told. relevant: false if it's the same substance in different words -- a synonym swap, softened phrasing, singular/plural, a typo fix, reordering -- that doesn't change what's being disclosed or offered.",
  "2. severity: 'high' for a missing/incorrect required disclosure or a substantive factual change, 'medium' for something a reviewer should confirm but isn't clearly a violation on its own, 'low' for anything not relevant (stylistic) or a very minor relevant tweak.",
  "",
  "Respond with ONLY this exact JSON shape -- no markdown code fences, no prose before or after it:",
  "{\"match\": boolean, \"headline\": \"one factual sentence: verdict, similarity, and SMID match status if both were found\", \"note\": \"one more sentence of context if genuinely useful (comments/tracked-changes count, a precedent pattern) -- empty string if nothing to add\", \"items\": [{\"element\": \"short label for what this is, e.g. 'SSBCI disclaimer' or 'Hero headline wording'\", \"relevant\": boolean, \"severity\": \"high\"|\"medium\"|\"low\", \"reason\": \"under 15 words, factual\"}]}",
  "The items array must have EXACTLY one entry per entry in the input 'changes' array, in the same order -- this is used to programmatically pair each verdict back to its change, so a wrong count or order breaks the tool.",
  "If the documents are a 1:1 match (empty changes array), return match: true, an empty items array, and a one-line headline saying so.",
  "Be terse in 'reason' and 'element' -- these render in a compact table, not a narrative."
].join("\n");

async function handleCompareSummary(request, env, cors) {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);

  if (!env.STORAGE_SHARED_KEY) {
    return json({ ok: false, error: "Server is missing STORAGE_SHARED_KEY. Add it as a Worker Secret." }, 500, cors);
  }
  const provided = request.headers.get("x-apex-key") || "";
  if (provided !== env.STORAGE_SHARED_KEY) {
    return json({ ok: false, error: "Unauthorized." }, 401, cors);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return json({ ok: false, error: "Server is missing ANTHROPIC_API_KEY. Add it in the Worker's Settings > Variables and Secrets." }, 500, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }

  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "Missing comparison payload." }, 400, cors);
  }
  // Bounded regardless of how large a document's change list gets.
  const payload = JSON.stringify(body).slice(0, 20000);

  let apiResp;
  try {
    apiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: env.MODEL || "claude-sonnet-5",
        max_tokens: 3000,
        system: COMPARE_SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "Comparison payload:\n" + payload }]
      })
    });
  } catch (e) {
    return json({ ok: false, error: "Could not reach the AI service.", detail: String(e) }, 502, cors);
  }

  if (!apiResp.ok) {
    const detail = await apiResp.text();
    return json({ ok: false, error: "AI request failed (" + apiResp.status + ").", detail: detail.slice(0, 600) }, 502, cors);
  }

  const data = await apiResp.json();
  const blocks = (data && Array.isArray(data.content)) ? data.content : [];
  const text = blocks
    .filter(function (b) { return b && b.type === "text" && typeof b.text === "string"; })
    .map(function (b) { return b.text; })
    .join("\n")
    .trim();

  if (!text) return json({ ok: false, error: "The AI returned an empty response." }, 502, cors);

  // Strip a stray ```json fence if the model adds one despite the instruction not to.
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) { return json({ ok: false, error: "The AI's response wasn't valid JSON.", detail: cleaned.slice(0, 600) }, 502, cors); }

  const expectedCount = Array.isArray(body.changes) ? body.changes.length : null;
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  if (expectedCount !== null && items.length !== expectedCount) {
    return json({ ok: false, error: "AI returned " + items.length + " verdicts for " + expectedCount + " changes — counts must match." }, 502, cors);
  }

  return json({ ok: true, match: !!parsed.match, headline: String(parsed.headline || ""), note: String(parsed.note || ""), items: items }, 200, cors);
}

// ---------- 1:1 Comparison: fetch a live URL as plain text (POST /fetch-url) ----------
// Backs the "URL / doc vs document" mode's URL side -- the browser can't
// fetch an arbitrary third-party page itself (CORS), so this proxies it
// server-side and strips markup down to plain text for the same diffing
// path a second uploaded document goes through.
function htmlToPlainText(html) {
  var text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|li|tr|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  var entities = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&rsquo;": "’", "&lsquo;": "‘", "&mdash;": "—", "&ndash;": "–" };
  text = text.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&rsquo;|&lsquo;|&mdash;|&ndash;/g, function (m) { return entities[m]; });
  text = text.replace(/&#(\d+);/g, function (_, code) { return String.fromCharCode(parseInt(code, 10)); });
  return text.split("\n").map(function (line) { return line.replace(/[ \t]+/g, " ").trim(); }).filter(function (line) { return line.length > 0; }).join("\n");
}

async function handleFetchUrl(request, env, cors) {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405, cors);
  if (!env.STORAGE_SHARED_KEY) {
    return json({ ok: false, error: "Server is missing STORAGE_SHARED_KEY. Add it as a Worker Secret." }, 500, cors);
  }
  const provided = request.headers.get("x-apex-key") || "";
  if (provided !== env.STORAGE_SHARED_KEY) {
    return json({ ok: false, error: "Unauthorized." }, 401, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: "Invalid JSON body." }, 400, cors); }
  const targetUrl = (body.url || "").trim();
  if (!targetUrl) return json({ ok: false, error: "url is required." }, 400, cors);

  let parsed;
  try { parsed = new URL(targetUrl); } catch { return json({ ok: false, error: "That doesn't look like a valid URL." }, 400, cors); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return json({ ok: false, error: "Only http/https URLs are supported." }, 400, cors);
  }

  let resp;
  try {
    resp = await fetch(parsed.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MyHealthAngelComplianceTool/1.0)" },
      redirect: "follow"
    });
  } catch (e) {
    return json({ ok: false, error: "Could not reach that URL.", detail: String(e.message || e) }, 502, cors);
  }
  if (!resp.ok) {
    return json({ ok: false, error: "That URL returned an error (HTTP " + resp.status + ")." }, 502, cors);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (contentType && contentType.indexOf("text/html") === -1 && contentType.indexOf("text/plain") === -1 && contentType.indexOf("application/xhtml") === -1) {
    return json({ ok: false, error: "That URL is not a web page (content-type: " + contentType + ")." }, 400, cors);
  }

  const html = await resp.text();
  const text = htmlToPlainText(html).slice(0, 150000);
  if (!text) return json({ ok: false, error: "Could not extract any readable text from that page." }, 502, cors);
  return json({ ok: true, text: text, finalUrl: resp.url || parsed.toString() }, 200, cors);
}
