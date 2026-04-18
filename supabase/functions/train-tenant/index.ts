/**
 * SprintAI train-tenant Edge Function
 * Handles text paste and document upload for training the knowledge base.
 *
 * Actions:
 *   add_text     - Chunk + embed a pasted text block
 *   list_sources - Return all knowledge base entries grouped by source
 *   delete_source - Delete knowledge base entries by source + label
 *   (multipart)  - File upload: PDF, TXT, DOCX
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const OPENAI_API_URL  = "https://api.openai.com/v1";
const EMBEDDING_MODEL = "text-embedding-3-small";
const CHUNK_SIZE      = 500;   // approximate word count per chunk
const CHUNK_OVERLAP   = 50;
const BATCH_SIZE      = 20;    // embeddings per API call

// ─── CORS headers ────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface AddTextRequest {
  action:    "add_text";
  tenant_id: string;
  content:   string;
  label?:    string;
}

interface ListSourcesRequest {
  action:    "list_sources";
  tenant_id: string;
}

interface DeleteSourceRequest {
  action:    "delete_source";
  tenant_id: string;
  source:    string;
  label?:    string;
}

interface SourceGroup {
  source: string;
  label:  string;
  count:  number;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // Handle preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonError("Method Not Allowed", 405);
  }

  const contentType = req.headers.get("Content-Type") || "";
  const isMultipart  = contentType.includes("multipart/form-data");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  // ── File upload (multipart) ────────────────────────────────────────────────
  if (isMultipart) {
    return handleFileUpload(req, supabase);
  }

  // ── JSON actions ──────────────────────────────────────────────────────────
  let body: AddTextRequest | ListSourcesRequest | DeleteSourceRequest;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const { action } = body as { action: string };

  if (!action) return jsonError("Missing 'action' field");

  switch (action) {
    case "add_text":
      return handleAddText(body as AddTextRequest, supabase);
    case "list_sources":
      return handleListSources(body as ListSourcesRequest, supabase);
    case "delete_source":
      return handleDeleteSource(body as DeleteSourceRequest, supabase);
    default:
      return jsonError(`Unknown action: ${action}`);
  }
});

// ─── add_text ────────────────────────────────────────────────────────────────

async function handleAddText(
  body: AddTextRequest,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const { tenant_id, content, label = "Custom text" } = body;

  if (!tenant_id) return jsonError("tenant_id is required");
  if (!content)   return jsonError("content is required");

  const tenantOk = await verifyTenant(supabase, tenant_id);
  if (!tenantOk) return jsonError("Tenant not found", 404);

  const chunks = chunkText(content, CHUNK_SIZE, CHUNK_OVERLAP);
  console.log(`[train-tenant] add_text: ${chunks.length} chunks for tenant ${tenant_id}, source=custom_text, label="${label}"`);

  try {
    const stored = await embedAndStore(supabase, tenant_id, chunks, "custom_text", label);
    return jsonResponse({ ok: true, chunks_stored: stored, label });
  } catch (err) {
    console.error("[train-tenant] add_text error:", err);
    return jsonError("Failed to process text: " + (err instanceof Error ? err.message : String(err)), 500);
  }
}

// ─── File upload ─────────────────────────────────────────────────────────────

async function handleFileUpload(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return jsonError("Failed to parse form data");
  }

  const tenant_id = formData.get("tenant_id") as string;
  const file      = formData.get("file") as File | null;
  const label     = (formData.get("label") as string) || file?.name || "Document";

  if (!tenant_id) return jsonError("tenant_id is required");
  if (!file)      return jsonError("file is required");

  const tenantOk = await verifyTenant(supabase, tenant_id);
  if (!tenantOk) return jsonError("Tenant not found", 404);

  const fileName = file.name.toLowerCase();
  let text = "";

  try {
    if (fileName.endsWith(".txt")) {
      text = await file.text();

    } else if (fileName.endsWith(".pdf")) {
      text = await extractPdfText(file);

    } else if (fileName.endsWith(".docx")) {
      // extractDocxText does proper ZIP/deflate extraction — never stores raw binary
      text = await extractDocxText(file);

    } else if (fileName.endsWith(".doc")) {
      // Old binary .doc format — not easily extractable without a full parser.
      // Check for OLE2 magic bytes (D0 CF 11 E0) and reject with helpful message.
      const peek = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (peek[0] === 0xD0 && peek[1] === 0xCF && peek[2] === 0x11 && peek[3] === 0xE0) {
        return jsonError(
          "Old .doc files cannot be processed. Please save as .docx or .txt and upload again, or paste the text directly."
        );
      }
      // Might be a renamed text file — try reading as text
      const raw = await file.text();
      // Sanity: if >30% non-printable chars, it's binary — reject it
      const nonPrintable = (raw.match(/[^\x09\x0A\x0D\x20-\x7E]/g) || []).length;
      if (nonPrintable / raw.length > 0.3) {
        return jsonError(
          "This file appears to contain binary data and cannot be processed. Please upload a .txt or .docx file, or paste the text directly."
        );
      }
      text = raw.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s+/g, " ").trim();

    } else {
      return jsonError("Unsupported file type. Use PDF, TXT, DOC, or DOCX.");
    }
  } catch (err) {
    return jsonError("Failed to extract text from file: " + (err as Error).message);
  }

  if (!text.trim()) {
    return jsonError("No readable text found in the file.");
  }

  // Final safety check: reject if extracted text still looks like binary garbage
  // (This should never happen for .docx after extractDocxText, but belt-and-suspenders)
  const nonPrintableRatio = (text.match(/[^\x09\x0A\x0D\x20-\x7E]/g) || []).length / text.length;
  if (text.length > 50 && nonPrintableRatio > 0.2) {
    return jsonError(
      "Could not extract readable text from this file. Please upload a .txt file or paste the text directly."
    );
  }

  const chunks = chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);
  console.log(`[train-tenant] file upload: ${chunks.length} chunks from "${label}" for tenant ${tenant_id}`);

  try {
    const stored = await embedAndStore(supabase, tenant_id, chunks, "document", label);
    return jsonResponse({ ok: true, chunks_stored: stored, label, filename: file.name });
  } catch (err) {
    console.error("[train-tenant] file upload error:", err);
    return jsonError("Failed to process file: " + (err instanceof Error ? err.message : String(err)), 500);
  }
}

// ─── list_sources ────────────────────────────────────────────────────────────

async function handleListSources(
  body: ListSourcesRequest,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const { tenant_id } = body;
  if (!tenant_id) return jsonError("tenant_id is required");

  // Get all knowledge base entries for this tenant
  const { data, error } = await supabase
    .from("knowledge_base")
    .select("source, metadata")
    .eq("tenant_id", tenant_id);

  if (error) return jsonError("Failed to fetch sources: " + error.message);

  // Group by source + label
  const grouped: Record<string, SourceGroup> = {};

  for (const row of (data || [])) {
    const label  = (row.metadata?.label as string) || row.source;
    const key    = `${row.source}::${label}`;
    if (!grouped[key]) {
      grouped[key] = { source: row.source, label, count: 0 };
    }
    grouped[key].count++;
  }

  const sources = Object.values(grouped).sort((a, b) =>
    a.source.localeCompare(b.source) || a.label.localeCompare(b.label)
  );

  return jsonResponse({ sources });
}

// ─── delete_source ────────────────────────────────────────────────────────────

async function handleDeleteSource(
  body: DeleteSourceRequest,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const { tenant_id, source, label } = body;

  if (!tenant_id) return jsonError("tenant_id is required");
  if (!source && !label) return jsonError("source or label is required");

  let query = supabase
    .from("knowledge_base")
    .delete({ count: "exact" })
    .eq("tenant_id", tenant_id);

  if (label) {
    // Label-based delete: matches regardless of source column value
    query = query.filter("metadata->>label", "eq", label);
  } else {
    query = query.eq("source", source);
  }

  const { error, count } = await query;

  if (error) return jsonError("Failed to delete: " + error.message);

  return jsonResponse({ ok: true, deleted: count ?? 0 });
}

// ─── Text chunking ────────────────────────────────────────────────────────────

function chunkText(text: string, size: number, overlap: number): string[] {
  const words  = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];

  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + size).join(" ");
    if (chunk.trim()) chunks.push(chunk.trim());
    i += size - overlap;
    if (i >= words.length) break;
  }

  return chunks;
}

// ─── Embed + store ────────────────────────────────────────────────────────────

async function embedAndStore(
  supabase: ReturnType<typeof createClient>,
  tenant_id: string,
  chunks: string[],
  source: string,
  label: string
): Promise<number> {
  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  let stored = 0;

  // Process in batches
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch  = chunks.slice(i, i + BATCH_SIZE);
    const inputs = batch.map(c => c.replace(/\n/g, " "));

    const embRes = await fetch(`${OPENAI_API_URL}/embeddings`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
    });

    if (!embRes.ok) {
      const txt = await embRes.text();
      throw new Error(`OpenAI embeddings failed: ${txt}`);
    }

    const embData = await embRes.json();
    const embeddings: number[][] = embData.data.map((d: { embedding: number[] }) => d.embedding);

    const rows = batch.map((content, j) => ({
      tenant_id,
      content,
      embedding: embeddings[j],
      source,
      metadata: { label, chunk_index: i + j },
    }));

    const { error } = await supabase.from("knowledge_base").insert(rows);
    if (error) throw new Error("Supabase insert failed: " + error.message);

    stored += rows.length;
  }

  return stored;
}

// ─── PDF text extraction ──────────────────────────────────────────────────────
// Simple extraction: reads the raw bytes and pulls out text-like runs.
// Not OCR. Works fine for text-based PDFs (which most business docs are).

async function extractPdfText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes  = new Uint8Array(buffer);
  const decoder = new TextDecoder("latin1");
  const raw    = decoder.decode(bytes);

  const lines: string[] = [];

  // Extract text between BT/ET markers (BeginText/EndText in PDF)
  const btEt = /BT\s*([\s\S]*?)\s*ET/g;
  let match;
  while ((match = btEt.exec(raw)) !== null) {
    const block = match[1];
    // Pull out strings inside () or <>
    const strParen = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let m2;
    while ((m2 = strParen.exec(block)) !== null) {
      const s = m2[1]
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\");
      lines.push(s);
    }
  }

  if (lines.length) return lines.join(" ").replace(/\s+/g, " ").trim();

  // Fallback: pull printable ASCII runs >= 4 chars
  const asciiRuns = raw.match(/[\x20-\x7E]{4,}/g) || [];
  return asciiRuns
    .filter(s => /[a-zA-Z]/.test(s) && !/^[0-9\s.+\-*/=<>]+$/.test(s))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── DOCX text extraction ─────────────────────────────────────────────────────
// DOCX files are ZIP archives containing deflate-compressed XML files.
// We use the DecompressionStream API (available in Deno) to inflate the entries.

async function extractDocxText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes  = new Uint8Array(buffer);

  // Quick sanity check: DOCX must start with ZIP magic bytes PK\x03\x04
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) {
    throw new Error("File does not appear to be a valid DOCX (not a ZIP archive). Please upload a plain .txt file or paste text directly.");
  }

  // Extract word/document.xml — this contains all the document body text
  const xmlContent = await extractZipEntry(bytes, "word/document.xml");
  if (!xmlContent) {
    throw new Error("Could not extract text from this DOCX file. Please save it as .txt and upload again, or paste the text directly.");
  }

  // Parse XML: extract text from <w:t> elements (Word text runs)
  // Each <w:t> element contains a run of text. <w:p> = paragraph break.
  const paragraphs: string[] = [];
  let current = "";

  // Use a simple state machine to walk the XML
  let i = 0;
  while (i < xmlContent.length) {
    if (xmlContent[i] === "<") {
      // Find end of tag
      const end = xmlContent.indexOf(">", i);
      if (end === -1) break;
      const tag = xmlContent.slice(i + 1, end).trim();
      i = end + 1;

      if (tag === "w:p" || tag.startsWith("w:p ")) {
        // Paragraph start: flush current text as a paragraph
        if (current.trim()) {
          paragraphs.push(current.trim());
          current = "";
        }
      } else if (tag === "w:br" || tag === "w:br/" || tag.startsWith("w:br ")) {
        current += "\n";
      } else if (tag === "w:t" || tag.startsWith("w:t ")) {
        // Text run: collect until </w:t>
        const closeIdx = xmlContent.indexOf("</w:t>", i);
        if (closeIdx !== -1) {
          const run = xmlContent
            .slice(i, closeIdx)
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
          current += run;
          i = closeIdx + 6; // skip past </w:t>
          continue;
        }
      }
    } else {
      i++;
    }
  }

  // Flush any remaining text
  if (current.trim()) {
    paragraphs.push(current.trim());
  }

  const result = paragraphs.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();

  if (!result) {
    throw new Error("No readable text found in DOCX. The document may be empty or use unsupported formatting. Please paste the text directly.");
  }

  return result;
}

/**
 * Extract a named entry from a ZIP file.
 * Supports both stored (compression=0) and deflated (compression=8) entries.
 * Uses the built-in DecompressionStream API available in Deno Deploy.
 */
async function extractZipEntry(bytes: Uint8Array, targetPath: string): Promise<string | null> {
  const sig = [0x50, 0x4B, 0x03, 0x04]; // ZIP local file header signature

  let offset = 0;
  while (offset < bytes.length - 30) {
    // Look for local file header signature
    if (
      bytes[offset]     === sig[0] &&
      bytes[offset + 1] === sig[1] &&
      bytes[offset + 2] === sig[2] &&
      bytes[offset + 3] === sig[3]
    ) {
      const compression = bytes[offset + 8]  | (bytes[offset + 9]  << 8);
      const compSize    = bytes[offset + 18] | (bytes[offset + 19] << 8) |
                          (bytes[offset + 20] << 16) | (bytes[offset + 21] << 24);
      const filenameLen = bytes[offset + 26] | (bytes[offset + 27] << 8);
      const extraLen    = bytes[offset + 28] | (bytes[offset + 29] << 8);

      const nameStart = offset + 30;
      const nameEnd   = nameStart + filenameLen;
      const dataStart = nameEnd + extraLen;
      const dataEnd   = dataStart + compSize;

      const name = new TextDecoder().decode(bytes.slice(nameStart, nameEnd));

      if (name === targetPath) {
        const compressedData = bytes.slice(dataStart, dataEnd);

        if (compression === 0) {
          // Stored (uncompressed)
          return new TextDecoder("utf-8", { fatal: false }).decode(compressedData);
        } else if (compression === 8) {
          // Deflated — use DecompressionStream with raw deflate
          try {
            const ds = new DecompressionStream("deflate-raw");
            const writer = ds.writable.getWriter();
            const reader = ds.readable.getReader();

            writer.write(compressedData);
            writer.close();

            const chunks: Uint8Array[] = [];
            let totalLen = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              totalLen += value.length;
            }

            const inflated = new Uint8Array(totalLen);
            let pos = 0;
            for (const chunk of chunks) {
              inflated.set(chunk, pos);
              pos += chunk.length;
            }

            return new TextDecoder("utf-8", { fatal: false }).decode(inflated);
          } catch (err) {
            console.error(`[train-tenant] DecompressionStream failed for ${targetPath}:`, err);
            return null;
          }
        } else {
          // Unsupported compression method
          console.warn(`[train-tenant] Unsupported ZIP compression method ${compression} for ${targetPath}`);
          return null;
        }
      }

      // Advance past this entry
      offset = dataEnd;
    } else {
      offset++;
    }
  }

  return null; // Entry not found
}

// ─── Tenant verification ──────────────────────────────────────────────────────

async function verifyTenant(
  supabase: ReturnType<typeof createClient>,
  tenant_id: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("tenants")
    .select("id")
    .eq("id", tenant_id)
    .single();
  return !error && !!data;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function jsonError(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}
