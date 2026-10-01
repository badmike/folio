/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Release version, set by the image build (e.g. 26.10.1-8e5921d). */
  readonly VITE_FOLIO_VERSION?: string
  /** Fallback for config.json: base URL of folio-server (e.g. /api). Empty = local only. */
  readonly VITE_API_BASE?: string
  /** Fallback for config.json: Clerk publishable key (pk_test_... / pk_live_...). Empty = no accounts. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
