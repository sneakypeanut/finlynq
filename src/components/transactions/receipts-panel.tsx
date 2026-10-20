"use client";

/**
 * Receipts panel for the transaction editor.
 *
 * Lists / attaches / removes the receipts and invoices tied to ONE transaction.
 * The bytes are encrypted at rest under the owner's DEK, so this panel is only
 * meaningful for an EXISTING transaction (there is no id to attach to before
 * the first save) — the dialog renders it for `editId` only.
 *
 * A 423 means the session has no live DEK (server restarted since login, or a
 * legacy API key). We surface that as a plain instruction instead of a generic
 * failure, because "attach a receipt" cannot fall back to plaintext.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FileText, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import { RECEIPT_ACCEPT } from "@/lib/receipts/policy";

type Receipt = {
  id: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  source: string;
  createdAt: string;
  url: string;
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ReceiptsPanel({ transactionId }: { transactionId: number }) {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/transactions/${transactionId}/attachments`, {
        cache: "no-store",
      });
      if (res.status === 423) {
        setLocked(true);
        setReceipts([]);
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not load receipts.");
      setLocked(false);
      setReceipts(body.attachments ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load receipts.");
    } finally {
      setLoading(false);
    }
  }, [transactionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        form.append("source", "upload");
        const res = await fetch(`/api/transactions/${transactionId}/attachments`, {
          method: "POST",
          body: form,
        });
        if (res.status === 423) {
          setLocked(true);
          throw new Error("Your session needs to be unlocked — sign in again to attach receipts.");
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error ?? `Could not attach ${file.name}.`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(id: number) {
    if (!window.confirm("Detach this receipt? The file is deleted.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/attachments/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? "Could not remove receipt.");
      }
      setReceipts((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove receipt.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Paperclip className="h-3.5 w-3.5" />
          Receipts
          {receipts.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground">({receipts.length})</span>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={RECEIPT_ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => void upload(e.target.files)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={busy || locked}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Upload className="mr-1 h-3 w-3" />
          )}
          Attach
        </Button>
      </div>

      {locked && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Session locked — sign in again to view or attach receipts.
        </p>
      )}
      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}

      {!locked && loading && <p className="text-xs text-muted-foreground">Loading…</p>}

      {!locked && !loading && receipts.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No receipts attached yet. PDF, image, CSV, or .eml, up to 10 MB.
        </p>
      )}

      {!locked && receipts.length > 0 && (
        <ul className="space-y-1">
          {receipts.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-xs">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <a
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate flex-1 hover:underline"
                title={r.filename}
              >
                {r.filename}
              </a>
              <span className="shrink-0 text-muted-foreground">{humanSize(r.sizeBytes)}</span>
              {r.source === "email" && (
                <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
                  email
                </span>
              )}
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-50"
                disabled={busy}
                onClick={() => void remove(r.id)}
                aria-label={`Remove ${r.filename}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
