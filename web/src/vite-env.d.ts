// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BATON_API: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
