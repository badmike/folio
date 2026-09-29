/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Base URL of folio-server (e.g. https://api.example.com or /api). Empty = local only. */
  readonly VITE_API_BASE?: string
  /** Clerk publishable key (pk_test_... / pk_live_...). Empty = no accounts. */
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
