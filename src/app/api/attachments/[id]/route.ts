/**
 * GET    /api/attachments/[id] — stream one receipt (decrypted in memory).
 * DELETE /api/attachments/[id] — detach a receipt (row + file).
 *
 * Owner-scoped: the row's user_id must equal the caller, and a mismatch is a
 * 404 rather than a 403 so ids can't be probed.
 *
 * The bytes are AES-256-GCM encrypted at rest under the owner's DEK, so this
 * route needs a live DEK (423 `session_locked` otherwise). PDFs and images are
 * served INLINE (a receipt is meant to be looked at); everything else is forced
 * to a download. `nosniff` everywhere so a stored file can never be sniffed
 * into executable markup in our origin.
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptField } from "@/lib/crypto/envelope";
import { decryptFileBytes } from "@/lib/crypto/file-envelope";
import { isReceiptInlineMime } from "@/lib/receipts/attachment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id." }, { status: 400 });

  const [row] = await db
    .select({
      storagePath: schema.transactionAttachments.storagePath,
      filenameEnc: schema.transactionAttachments.filenameEnc,
      mimeType: schema.transactionAttachments.mimeType,
    })
    .from(schema.transactionAttachments)
    .where(
      and(
        eq(schema.transactionAttachments.id, id),
        eq(schema.transactionAttachments.userId, userId),
      ),
    );
  if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let wrapped: Buffer;
  try {
    wrapped = await fs.readFile(row.storagePath);
  } catch {
    return NextResponse.json({ error: "Receipt file missing." }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = decryptFileBytes(dek, wrapped);
  } catch {
    // A DEK that opens the session but not this blob means the row outlived a
    // key rotation. Fail loudly rather than serve ciphertext as a "receipt".
    return NextResponse.json(
      { error: "Receipt could not be decrypted with the current session key." },
      { status: 409 },
    );
  }

  const cleanName = (decryptField(dek, row.filenameEnc) ?? "receipt")
    .replace(/[\r\n"\\]/g, "")
    .slice(0, 200);
  const inline = isReceiptInlineMime(row.mimeType);
  const contentType = inline ? row.mimeType : "application/octet-stream";

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${cleanName}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Detaching needs no DEK — id + ownership only.
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId } = auth;

  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id." }, { status: 400 });

  const [row] = await db
    .select({ storagePath: schema.transactionAttachments.storagePath })
    .from(schema.transactionAttachments)
    .where(
      and(
        eq(schema.transactionAttachments.id, id),
        eq(schema.transactionAttachments.userId, userId),
      ),
    );
  if (!row) return NextResponse.json({ error: "Not found." }, { status: 404 });

  await db
    .delete(schema.transactionAttachments)
    .where(
      and(
        eq(schema.transactionAttachments.id, id),
        eq(schema.transactionAttachments.userId, userId),
      ),
    );

  try {
    await fs.unlink(row.storagePath);
  } catch {
    /* already gone — the row is what matters */
  }

  return NextResponse.json({ success: true, deletedId: id });
}
