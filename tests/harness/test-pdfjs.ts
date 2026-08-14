// Test PDF text extraction options
import * as pdfjsLib from "npm:pdfjs-dist@4.0.379";

const data = await Deno.readFile("tests/fixtures/menu-intake/jacks-slice-menu.pdf");
const doc = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
console.log(`Pages: ${doc.numPages}`);

for (let i = 1; i <= Math.min(5, doc.numPages); i++) {
  const page = await doc.getPage(i);
  const textContent = await page.getTextContent();
  const strings = textContent.items
    .filter((item: any) => item.str)
    .map((item: any) => item.str)
    .join(" ");
  console.log(`\n--- Page ${i} (${strings.length} chars) ---`);
  console.log(strings.slice(0, 600));
}