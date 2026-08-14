// Quick local test of FlateDecode decompression
const pdfData = await Deno.readFile("tests/fixtures/menu-intake/jacks-slice-menu.pdf");

// Latin-1 decode
let text = "";
for (let i = 0; i < pdfData.length; i++) text += String.fromCharCode(pdfData[i]);

// Find first FlateDecode stream
const streamPat = /\/Filter\s*\/\s*FlateDecode[\s\S]*?stream\r?\n([\s\S]*?)endstream/;
const m = streamPat.exec(text);

if (!m) { console.log("No FlateDecode stream found"); Deno.exit(1); }

const streamBody = m[1];
console.log("Stream body length:", streamBody.length);

// Convert to bytes
const bytes = new Uint8Array(streamBody.length);
for (let i = 0; i < streamBody.length; i++) bytes[i] = streamBody.charCodeAt(i);

// Try decompression with DecompressionStream
const header = (bytes[0] << 8) | bytes[1];
console.log("First 2 bytes:", bytes[0].toString(16), bytes[1].toString(16), "magic:", header.toString(16));

const isZlib = bytes[0] === 0x78;
console.log("Is zlib-wrapped:", isZlib);

let data = bytes;
if (isZlib) {
  // Skip 2-byte zlib header and 4-byte Adler-32 trailer
  data = bytes.slice(2);
  // Remove trailer by finding last 4 bytes
  console.log("Stripped header, using", data.length, "bytes");
}

const ds = new DecompressionStream("deflate");
const writer = ds.writable.getWriter();
const reader = ds.readable.getReader();

writer.write(data);
writer.close();

const chunks: Uint8Array[] = [];
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (value) chunks.push(value);
}

const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
const result = new Uint8Array(totalLength);
let offset = 0;
for (const chunk of chunks) {
  result.set(chunk, offset);
  offset += chunk.length;
}

let decoded = "";
for (let i = 0; i < result.length; i++) decoded += String.fromCharCode(result[i]);
console.log("Decompressed:", decoded.length, "chars");
console.log("--- First 500 chars ---");
console.log(decoded.slice(0, 500));