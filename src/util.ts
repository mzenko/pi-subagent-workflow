/** Small helpers shared across modules; keep this dependency-free. */

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Text of a user message exactly as pi compares queued steers (string, or joined text blocks). */
export function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** Display label for a spec: explicit label, else a trimmed slice of the prompt. */
export function childLabel(spec: { label?: string; prompt: string }): string {
  return spec.label?.trim() || spec.prompt.trim().replace(/\s+/g, " ").slice(0, 60) || "Subagent";
}

/** Bind a cancellation callback without missing a signal that was already aborted. */
export function bindAbort(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
