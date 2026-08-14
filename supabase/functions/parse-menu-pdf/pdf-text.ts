/**
 * pdf-text.ts — Extract PDF text using pdfjs-dist for Deno edge functions.
 *
 * Replaces the previous weak custom parser with a real PDF rendering engine
 * that actually extracts prices, names, and structure from PDF documents.
 *
 * pdfjs-dist@4.0.379 is already in the Deno cache (used by the test harness).
 */
import * as pdfjsLib from "npm:pdfjs-dist@4.0.379";

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;

  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const pageText = tc.items
      .filter((it: any) => it.str)
      .map((it: any) => it.str)
      .join(" ");
    pageTexts.push(pageText);
  }

  const result = pageTexts.join("\n").trim();
  console.log(`[pdf-text] pdfjs-dist extracted ${result.length} chars from ${doc.numPages} pages`);
  return result;
}