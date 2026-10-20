/**
 * Receipt policy — PURE, client-safe (no `path`, no `fs`).
 *
 * Split out of `attachment.ts` for one concrete reason: the transaction dialog's
 * Receipts panel is a CLIENT component and needs the same allowlist/`accept`
 * string the server enforces. Importing `attachment.ts` there would drag the
 * uploads-directory resolver (and `node:path`) into the browser bundle.
 *
 * Differences from `lib/feedback/attachment.ts`, deliberately:
 *  1. STRICT ALLOWLIST, not a denylist. A receipt is a PDF, an image, a CSV, a
 *     text file, or a forwarded .eml — nothing else.
 *  2. 10 MB, not 5 MB — a scanned multi-page invoice comfortably exceeds 5 MB.
 */

/** 10 MB — a scanned multi-page invoice, not a 5 MB chat screenshot. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/** Lowercase extensions a receipt may carry. */
export const RECEIPT_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "heic",
  "heif",
  "tif",
  "tiff",
  "bmp",
  "csv",
  "txt",
  "eml",
]);

/** MIME types a receipt may carry — checked alongside the extension. */
export const RECEIPT_ALLOWED_MIME: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/bmp",
  "text/csv",
  "text/plain",
  "message/rfc822",
  "application/octet-stream", // browsers send this for some .eml / .heic uploads
]);

/** Types safe to render inline (browser tab) rather than force a download. */
export function isReceiptInlineMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return mime === "application/pdf" || mime.startsWith("image/");
}

/** Client-side `<input accept>` hint, mirroring the server allowlist. */
export const RECEIPT_ACCEPT =
  ".pdf,.png,.jpg,.jpeg,.webp,.gif,.heic,.heif,.tif,.tiff,.bmp,.csv,.txt,.eml";

export type ReceiptValidationError =
  | { code: "bad_type"; message: string }
  | { code: "too_large"; message: string }
  | { code: "empty"; message: string };

/**
 * Derive a sanitized lowercase extension from an original filename. Last
 * `.`-segment, alphanumerics only. Returns "" (not "bin") so the caller can
 * distinguish "no extension" from "unexpected extension" and reject it.
 */
export function sanitizeReceiptExt(filename: string | null | undefined): string {
  if (!filename) return "";
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return base
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Pure validator. Returns `{ ext }` on success or a typed error the route maps
 * to a 4xx. This function IS the server-side gate; the client mirror is
 * convenience only.
 */
export function validateReceiptAttachment(input: {
  filename: string | null | undefined;
  mime: string | null | undefined;
  size: number;
}): { ext: string } | ReceiptValidationError {
  const ext = sanitizeReceiptExt(input.filename);
  const mime = (input.mime ?? "").toLowerCase();

  if (input.size <= 0) {
    return { code: "empty", message: "The file is empty." };
  }
  if (input.size > RECEIPT_MAX_BYTES) {
    return {
      code: "too_large",
      message: `File exceeds the ${Math.floor(RECEIPT_MAX_BYTES / (1024 * 1024))} MB limit.`,
    };
  }
  if (!ext || !RECEIPT_ALLOWED_EXTENSIONS.has(ext) || !RECEIPT_ALLOWED_MIME.has(mime)) {
    return {
      code: "bad_type",
      message:
        "Only PDFs, images (png/jpg/webp/gif/heic/tiff/bmp), CSV, TXT, and .eml receipts can be attached.",
    };
  }
  return { ext };
}
