import { useState } from "react";

export interface ClipboardImage {
  id: string;
  mime: string;
  /** Data URL (base64-encoded image). Suitable for OpenCode's FilePartInput. */
  url: string;
  filename: string;
}

/**
 * Collects image items pasted into a textarea via the clipboard. Non-image
 * clipboard contents fall through to the textarea's default paste behavior.
 */
export function useClipboardImages() {
  const [attachments, setAttachments] = useState<ClipboardImage[]>([]);

  /** Add image files (from paste or a file picker); non-images are ignored. */
  function addFiles(files: Iterable<File>) {
    for (const blob of files) {
      if (!blob.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result as string;
        const ext = blob.type.split("/")[1] ?? "png";
        setAttachments((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            mime: blob.type,
            url,
            filename: blob.name || `pasted-${Date.now()}.${ext}`,
          },
        ]);
      };
      reader.readAsDataURL(blob);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []).filter((it) =>
      it.type.startsWith("image/"),
    );
    if (items.length === 0) return;
    e.preventDefault();
    addFiles(
      items.map((it) => it.getAsFile()).filter((f): f is File => f !== null),
    );
  }

  function remove(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function clear() {
    setAttachments([]);
  }

  return { attachments, handlePaste, addFiles, remove, clear };
}
