import { defaultModelHost } from "@kavach/perception/models";
import manifest from "../../media-assets.json";

/** Exact npm-distributed bytes, pinned independently of package-lock integrity. */
export const MEDIA_ASSETS = manifest;

export function assetUrl(path: string): string {
  return typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : new URL(path, location.href).href;
}

export async function verifiedMediaAssets(): Promise<Uint8Array> {
  const host = defaultModelHost();
  let language: Uint8Array | undefined;
  for (const asset of MEDIA_ASSETS) {
    const bytes = await host.load({ name: asset.path, version: "1", url: assetUrl(asset.path), sha256: asset.sha256, bytes: asset.bytes, license: asset.license });
    if (asset.path.endsWith(".gz")) language = bytes;
  }
  if (!language) throw new Error("OCR language unavailable");
  return language;
}
