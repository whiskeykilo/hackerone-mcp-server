import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

// Shared by the public REST and V2 web-session paths.
const BLOCKED_ATTACHMENT_PATTERNS = [
  /(^|\/)\.claude\.json$/, /(^|\/)\.claude\//, /(^|\/)\.ssh\//,
  /(^|\/)\.aws\//, /(^|\/)\.gnupg\//, /(^|\/)\.huntproxy\//,
  /(^|\/)\.netrc$/, /(^|\/)\.env(\.|$)/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, /(^|\/)(shadow|passwd)$/,
  /\.pem$/, /\.p12$/, /\.pfx$/, /(^|\/)credentials$/,
];
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export async function readAttachmentFiles(paths: string[]) {
  if (paths.length < 1 || paths.length > 16) throw new Error("Supply 1–16 attachment files.");
  const files: { name: string; bytes: Buffer; contentType: string }[] = [];
  let total = 0;
  for (const path of paths) {
    const requested = resolve(path);
    const actual = await realpath(requested);
    if ([requested, actual].some((p) => BLOCKED_ATTACHMENT_PATTERNS.some((re) => re.test(p)))) {
      throw new Error(`Refusing to upload '${requested}': it matches a credential/secret path pattern. Copy only the relevant non-secret proof to a new file.`);
    }
    const info = await stat(actual);
    if (!info.isFile()) throw new Error(`Refusing to upload '${requested}': not a regular file.`);
    if (info.size > MAX_ATTACHMENT_BYTES || total + info.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment upload exceeds the 25MB per-call cap. Split the files across calls.");
    }
    const bytes = await readFile(actual);
    total += bytes.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) throw new Error("Attachment upload exceeds the 25MB per-call cap.");
    const types: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
      ".webp": "image/webp", ".txt": "text/plain", ".md": "text/plain", ".pdf": "application/pdf",
      ".json": "application/json", ".zip": "application/zip", ".mp4": "video/mp4",
    };
    files.push({ name: basename(requested), bytes, contentType: types[extname(requested).toLowerCase()] ?? "application/octet-stream" });
  }
  return files;
}
