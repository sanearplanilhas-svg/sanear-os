import JSZip from "jszip";

export const ZIP_STORAGE_MIME = "application/zip";

export type CompactFileResult = {
  blob: Blob;
  zipFileName: string;
  originalFileName: string;
  originalMimeType: string;
  originalSize: number;
  zipSize: number;
  compressionRatio: number;
};

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
};

export function sanitizeZipFileName(name: string): string {
  const cleaned = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned || "arquivo";
}

export function inferMimeTypeByName(name: string, fallback = "application/octet-stream"): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? fallback;
}

export function buildZipName(originalName: string): string {
  const safeName = sanitizeZipFileName(originalName);
  return safeName.toLowerCase().endsWith(".zip") ? safeName : `${safeName}.zip`;
}

export function isZipReference(value?: string | null): boolean {
  if (!value) return false;
  const clean = value.split("?")[0].toLowerCase();
  return clean.endsWith(".zip") || clean.includes("/zip/") || clean.includes("%2ezip");
}

export async function compactBlobToZip(
  source: Blob,
  originalName: string,
  fallbackMime = "application/octet-stream"
): Promise<CompactFileResult> {
  const safeOriginalName = sanitizeZipFileName(originalName || "arquivo");
  const originalMimeType = source.type || inferMimeTypeByName(safeOriginalName, fallbackMime);

  const zip = new JSZip();
  zip.file(safeOriginalName, source, {
    date: new Date(),
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: ZIP_STORAGE_MIME,
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const originalSize = source.size;
  const zipSize = blob.size;
  const compressionRatio = originalSize > 0 ? zipSize / originalSize : 1;

  return {
    blob,
    zipFileName: buildZipName(safeOriginalName),
    originalFileName: safeOriginalName,
    originalMimeType,
    originalSize,
    zipSize,
    compressionRatio,
  };
}

export async function compactFileToZip(file: File): Promise<CompactFileResult> {
  return compactBlobToZip(file, file.name || "arquivo", file.type || "application/octet-stream");
}

export async function extractFirstFileFromZipBuffer(
  buffer: ArrayBuffer,
  fallbackMime = "application/octet-stream"
): Promise<{ blob: Blob; fileName: string; mimeType: string }> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = Object.values(zip.files).find((file) => !file.dir);

  if (!entry) {
    throw new Error("O ZIP não possui arquivo interno para abrir.");
  }

  const bytes = await entry.async("arraybuffer");
  const fileName = entry.name.split("/").pop() || "arquivo";
  const mimeType = inferMimeTypeByName(fileName, fallbackMime);
  return {
    blob: new Blob([bytes], { type: mimeType }),
    fileName,
    mimeType,
  };
}

export async function extractFirstFileObjectUrlFromZipUrl(
  url: string,
  fallbackMime = "application/octet-stream"
): Promise<{ url: string; fileName: string; mimeType: string }> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Não foi possível baixar o ZIP. HTTP ${response.status}`);
  }

  const extracted = await extractFirstFileFromZipBuffer(await response.arrayBuffer(), fallbackMime);
  return {
    url: URL.createObjectURL(extracted.blob),
    fileName: extracted.fileName,
    mimeType: extracted.mimeType,
  };
}
