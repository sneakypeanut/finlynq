/**
 * GET  /api/transactions/[id]/attachments — list a transaction's receipts.
 * POST /api/transactions/[id]/attachments — attach one receipt (multipart,
 *                                           field name `file`).
 *
 * Both are OWNER-scoped and DEK-gated: the original filename is encrypted with
 * the user's DEK, so a session without a live DEK (a restarted server, or a
 * legacy API key with no envelope wrap) gets 423 `session_locked` rather than
 * a half-readable list.
 *
 * Files are encrypted at rest with the same DEK (file-envelope) and stored
 * under the durable uploads root — NOT in the app bundle, so a redeploy does
 * not eat them.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs/promises";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { encryptField, decryptField } from "@/lib/crypto/envelope";
import { encryptFileBytes } from "@/lib/crypto/file-envelope";
import {
  receiptStoragePath,
  validateReceiptAttachment,
} from "@/lib/receipts/attachment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RowShape = {
  id: number;
  filenameEnc: string;
  mimeType: string;
  sizeBytes: number;
  source: string;
  createdAt: Date;
};

function shape(dek: Buffer, row: RowShape) {
  return {
    id: row.id,
    filename: decryptField(dek, row.filenameEnc) ?? "receipt",
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    source: row.source,
    createdAt: row.createdAt,
    url: `/api/attachments/${row.id}`,
  };
}

/** 404 (not 403) for a stranger's transaction — no id enumeration. */
async function assertOwnedTransaction(userId: string, transactionId: number) {
  const [tx] = await db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(
      and(eq(schema.transactions.id, transactionId), eq(schema.transactions.userId, userId)),
    );
  return !!tx;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const transactionId = Number((await params).id);
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }
  if (!(await assertOwnedTransaction(userId, transactionId))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const rows = await db
    .select({
      id: schema.transactionAttachments.id,
      filenameEnc: schema.transactionAttachments.filenameEnc,
      mimeType: schema.transactionAttachments.mimeType,
      sizeBytes: schema.transactionAttachments.sizeBytes,
      source: schema.transactionAttachments.source,
      createdAt: schema.transactionAttachments.createdAt,
    })
    .from(schema.transactionAttachments)
    .where(
      and(
        eq(schema.transactionAttachments.userId, userId),
        eq(schema.transactionAttachments.transactionId, transactionId),
      ),
    )
    .orderBy(desc(schema.transactionAttachments.createdAt));

  return NextResponse.json({ attachments: rows.map((r) => shape(dek, r)) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const transactionId = Number((await params).id);
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }
  if (!(await assertOwnedTransaction(userId, transactionId))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  const sourceRaw = String(form.get("source") ?? "upload");
  const source = sourceRaw === "email" ? "email" : "upload";
  const sourceRef = form.get("sourceRef") ? String(form.get("sourceRef")).slice(0, 200) : null;

  const check = validateReceiptAttachment({
    filename: file.name,
    mime: file.type,
    size: file.size,
  });
  if ("code" in check) {
    const status = check.code === "bad_type" ? 415 : check.code === "too_large" ? 413 : 400;
    return NextResponse.json({ error: check.message, code: check.code }, { status });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // Re-check the realized length — the size header can lie or stream short.
  if (bytes.length === 0) {
    return NextResponse.json({ error: "The file is empty.", code: "empty" }, { status: 400 });
  }
  if (bytes.length > 10 * 1024 * 1024) {
    return NextResponse.json(
      { error: "File exceeds the 10 MB limit.", code: "too_large" },
      { status: 413 },
    );
  }

  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

  // Dedupe: the same bytes already on this transaction is not an error, it is
  // the same receipt (a re-run of the sweep must be idempotent).
  const [existing] = await db
    .select({
      id: schema.transactionAttachments.id,
      filenameEnc: schema.transactionAttachments.filenameEnc,
      mimeType: schema.transactionAttachments.mimeType,
      sizeBytes: schema.transactionAttachments.sizeBytes,
      source: schema.transactionAttachments.source,
      createdAt: schema.transactionAttachments.createdAt,
    })
    .from(schema.transactionAttachments)
    .where(
      and(
        eq(schema.transactionAttachments.userId, userId),
        eq(schema.transactionAttachments.transactionId, transactionId),
        eq(schema.transactionAttachments.sha256, sha256),
      ),
    );
  if (existing) {
    return NextResponse.json({ attachment: shape(dek, existing), duplicate: true });
  }

  const id = crypto.randomUUID();
  const { dir, file: filePath } = receiptStoragePath(userId, id, check.ext);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, encryptFileBytes(dek, bytes));

  const originalName = (file.name || `receipt.${check.ext}`)
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .slice(0, 200);

  try {
    const [row] = await db
      .insert(schema.transactionAttachments)
      .values({
        userId,
        transactionId,
        storagePath: filePath,
        filenameEnc: encryptField(dek, originalName) as string,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: bytes.length,
        sha256,
        source,
        sourceRef,
      })
      .returning({
        id: schema.transactionAttachments.id,
        filenameEnc: schema.transactionAttachments.filenameEnc,
        mimeType: schema.transactionAttachments.mimeType,
        sizeBytes: schema.transactionAttachments.sizeBytes,
        source: schema.transactionAttachments.source,
        createdAt: schema.transactionAttachments.createdAt,
      });
    return NextResponse.json({ attachment: shape(dek, row) }, { status: 201 });
  } catch (error) {
    // Row insert failed — never leave the encrypted blob orphaned on disk.
    try {
      await fs.unlink(filePath);
    } catch {
      /* best effort */
    }
    throw error;
  }
}
