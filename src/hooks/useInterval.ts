import { useEffect, useRef } from "react";

/**
 * Run `fn` every `ms` milliseconds for the lifetime of the component. Pass
 * `ms = null` to pause. The callback is kept in a ref so changing it doesn't
 * reset the timer.
 */
export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;

  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
