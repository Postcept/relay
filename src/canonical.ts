// Deterministic JSON encoding used for signing: sorted keys, no whitespace,
// anything outside printable ASCII escaped. Matches json.dumps(sort_keys=True,
// separators=(",",":")) in Python, including its short escapes for backspace,
// tab, newline, form feed and carriage return (\b \t \n \f \r) rather than the
// numeric \u000x form. Inlined so the CLI has no runtime deps. The vector test
// checks it against a Python-signed sample.

const SHORT_ESCAPE: Record<number, string> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
};

function escapeAscii(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (char === '"') {
      out += '\\"';
    } else if (char === "\\") {
      out += "\\\\";
    } else if (SHORT_ESCAPE[code] !== undefined) {
      out += SHORT_ESCAPE[code];
    } else if (code < 0x20 || code > 0x7e) {
      if (code > 0xffff) {
        const high = 0xd800 + ((code - 0x10000) >> 10);
        const low = 0xdc00 + ((code - 0x10000) & 0x3ff);
        out += `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
      } else {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
      }
    } else {
      out += char;
    }
  }
  return out;
}

export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return `"${escapeAscii(value)}"`;
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `"${escapeAscii(k)}":${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}
