import { shallowRef, type ShallowRef } from 'vue'

type IconLibrary = typeof import('./icon-library')

const library = shallowRef<IconLibrary | null>(null)
let loading: Promise<IconLibrary> | null = null

/** Load the icon picker library (a separate ~80 KB chunk) once; later calls share the request. */
export function loadIconLibrary(): Promise<IconLibrary> {
  loading ??= import('./icon-library').then(
    (m) => (library.value = m),
    (e: unknown) => { loading = null; throw e },
  )
  return loading
}

/** The icon library once loaded (null until then). Call `loadIconLibrary` to start loading. */
export const iconLibrary: Readonly<ShallowRef<IconLibrary | null>> = library
