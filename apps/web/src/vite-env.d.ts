/// <reference types="vite/client" />
/// <reference types="vitest/globals" />

interface ImportMetaEnv {
  /**
   * Optional Hugging Face mirror host (e.g. https://hf-mirror.com). When set,
   * subtitle models load from this remote mirror instead of the vendored
   * same-origin copy under public/models. Leave unset to use vendored assets.
   */
  readonly VITE_HF_REMOTE_HOST?: string;
  readonly VITE_SUBTITLE_POSTPROCESSOR_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
