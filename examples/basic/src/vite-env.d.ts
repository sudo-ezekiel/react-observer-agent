/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Which adapter the example uses: "openai" (default) or "claude". */
  readonly VITE_PROVIDER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
