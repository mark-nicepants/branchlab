// Typed chat messages: structured user-message payloads carried in a chat
// entry's `display` field.
//
// The backend stores `display` as an opaque string (it is "what the UI
// shows"), so a JSON envelope persists across restarts and workspace switches
// with no backend changes. Plain messages stay plain strings; structured
// messages encode `{ "$kind": ..., v: 1, ... }` and get a dedicated renderer
// in ChatMessage.tsx. Every non-chat surface that needs prose (labels,
// previews) goes through `displayText` so raw JSON never leaks into the UI.
//
// Adding a new typed message:
//   1. Add its payload to the `TypedDisplay` union (with a unique `$kind`).
//   2. Teach `parseTypedDisplay` to validate it.
//   3. Give it a `displayText` projection.
//   4. Add a renderer case in ChatMessage.tsx's `UserMessageView`.

/** One review comment as carried in the chat message (subset of ReviewComment). */
export interface ReviewDisplayComment {
  file: string;
  line: number;
  text: string;
}

export type TypedDisplay = {
  $kind: "review";
  v: 1;
  comments: ReviewDisplayComment[];
};

export function encodeTypedDisplay(payload: TypedDisplay): string {
  return JSON.stringify(payload);
}

/** Parse a display string into a typed payload; null → render as plain text. */
export function parseTypedDisplay(display: string): TypedDisplay | null {
  if (!display.startsWith('{"$kind"')) return null;
  try {
    const obj = JSON.parse(display) as Partial<TypedDisplay>;
    if (
      obj.$kind === "review" &&
      Array.isArray(obj.comments) &&
      obj.comments.every(
        (c) =>
          typeof c?.file === "string" &&
          typeof c?.line === "number" &&
          typeof c?.text === "string",
      )
    ) {
      return { $kind: "review", v: 1, comments: obj.comments };
    }
    return null;
  } catch {
    return null;
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Human-readable one-liner for any display string — for labels and previews
 *  outside the chat transcript. */
export function displayText(display: string): string {
  const typed = parseTypedDisplay(display);
  if (!typed) return display;
  const files = new Set(typed.comments.map((c) => c.file)).size;
  return `Review feedback · ${plural(typed.comments.length, "comment")} on ${plural(files, "file")}`;
}
