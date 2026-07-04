/**
 * BranchLab wordmark/glyph. Uses `currentColor` for the fill, so it inherits
 * the surrounding text color — white on dark themes, near-black on light.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 370 497"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="BranchLab"
      className={className}
    >
      <path
        d="M276.429 7.57129L332.025 64.7451L339.103 72.0225V192.434L331.778 199.756L293.863 237.664L361.959 305.746L369.283 313.069V397.015L361.835 404.357L276.058 488.928L268.757 496.125H0V0H269.066L276.429 7.57129ZM85.2197 446.125H198.286L141.753 389.41L85.2197 446.125ZM177.111 354.058L258.658 435.866L319.283 376.096V333.782L258.475 272.987L177.111 354.058ZM50 268.395V410.632L116.753 343.665V201.428L50 268.395ZM166.753 151.341V293.796L240.859 219.956L289.103 171.719V92.3252L258.193 60.54L166.753 151.341ZM50 197.569L106.363 141.025L50 85.0557V197.569ZM141.752 105.704L197.85 50H85.6562L141.752 105.704Z"
        fill="currentColor"
      />
    </svg>
  );
}
