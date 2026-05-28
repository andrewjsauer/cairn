/**
 * Defensive JSON extraction from model output. Models wrap JSON in prose or
 * ```json fences despite instructions; the engine must never crash on that.
 * Returns null if nothing parseable is found, and callers fall back to a
 * deterministic result so consolidation always produces *something* durable.
 */
export function extractJson<T = unknown>(text: string): T | null {
  const trimmed = text.trim();

  // Fast path: the whole thing is JSON.
  const direct = tryParse<T>(trimmed);
  if (direct !== null) return direct;

  // Strip a ```json ... ``` (or bare ```) fence if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const fenced = tryParse<T>(fence[1].trim());
    if (fenced !== null) return fenced;
  }

  // Last resort: grab the first balanced { } or [ ] span.
  const span = firstBalancedSpan(trimmed);
  if (span) {
    const parsed = tryParse<T>(span);
    if (parsed !== null) return parsed;
  }
  return null;
}

function tryParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function firstBalancedSpan(s: string): string | null {
  const opens: Record<string, string> = { "{": "}", "[": "]" };
  let start = -1;
  let open = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{" || s[i] === "[") {
      start = i;
      open = s[i];
      break;
    }
  }
  if (start === -1) return null;
  const close = opens[open];
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
