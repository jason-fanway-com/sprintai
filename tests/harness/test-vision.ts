// Test: render PDF page as PNG, send to OpenRouter for vision extraction
// Usage: deno run --allow-read --allow-run --allow-env --allow-net tests/harness/test-vision.ts

import { createCanvas, loadImage } from "https://deno.land/x/canvas@v1.4.1/mod.ts";

// Sips-based PDF rendering approach - use shell for rendering since Deno can't render PDFs natively
async function renderPdfPage(pdfPath: string, outputPath: string, page: number): Promise<Uint8Array> {
  // Use macOS sips to render first page of PDF as PNG
  const cmd = new Deno.Command("sips", {
    args: ["-s", "format", "png", pdfPath, "--out", outputPath, "-Z", "1200"],
    stdout: "null",
    stderr: "null",
  });
  await cmd.output();
  return await Deno.readFile(outputPath);
}

async function main() {
  const pdfPath = "tests/fixtures/menu-intake/jacks-slice-menu.pdf";
  const pngPath = "/tmp/jacks_page1_v2.png";
  
  console.log("Rendering PDF page 1...");
  const pngData = await renderPdfPage(pdfPath, pngPath, 1);
  console.log(`PNG rendered: ${pngData.length} bytes`);
  
  const pngB64 = btoa(String.fromCharCode(...pngData));
  console.log(`Base64: ${pngB64.length} chars`);
  
  const orKey = Deno.env.get("OPENROUTER_API_KEY") ?? Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  if (!orKey) {
    console.error("No OpenRouter key found");
    Deno.exit(1);
  }
  console.log(`Key present: ${orKey.length > 0}, starts with: ${orKey.slice(0, 12)}...`);
  
  const body = JSON.stringify({
    model: "anthropic/claude-opus-5",
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${pngB64}`
          }
        },
        {
          type: "text",
          text: "This is page 1 of a restaurant menu PDF. List all category section headers and the first 5 menu items with their prices. Be concise."
        }
      ]
    }]
  });
  
  console.log("Sending to OpenRouter...");
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${orKey}`,
      "HTTP-Referer": "https://getsprintai.com"
    },
    body
  });
  
  const result = await resp.json();
  if (!resp.ok) {
    console.error(`HTTP ${resp.status}:`, JSON.stringify(result).slice(0, 800));
    Deno.exit(1);
  }
  
  const content = result.choices?.[0]?.message?.content ?? "NO CONTENT";
  console.log(`Model: ${result.model}`);
  console.log(`Usage: ${JSON.stringify(result.usage)}`);
  console.log(`Response: ${content.slice(0, 1500)}`);
}

main();