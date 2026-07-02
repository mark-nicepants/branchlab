/**
 * BranchLab wordmark/glyph. Uses `currentColor` for the stroke, so it inherits
 * the surrounding text color — white on dark themes, near-black on light.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 462 647"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="BranchLab"
      className={className}
    >
      <path
        d="M30 617L177 469.5M30 323.5V617H324L432 510.5V431L324 323M30 30L177 176M30 323.5V30H324L394 102V252.996L324 323M177 176V469.5M177 176L324 30M177 176L30 323.5M177 469.5L324 617M177 469.5L324 323"
        stroke="currentColor"
        strokeWidth="60"
      />
    </svg>
  );
}
