/**
 * Installed on iPadOS the CSS viewport units (100vh, 100dvh, fill-available) do not reliably
 * match the visible area: the app either ends above the home indicator or slides under the
 * status bar. The only trustworthy size is the visual viewport, so it is written to
 * --app-w / --app-h on <html> and every full-screen view sizes itself from those. Any stray
 * page scroll (which is what makes the top disappear behind the bar) is reset as well.
 */
export function bindViewportSize(): () => void {
  if (typeof window === 'undefined') return () => {}
  const root = document.documentElement
  const vv = window.visualViewport
  let raf = 0
  const apply = () => {
    raf = 0
    const w = Math.round(vv?.width ?? window.innerWidth)
    const h = Math.round(vv?.height ?? window.innerHeight)
    root.style.setProperty('--app-w', `${w}px`)
    root.style.setProperty('--app-h', `${h}px`)
    if (window.scrollX || window.scrollY || (vv && (vv.offsetTop || vv.offsetLeft))) window.scrollTo(0, 0)
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply) }
  apply()
  window.addEventListener('resize', schedule)
  window.addEventListener('orientationchange', schedule)
  window.addEventListener('pageshow', schedule)
  window.addEventListener('focus', schedule)
  vv?.addEventListener('resize', schedule)
  vv?.addEventListener('scroll', schedule)
  return () => {
    window.removeEventListener('resize', schedule)
    window.removeEventListener('orientationchange', schedule)
    window.removeEventListener('pageshow', schedule)
    window.removeEventListener('focus', schedule)
    vv?.removeEventListener('resize', schedule)
    vv?.removeEventListener('scroll', schedule)
    if (raf) cancelAnimationFrame(raf)
  }
}
