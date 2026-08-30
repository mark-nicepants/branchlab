/** True while any popup layer is open (dialog, dropdown, select, popover,
 *  context menu…) — those own the Esc key. Radix portals its poppers into
 *  `[data-radix-popper-content-wrapper]`; dialogs carry our shadcn data-slot.
 *  Shared by the session view's and the My work board's keyboard controls. */
export function hasOpenOverlay(): boolean {
  return !!document.querySelector(
    '[data-slot="dialog-content"][data-state="open"], [data-radix-popper-content-wrapper]',
  );
}
