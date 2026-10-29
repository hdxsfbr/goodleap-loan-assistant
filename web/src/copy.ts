// Text the page itself owns: prompts, captions and the messages for failures that happen before a
// server reply exists. Everything a reply carries (explanations, footers, disclosure lines, error
// messages) is printed exactly as the server sent it.

export const SUGGESTED_PROMPTS = [
  "Payment options for this project",
  "Explain deferred interest",
  "What documents are needed?",
] as const;

/** Why "Show payment options" is disabled. */
export const NO_MODEL_CAPTION = "Confirm a requested loan amount first";

/** Beside the "Show homeowner view" button of an options table that a newer one has replaced. */
export const OLDER_OPTIONS_CAPTION = "Use the latest options";

/** The same sentence the server sends with `llm.missing_key`. */
export const KEY_MISSING_MESSAGE =
  "No API key is set. Add ANTHROPIC_API_KEY to the .env file to turn on the assistant. Payment options, the form, the reviewer and the audit views still work.";

/** The same sentence the server sends with `llm.auth_failed`. */
export const KEY_REJECTED_MESSAGE =
  "The API key was rejected. Check ANTHROPIC_API_KEY in the .env file and restart the app.";

export const COPILOT_DISABLED_MESSAGE = "The assistant is disabled by operator.";

export const CONNECTION_ERROR_MESSAGE =
  "The server could not be reached. Check the connection and try again.";

export const INTERRUPTED_MESSAGE = "The answer was cut off before it finished. Try again.";

export const UNREADABLE_REPLY_MESSAGE = "Something went wrong on our side. Please try again.";

export const RENDER_FAILURE_TITLE = "Something went wrong";
export const RENDER_FAILURE_MESSAGE = "This page stopped working. Reloading usually fixes it.";

export const WORKING_STATUS = "Working on it...";
export const CALCULATING_STATUS = "Calculating payments...";

export const SUBMITTED_LABEL = "Submitted, documents under review";
export const REVIEWED_LABEL = "Documents reviewed";
