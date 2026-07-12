// Deterministic JSON encoding used for signing: sorted keys, no whitespace,
// non-ASCII escaped as \uXXXX. Matches json.dumps(sort_keys=True,
// separators=(",",":")) in Python. Inlined so the CLI has no runtime deps. The
// vector test checks it against a Python-signed sample.

function escapeAscii(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (code < 0x20 || code > 0x7e) {
      if (code > 0xffff) {
        const high = 0xd800 + ((code - 0x10000) >> 10);
        const low = 0xdc00 + ((code - 0x10000) & 0x3ff);
        out += `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
      } else {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
      }
    } else if (char === '"') {
      out += '\\"';
    } else if (char === "\\") {
      out += "\\\\";
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
