import { sanitizeTerminalText } from "./sanitize.js";

export function safeDeliveryValue(value: string): string {
  return sanitizeTerminalText(value);
}

/** JSON escapes C0 controls but leaves DEL and C1 controls raw. */
export function stringifyDeliveryJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return "null";
  return json.replace(/[\u007f-\u009f]/g, (control) =>
    `\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
