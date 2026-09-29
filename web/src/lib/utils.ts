// Copied from Orca (MIT, Copyright (c) 2026 Lovecast Inc.) — src/renderer/src/lib/utils.ts. See NOTICE.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Solid focus ring (spec D §3.2): 2px --focus-ring with a 2px offset, both themes. */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
