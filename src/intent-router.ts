import * as v1 from "./h1client.js";
import { reportAssistantV2, type V2Update } from "./h1v2.js";

export type IntentVersion = "auto" | "v1" | "v2";

/** Only fall back before selecting a backend. Never catch/replay a failed write. */
export function selectIntentVersion(version: IntentVersion = "auto"): "v1" | "v2" {
  if (version === "v1" || version === "v2") return version;
  const configured = [process.env.H1_V2_HUNTPROXY_PROJECT_ID, process.env.H1_V2_HUNTPROXY_EXCHANGE_ID, process.env.H1_V2_USERNAME];
  // Partial configuration is an error on the V2 path, not permission to use a different account.
  return configured.some(Boolean) ? "v2" : "v1";
}

function mark<T extends object>(result: T, version: "v1" | "v2", requested: IntentVersion = "auto") {
  return {
    ...result, backend: version,
    ...(version === "v1" && requested === "auto" ? {
      warning: "V2 is not configured; used the public V1 intent API. V1 cannot set manual severity/title/impact and may be blocked at submission. Configure H1_V2_* to prefer V2, or select version explicitly.",
    } : {}),
  };
}
function v1Fields(fields: V2Update) {
  if (Object.keys(fields).some((key) => key !== "description" && fields[key as keyof V2Update] !== undefined)) {
    throw new Error("V1 cannot save the requested title, impact, severity, scope, weakness or custom fields. No draft/write was sent. Configure V2; fields were not silently dropped.");
  }
}

export const intents = {
  async create(opts: { program_handle: string; description: string; wait?: boolean } & V2Update, version: IntentVersion = "auto") {
    const backend = selectIntentVersion(version);
    if (backend === "v1") {
      const { program_handle, wait, ...fields } = opts;
      v1Fields(fields);
      return mark(await v1.createReportIntent({ program_handle, description: opts.description, wait }), backend, version);
    }
    const client = reportAssistantV2();
    const created = await client.create(opts.program_handle);
    const { program_handle, wait, ...fields } = opts;
    try {
      const saved = await client.update(created.id, fields);
      return mark({ ...saved, timed_out: false, next_steps: {
        tool: "update_report_intent", arguments: { id: created.id, version: "v2" },
        guidance: "Upload attachments to this same intent, insert returned reference values into the full replacement description, then update this id. Never create a replacement draft after an uncertain write.",
      } }, backend, version);
    } catch {
      throw new Error(`V2 draft ${created.id} was created, but its initial content save was not confirmed. Inspect get_report_intent with version=v2. No V1 fallback, replacement draft, or submission was attempted.`);
    }
  },
  async list(version: IntentVersion = "auto") {
    const backend = selectIntentVersion(version);
    if (backend === "v2") return mark(await reportAssistantV2().list(), backend, version);
    return (await v1.listReportIntents()).map((r: any) => mark(r, backend, version));
  },
  async get(id: string, version: IntentVersion = "auto") {
    const backend = selectIntentVersion(version);
    return mark(backend === "v2" ? await reportAssistantV2().get(id) : await v1.getReportIntent(id), backend, version);
  },
  async update(id: string, fields: V2Update, timeoutMs?: number, version: IntentVersion = "auto") {
    const backend = selectIntentVersion(version);
    if (backend === "v2") return mark(await reportAssistantV2().update(id, fields), backend, version);
    v1Fields(fields);
    if (fields.description === undefined) throw new Error("V1 updates require a full replacement description.");
    return mark(await v1.updateReportIntent(id, fields.description, timeoutMs), backend, version);
  },
  async delete(id: string, version: IntentVersion = "auto") {
    const backend = selectIntentVersion(version);
    return mark(backend === "v2" ? await reportAssistantV2().delete(id) : await v1.deleteReportIntent(id), backend, version);
  },
  async wait(id: string, timeoutMs = 60_000, version: IntentVersion = "auto") {
    const backend = selectIntentVersion(version);
    if (backend === "v1") return mark(await v1.waitForIntentReady(id, timeoutMs), backend, version);
    const current = await reportAssistantV2().get(id);
    return mark({ ...current, ready_to_submit: current.state === "ready_to_submit", timed_out: false,
      note: "V2 pending can mean pre-submission checks have not run; it is not a V1-style processing signal. This call does not run checks or submit anything.",
    }, backend, version);
  },
  async attachments(id: string, version: IntentVersion = "auto") {
    return selectIntentVersion(version) === "v2" ? (await reportAssistantV2().get(id)).attachments : v1.listIntentAttachments(id);
  },
  async upload(id: string, paths: string[], version: IntentVersion = "auto") {
    return selectIntentVersion(version) === "v2" ? reportAssistantV2().upload(id, paths) : v1.uploadIntentAttachments(id, paths);
  },
  async removeAttachment(id: string, attachmentId: string, version: IntentVersion = "auto") {
    return selectIntentVersion(version) === "v2" ? reportAssistantV2().removeAttachment(id, attachmentId) : v1.deleteIntentAttachment(id, attachmentId);
  },
  async submit(id: string, confirm: boolean, expectedUpdatedAt?: string, version: IntentVersion = "auto") {
    // A reviewed timestamp pins this operation to V2 even if its config was removed since review.
    const backend = version === "auto" && expectedUpdatedAt ? "v2" : selectIntentVersion(version);
    if (backend === "v2") return mark(await reportAssistantV2().submit(id, confirm, expectedUpdatedAt ?? ""), backend, version);
    return mark(await v1.submitReportIntent(id, confirm), backend, version);
  },
};
