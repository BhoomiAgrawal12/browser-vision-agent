import { describe, expect, it, vi } from "vitest";
import type { RawRegion } from "@kavach/core/policy";
import type { PerceiveResponse } from "../shared/messages.js";
import { uploadReviewedFile, type UploadEvent } from "./upload-reviewed.js";

const field: RawRegion = { id: "e1", role: "button", label: "Photo", box: [0, 0, 120, 30], source: "dom", confidence: 1, explained: true, evidence: ["structural:input_type=file"], state: { required: true, filled: false }, control: { kind: "text", inputType: "file", triggerLabel: "Add file", fileInputAvailable: true } };
const snapshot = (id: number, regions = [field]): PerceiveResponse => ({ ok: true, snapshotId: id, regions, meta: { pageKind: "form", originClass: "other", tls: true, lang: "en", viewport: { w: 800, h: 600, dpr: 1 } } });
const file = { name: "sanitized-image.png", mimeType: "image/png", data_b64: "AA==", sha256: "approved-hash" };

describe("post-review upload", () => {
  it("uses a fresh target and locally retries a stale snapshot without a planner", async () => {
    const moved = { ...field, id: "e7", box: [200, 100, 120, 30] as RawRegion["box"] };
    const perceive = vi.fn().mockResolvedValueOnce(snapshot(41, [moved])).mockResolvedValueOnce(snapshot(43, [moved])).mockResolvedValueOnce(snapshot(44, [{ ...moved, state: { filled: true } }]));
    const attach = vi.fn().mockResolvedValueOnce({ ok: false, error: "stale_snapshot" }).mockResolvedValueOnce({ ok: true, fileDispatched: true, fileSha256: file.sha256 });
    const events: UploadEvent[] = [];
    expect(await uploadReviewedFile({ io: { perceive, attach }, target: field, regions: [field], file, stopped: () => false, event: (event) => events.push(event) })).toMatchObject({ ok: true });
    expect(attach.mock.calls.map(([request]) => [request.snapshotId, request.targetId, request.grounding.box])).toEqual([[41, "e7", moved.box], [43, "e7", moved.box]]);
    expect(events.some((event) => event.stage === "retry")).toBe(true);
  });

  it("waits for a replacement uploaded-file chip and never replays dispatched bytes", async () => {
    const chip = { ...field, id: "e9", role: "listitem" as const, state: { filled: true }, control: { ...field.control!, fileInputAvailable: false } };
    const perceive = vi.fn().mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(2, [])).mockResolvedValueOnce(snapshot(3, [chip]));
    const attach = vi.fn().mockResolvedValue({ ok: true, fileDispatched: true, fileSha256: file.sha256 });
    expect(await uploadReviewedFile({ io: { perceive, attach }, target: field, regions: [field], file, stopped: () => false, event: () => {} })).toMatchObject({ ok: true, field: chip });
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("does not replay when an attachment response is lost", async () => {
    const attach = vi.fn().mockRejectedValue(new Error("message channel closed"));
    expect(await uploadReviewedFile({ io: { perceive: async () => snapshot(1), attach }, target: field, regions: [field], file, stopped: () => false, event: () => {} })).toMatchObject({ ok: false, reason: "attachment_response_lost" });
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("refuses ambiguous replacement questions and cancellation before dispatch", async () => {
    const attach = vi.fn();
    const result = await uploadReviewedFile({ io: { perceive: async () => snapshot(2, [{ ...field, id: "e8" }, { ...field, id: "e9" }]), attach }, target: field, regions: [field], file, stopped: () => false, event: () => {} });
    expect(result).toMatchObject({ ok: false, reason: "reviewed_question_missing_or_ambiguous" });
    expect(attach).not.toHaveBeenCalled();
    let stopped = false;
    await uploadReviewedFile({ io: { perceive: async () => { stopped = true; return snapshot(2); }, attach }, target: field, regions: [field], file, stopped: () => stopped, event: () => {} });
    expect(attach).not.toHaveBeenCalled();
  });
});
