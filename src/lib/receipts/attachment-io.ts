/**
 * Receipt-file housekeeping.
 *
 * THE GAP THIS CLOSES: `transaction_attachments.transaction_id` cascades on
 * delete, so removing a transaction removes its rows — but a cascade is a
 * DATABASE action and cannot unlink the encrypted blobs those rows pointed at.
 * Without this, deleting a transaction leaves an unreadable UUID file behind
 * forever (the filename column is gone with the row).
 *
 * Callers collect the paths BEFORE the delete and unlink AFTER it commits, so a
 * failed/rolled-back delete never destroys a receipt whose row still exists.
 */

import fs from "fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";

/** Storage paths of every receipt attached to the given transactions. */
export async function receiptPathsForTransactions(
  userId: string,
  transactionIds: number[],
): Promise<string[]> {
  if (transactionIds.length === 0) return [];
  const rows = await db
    .select({ storagePath: schema.transactionAttachments.storagePath })
    .from(schema.transactionAttachments)
    .where(
      and(
        eq(schema.transactionAttachments.userId, userId),
        inArray(schema.transactionAttachments.transactionId, transactionIds),
      ),
    );
  return rows.map((r) => r.storagePath);
}

/** Every receipt path this user owns (used by the account wipe). */
export async function receiptPathsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ storagePath: schema.transactionAttachments.storagePath })
    .from(schema.transactionAttachments)
    .where(eq(schema.transactionAttachments.userId, userId));
  return rows.map((r) => r.storagePath);
}

/** Best-effort unlink — a missing file is not an error worth failing a delete for. */
export async function unlinkReceiptFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      await fs.unlink(p);
    } catch {
      /* already gone */
    }
  }
}
