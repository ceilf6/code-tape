import JSZip from "jszip";
import type { RecordingPackageV1 } from "@/shared/recording-schema";

export async function buildRecordingZip(
  pkg: RecordingPackageV1,
  mediaBlob: Blob | null,
  thumbnailBlob?: Blob | null,
): Promise<Blob> {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(pkg.manifest, null, 2));
  zip.file("meta.json", JSON.stringify(pkg.meta, null, 2));
  zip.file("events.json", JSON.stringify(pkg.events));
  zip.file("snapshots.json", JSON.stringify(pkg.snapshots));
  if (pkg.indexes) zip.file("indexes.json", JSON.stringify(pkg.indexes));
  if (pkg.media) zip.file("media.json", JSON.stringify(pkg.media, null, 2));
  if (mediaBlob) {
    const mime = pkg.media?.mimeType ?? mediaBlob.type ?? "";
    zip.file(`media${extensionFor(mime)}`, await mediaBlob.arrayBuffer());
  }
  if (thumbnailBlob) {
    const mime = thumbnailBlob.type || "image/webp";
    zip.file(`thumbnail${extensionFor(mime)}`, await thumbnailBlob.arrayBuffer());
  }
  return zip.generateAsync({ type: "blob" });
}

function extensionFor(mimeType: string | undefined | null): string {
  if (!mimeType) return ".bin";
  if (mimeType.includes("webm")) return ".webm";
  if (mimeType.includes("mp4")) return ".mp4";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("webp")) return ".webp";
  if (mimeType.includes("png")) return ".png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return ".jpg";
  return ".bin";
}
