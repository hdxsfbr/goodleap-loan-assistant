import type { HealthResponse } from "@shared/schemas";
import { KEY_MISSING_MESSAGE, KEY_REJECTED_MESSAGE } from "../copy";

interface KeyBannerProps {
  health: HealthResponse | null;
  /** The key was present but a turn came back `llm.missing_key`. */
  keyMissing: boolean;
  /** The key was present but the model service rejected it. */
  keyRejected: boolean;
}

/** The persistent banner when the assistant has no usable key. Names the variable and the file. */
export function KeyBanner({ health, keyMissing, keyRejected }: KeyBannerProps) {
  const message = keyRejected
    ? KEY_REJECTED_MESSAGE
    : keyMissing || health?.has_llm_key === false
      ? KEY_MISSING_MESSAGE
      : null;
  if (!message) return null;
  return (
    <div className="key-banner" role="status">
      {message}
    </div>
  );
}
