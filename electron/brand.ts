// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Brand {
  productName: string;
  commandName: string;
  appId: string;
  tagline: string;
  accentColor: string;
  repository: string;
}

const here = dirname(fileURLToPath(import.meta.url));

export function brandingDir(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '';
  for (const p of [
    join(here, '..', '..', 'branding'),
    join(here, '..', 'branding'),
    join(resourcesPath, 'branding'),
  ]) {
    if (p && existsSync(join(p, 'brand.json'))) return p;
  }
  throw new Error('branding/ not found');
}

let cached: Brand | null = null;

export function loadBrand(): Brand {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(join(brandingDir(), 'brand.json'), 'utf8')) as Brand;
  for (const k of ['productName', 'commandName', 'appId', 'tagline', 'accentColor', 'repository'] as const) {
    if (typeof raw[k] !== 'string' || !raw[k]) throw new Error(`brand.json missing ${k}`);
  }
  cached = raw;
  return raw;
}
