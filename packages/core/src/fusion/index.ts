import type { Box, ElementRole } from "../schema/scp.js";

/**
 * Fusion: match vision detections to DOM/accessibility nodes so that every
 * pixel region is either explained by structure or flagged unexplained.
 * The unexplained set is the risk set; the policy engine masks it.
 *
 * Coordinate discipline: everything is normalized into the working image
 * space before any comparison. DOM rects arrive in CSS pixels; the capture
 * is in device pixels; the working image is the capture downscaled by
 * `scale`. One conversion function, used everywhere, tested. This is the
 * bug class that eats a day when left implicit.
 */

export interface CoordinateSpace {
  /** Device pixel ratio: device px per CSS px. */
  dpr: number;
  /** Downscale factor applied to the capture to get the working image. */
  scale: number;
  /** Working image dimensions. */
  imageW: number;
  imageH: number;
}

/** Convert a CSS-pixel box into working-image space. */
export function cssToImage(box: Box, space: CoordinateSpace): Box {
  const f = space.dpr * space.scale;
  return [box[0] * f, box[1] * f, box[2] * f, box[3] * f];
}

/** Convert a device-pixel box (raw capture space) into working-image space. */
export function deviceToImage(box: Box, space: CoordinateSpace): Box {
  return [
    box[0] * space.scale,
    box[1] * space.scale,
    box[2] * space.scale,
    box[3] * space.scale,
  ];
}

export function iou(a: Box, b: Box): number {
  const ax2 = a[0] + a[2];
  const ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2];
  const by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

export function centroidDistance(a: Box, b: Box): number {
  const dx = a[0] + a[2] / 2 - (b[0] + b[2] / 2);
  const dy = a[1] + a[3] / 2 - (b[1] + b[3] / 2);
  return Math.hypot(dx, dy);
}

/** Clip a box to the image; null when fully outside. */
export function clipToImage(
  box: Box,
  space: CoordinateSpace,
): { box: Box; partial: boolean } | null {
  const x1 = Math.max(0, box[0]);
  const y1 = Math.max(0, box[1]);
  const x2 = Math.min(space.imageW, box[0] + box[2]);
  const y2 = Math.min(space.imageH, box[1] + box[3]);
  if (x2 <= x1 || y2 <= y1) return null;
  const clipped: Box = [x1, y1, x2 - x1, y2 - y1];
  const partial =
    clipped[2] * clipped[3] < box[2] * box[3] - 1e-6;
  return { box: clipped, partial };
}

/** Vision detector output kinds and the DOM roles each may explain. */
export type VisionKind = "control" | "text" | "media" | "icon";

const COMPATIBLE: Record<VisionKind, ReadonlySet<ElementRole>> = {
  control: new Set([
    "textbox", "password", "button", "link", "checkbox", "radio",
    "combobox", "listbox", "slider", "switch", "tab", "menuitem", "option",
  ]),
  text: new Set(["text", "label", "heading", "listitem", "link", "button", "alert"]),
  media: new Set(["image", "canvas", "video", "iframe", "document", "progressbar"]),
  icon: new Set(["button", "link", "image", "checkbox", "switch", "menuitem"]),
};

export interface DomRegion {
  id: string;
  role: ElementRole;
  /** CSS pixel box. */
  cssBox: Box;
  visible: boolean;
}

export interface VisionDetection {
  /** Working-image space box. */
  box: Box;
  kind: VisionKind;
  score: number;
}

export interface FusionMatch {
  domId: string;
  detectionIndex: number;
  iou: number;
  via: "iou" | "iou+centroid";
}

export interface FusionResult {
  matches: FusionMatch[];
  /** Vision detections no DOM node accounts for: the risk set. */
  unexplained: VisionDetection[];
  /** DOM regions no detector fired on: fine, structure stands alone. */
  structureOnly: string[];
  /** Fraction of image area covered by unexplained detections. */
  unexplainedAreaFraction: number;
  /** 1 minus the above: the report's headline accuracy-and-privacy metric. */
  explainedAreaFraction: number;
}

export interface FusionOptions {
  /** Accept outright at or above this IoU. */
  iouAccept?: number;
  /** Accept between this and iouAccept when centroids are near and roles fit. */
  iouConsider?: number;
  /** Centroid distance cap for the secondary acceptance, in image px. */
  centroidCap?: number;
}

const DEFAULTS: Required<FusionOptions> = {
  iouAccept: 0.5,
  iouConsider: 0.3,
  centroidCap: 24,
};

/** Area of the union of boxes, by coordinate-compressed grid sweep. */
export function unionArea(boxes: Box[]): number {
  if (boxes.length === 0) return 0;
  const xs = [...new Set(boxes.flatMap((b) => [b[0], b[0] + b[2]]))].sort((a, b) => a - b);
  const ys = [...new Set(boxes.flatMap((b) => [b[1], b[1] + b[3]]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const cx = (xs[i]! + xs[i + 1]!) / 2;
      const cy = (ys[j]! + ys[j + 1]!) / 2;
      const covered = boxes.some(
        (b) => cx >= b[0] && cx < b[0] + b[2] && cy >= b[1] && cy < b[1] + b[3],
      );
      if (covered) area += (xs[i + 1]! - xs[i]!) * (ys[j + 1]! - ys[j]!);
    }
  }
  return area;
}

export function fuse(
  domRegions: DomRegion[],
  detections: VisionDetection[],
  space: CoordinateSpace,
  options: FusionOptions = {},
): FusionResult {
  const opts = { ...DEFAULTS, ...options };

  // Normalize and clip DOM rects once.
  const candidates = domRegions
    .filter((d) => d.visible)
    .map((d) => {
      const clipped = clipToImage(cssToImage(d.cssBox, space), space);
      return clipped ? { id: d.id, role: d.role, box: clipped.box } : null;
    })
    .filter((d): d is { id: string; role: ElementRole; box: Box } => d !== null);

  const matches: FusionMatch[] = [];
  const unexplained: VisionDetection[] = [];
  const matchedDomIds = new Set<string>();

  for (const [index, det] of detections.entries()) {
    let best: { id: string; role: ElementRole; iou: number } | null = null;
    for (const c of candidates) {
      const overlap = iou(det.box, c.box);
      if (overlap > 0 && (best === null || overlap > best.iou)) {
        best = { id: c.id, role: c.role, iou: overlap };
      }
    }

    if (best && best.iou >= opts.iouAccept) {
      matches.push({ domId: best.id, detectionIndex: index, iou: best.iou, via: "iou" });
      matchedDomIds.add(best.id);
      continue;
    }
    if (
      best &&
      best.iou >= opts.iouConsider &&
      COMPATIBLE[det.kind].has(best.role)
    ) {
      const c = candidates.find((x) => x.id === best!.id)!;
      if (centroidDistance(det.box, c.box) <= opts.centroidCap) {
        matches.push({
          domId: best.id,
          detectionIndex: index,
          iou: best.iou,
          via: "iou+centroid",
        });
        matchedDomIds.add(best.id);
        continue;
      }
    }
    unexplained.push(det);
  }

  const structureOnly = candidates
    .filter((c) => !matchedDomIds.has(c.id))
    .map((c) => c.id);

  const imageArea = space.imageW * space.imageH;
  const unexplainedAreaFraction =
    imageArea > 0 ? unionArea(unexplained.map((u) => u.box)) / imageArea : 0;

  return {
    matches,
    unexplained,
    structureOnly,
    unexplainedAreaFraction,
    explainedAreaFraction: 1 - unexplainedAreaFraction,
  };
}
