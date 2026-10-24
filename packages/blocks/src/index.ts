/**
 * @proagentstore/blocks — the first-party UI blocks the PAGS console and agent UIs share (#187).
 *
 * INTERNAL. Owner decision 2026-10-14: build the library for our own surfaces first and extract
 * what is already duplicated, without committing to a third-party API (React components vs a
 * DOM-mount contract is still open). So this package is `private`, never published, and consumed
 * from source by workspace packages only — anything a third party may rely on goes through the
 * published SDK instead.
 *
 * Styling uses the console's theme tokens (`bg-panel`, `text-accent`, …), defined in
 * store/console/src/index.css; a consumer's Tailwind build must scan this package's source
 * (`@source`), the same way it scans agents/coder/web.
 */
export { CopyButton } from "./CopyButton";
export { EmptyState } from "./EmptyState";
export { MessageHeader } from "./MessageHeader";
export { Modal } from "./Modal";
export { type PillStatus, StatusPill } from "./StatusPill";
export { TerminalPane } from "./TerminalPane";
export { timeAgo } from "./time-ago";
export { FilePreview, PREVIEW_MAX_BYTES, type PreviewButton, type PreviewFile, type PreviewKind, previewKind } from "./FilePreview";
