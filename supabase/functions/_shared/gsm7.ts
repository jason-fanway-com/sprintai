// gsm7.ts — every outbound text goes through here. A single character outside the GSM-7 alphabet ("×", "·", an emoji,
// a curly quote) makes the carrier send the whole message as 16-bit text: 67 characters per segment instead of 153.
// Jason, 2026-09-26: half the outbound segments in his test orders were that penalty. Nothing we send needs those characters.
const GSM = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€");
const MAP: Record<string, string> = { "×": "x", "·": "|", "•": "-", "—": "-", "–": "-", "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"', "…": "...", " ": " ", " ": " ", "→": "->", "✓": "", "🧪": "" };
export function toGsm7(text: string): string {
  let out = "";
  for (const ch of text) out += ch in MAP ? MAP[ch] : GSM.has(ch) ? ch : "";
  return out.replace(/[ \t]{2,}/g, " ").replace(/ \n/g, "\n").trim();
}
/** Segments the carrier will bill for this text (GSM-7: 160, or 153 each when split; 16-bit: 70, or 67 each). */
export function segments(text: string): number {
  const gsm = [...text].every((c) => GSM.has(c));
  const n = gsm ? [...text].reduce((a, c) => a + ("^{}\\[~]|€".includes(c) ? 2 : 1), 0) : [...text].length;
  return gsm ? (n <= 160 ? 1 : Math.ceil(n / 153)) : (n <= 70 ? 1 : Math.ceil(n / 67));
}
