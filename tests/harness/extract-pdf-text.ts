/**
 * Client-side PDF text extraction via pdfjs-dist.
 * Outputs extracted text to stdout for the e2e harness to capture.
 * Usage: deno run --allow-read tests/harness/extract-pdf-text.ts <pdf-path>
 */
import * as pdfjsLib from "npm:pdfjs-dist@4.0.379";

async function main() {
  const pdfPath = Deno.args[0];
  if (!pdfPath) {
    console.error("Usage: deno run --allow-read extract-pdf-text.ts <pdf-path>");
    Deno.exit(1);
  }

  const data = await Deno.readFile(pdfPath);
  const doc = await pdfjsLib.getDocument({ data }).promise;

  let allText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // pdfjs-dist items have str, dir, width, height, transform
    // Concatenate with spaces to preserve word boundaries
    const pageText = tc.items
      .filter((it: any) => it.str)
      .map((it: any) => it.str)
      .join(" ");
    allText += pageText + "\n";
  }

  const trimmed = allText.trim();
  console.log(trimmed);
  // Log stats to stderr so they don't pollute stdout
  console.error(`\n[extract-pdf-text] ${doc.numPages} pages, ${trimmed.length} chars`);
}

main();