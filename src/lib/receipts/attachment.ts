/**
 * Receipt storage location — the ONLY server-side (node) part of the receipts
 * module. Everything pure lives in `policy.ts`, which client components import.
 *
 * Files are stored OUTSIDE the app bundle under the durable uploads root
 * (`<uploads>/receipts/<userId>/<uuid>.<ext>`), encrypted at rest with the
 * owner's DEK, so a redeploy never eats them and `ls` never reveals a merchant.
 */

import path from "path";
import { getUploadsBaseDir } from "@/lib/uploads-dir";

export * from "./policy";

/**
 * Resolve the on-disk path for a receipt.
 */
export function receiptStoragePath(
  userId: string,
  id: string,
  ext: string,
): { dir: string; file: string } {
  const dir = path.join(getUploadsBaseDir(), "receipts", userId);
  return { dir, file: path.join(dir, `${id}.${ext}`) };
}
