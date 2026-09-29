// Copied from Orca (MIT, Copyright (c) 2026 Lovecast Inc.) — src/renderer/src/lib/utils.ts. See NOTICE.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
