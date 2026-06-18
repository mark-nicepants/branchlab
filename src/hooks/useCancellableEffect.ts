import { useEffect, type DependencyList } from "react";

/**
 * Like useEffect, but the callback receives a `cancelled()` predicate that
 * returns true if the effect has been cleaned up (deps changed or unmount).
 * Use it to skip state writes from late async work without rewriting the
 * common `let cancelled = false; …` boilerplate every time.
 */
export function useCancellableEffect(
  effect: (cancelled: () => boolean) => void | Promise<void>,
  deps: DependencyList,
) {
  useEffect(() => {
    let dead = false;
    void effect(() => dead);
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
