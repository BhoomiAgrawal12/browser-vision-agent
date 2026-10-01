import type { RawRegion } from "@kavach/core/policy";
import type { AttachFileRequest, ExecuteResponse, PerceiveResponse } from "../shared/messages.js";
import { normalizePromptLabel, promptMemoryKeys } from "./prompt-memory.js";

export interface UploadEvent {
  stage: "refresh" | "retry" | "dispatch" | "verify" | "confirmed" | "failed";
  attempt: number;
  snapshot_id?: number;
  target_id?: string;
  native_input?: boolean;
  reason?: string;
}

export interface UploadIO {
  perceive(): Promise<PerceiveResponse>;
  attach(request: AttachFileRequest): Promise<ExecuteResponse>;
}

/** Match the reviewed question locally, never the snapshot captured before review. */
export async function uploadReviewedFile(options: {
  io: UploadIO;
  target: RawRegion;
  regions: RawRegion[];
  file: AttachFileRequest["file"];
  uploadId?: string;
  stopped(): boolean;
  event(event: UploadEvent): void;
}): Promise<{ ok: boolean; field?: RawRegion; reason?: string }> {
  const label = normalizePromptLabel(options.target.label);
  const key = promptMemoryKeys({ elements: options.regions }, options.target)[1];
  const find = (snapshot: PerceiveResponse): RawRegion | undefined => {
    const fields = snapshot.regions.filter((field) => field.control?.inputType === "file");
    const exact = fields.find((field) => field.id === options.target.id && normalizePromptLabel(field.label) === label);
    if (exact) return exact;
    // A unique named question can move or be replaced. Ambiguous/unlabelled
    // replacements cannot safely inherit approval based only on an ordinal.
    const matches = fields.filter((field) => normalizePromptLabel(field.label) === label);
    return label && matches.length === 1 && promptMemoryKeys({ elements: snapshot.regions }, matches[0]!)[1] === key ? matches[0] : undefined;
  };
  const fail = (attempt: number, reason: string) => {
    options.event({ stage: "failed", attempt, reason });
    return { ok: false, reason };
  };
  const perceive = async (): Promise<PerceiveResponse | null> => {
    try { return await options.io.perceive(); } catch { return null; }
  };

  for (let attempt = 1; attempt <= 4; attempt++) {
    if (options.stopped()) return { ok: false, reason: "cancelled" };
    const snapshot = await perceive();
    if (options.stopped()) return { ok: false, reason: "cancelled" };
    if (!snapshot?.ok || snapshot.meta.truncated) return fail(attempt, "page_snapshot_unavailable");
    const field = find(snapshot);
    if (!field) return fail(attempt, "reviewed_question_missing_or_ambiguous");
    if (field.state?.disabled || field.state?.readonly) return fail(attempt, "upload_field_unavailable");
    options.event({ stage: "refresh", attempt, snapshot_id: snapshot.snapshotId, target_id: field.id, native_input: field.control?.fileInputAvailable === true });
    let result: ExecuteResponse;
    try { result = await options.io.attach({
      type: "attach-file", snapshotId: snapshot.snapshotId, targetId: field.id,
      ...(options.uploadId ? { uploadId: options.uploadId } : {}),
      grounding: {
        id: field.id, role: field.role, label: field.control?.triggerLabel ?? field.label, box: field.box,
        ...(field.state?.disabled !== undefined ? { disabled: field.state.disabled } : {}),
        ...(field.state?.readonly !== undefined ? { readonly: field.state.readonly } : {}),
      },
      file: options.file,
    }); } catch { return fail(attempt, "attachment_response_lost"); }
    if (options.stopped()) return { ok: false, reason: "cancelled" };
    if (!result.ok) {
      const stale = result.error === "stale_snapshot" || result.error === "regrounding_failed";
      if (stale && !result.fileDispatched && attempt < 4) {
        options.event({ stage: "retry", attempt, reason: result.error! });
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      const knownErrors = new Set(["stale_snapshot", "regrounding_failed", "not_found", "failed", "validation_failed"]);
      if (result.uploadReason && ["file_type_not_accepted", "file_size_limit", "different_existing_file"].includes(result.uploadReason)) return fail(attempt, result.uploadReason);
      return fail(attempt, result.error === "unsupported" ? "upload_picker_inaccessible"
        : knownErrors.has(result.error ?? "") ? result.error! : "attachment_failed");
    }
    if (options.file.sha256 && result.fileSha256 !== options.file.sha256) return fail(attempt, "upload_hash_not_verified");
    if (result.pickerCompletion === "pending") return fail(attempt, "picker_insert_not_ready");
    if (result.pickerCompletion === "unavailable") return fail(attempt, "picker_insert_inaccessible");
    if (result.pickerCompletion === "cancelled") return { ok: false, reason: "cancelled" };
    options.event({ stage: "dispatch", attempt, target_id: field.id });
    // The website may remove its input and replace it with an uploaded-file
    // chip. Once dispatched, poll for acceptance without submitting the file again.
    for (let poll = 0; poll < 120; poll++) {
      if (options.stopped()) return { ok: false, reason: "cancelled" };
      const checked = await perceive();
      if (options.stopped()) return { ok: false, reason: "cancelled" };
      if (!checked?.ok || checked.meta.truncated) return fail(attempt, "page_snapshot_unavailable");
      const selected = find(checked);
      if (selected?.state?.invalid) return fail(attempt, "website_rejected_upload");
      if (selected?.state?.filled) {
        options.event({ stage: "confirmed", attempt, snapshot_id: checked.snapshotId, target_id: selected.id });
        return { ok: true, field: selected };
      }
      if (poll === 0) options.event({ stage: "verify", attempt, reason: "waiting_for_website" });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return fail(attempt, "website_did_not_confirm_upload");
  }
  return fail(4, "page_kept_changing");
}
