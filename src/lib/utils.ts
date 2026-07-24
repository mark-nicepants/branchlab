import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** `2 comment` → `2 comments`; `1 file` → `1 file`. */
export function plural(n: number, w: string): string {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}
