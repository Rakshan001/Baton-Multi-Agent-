/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BATON_API: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
