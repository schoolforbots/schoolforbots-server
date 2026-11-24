// The motion that needs script. Everything else (page changes, the theme circle,
// the search box, the homepage) is CSS in styles/motion.css. With reduced motion
// each of these still does its job, only without the movement.

const reduce = matchMedia('(prefers-reduced-motion: reduce)')
const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)'

// ---------------------------------------------------------------------------
// The table of contents: one marker beside the current section that glides from
// line to line as you scroll, rather than the highlight jumping. Starlight marks
// the current link with aria-current; the marker follows it.

function tocMarker(): void {
  for (const toc of document.querySelectorAll<HTMLElement>('starlight-toc nav')) {
    const list = toc.querySelector('ul')
    if (!list) continue
    const marker = document.createElement('span')
    marker.className = 'toc-marker'
    marker.setAttribute('aria-hidden', 'true')
    list.before(marker)
    toc.classList.add('has-toc-marker')
    let shown = false
    const place = () => {
      const current = toc.querySelector<HTMLElement>('a[aria-current="true"]')
      if (!current) {
        marker.style.opacity = '0'
        return
      }
      const top = current.offsetTop
      const height = current.offsetHeight
      // The first placement does not slide in from the top.
      if (!shown) marker.style.transition = 'none'
      marker.style.transform = `translateY(${top}px)`
      marker.style.height = `${height}px`
      marker.style.opacity = '1'
      if (!shown) {
        marker.getBoundingClientRect()
        marker.style.transition = ''
        shown = true
      }
    }
    new MutationObserver(place).observe(toc, { subtree: true, attributes: true, attributeFilter: ['aria-current'] })
    new ResizeObserver(place).observe(list)
    place()
  }
}

// ---------------------------------------------------------------------------
// A heading you jump to (a link, a search result, an address with #…) gets a
// highlighter stroke under it that sweeps across and then fades, so the eye
// finds where it landed. Error table rows get a tint that fades the same way.

function flash(id: string): void {
  if (!id) return
  const target = document.getElementById(decodeURIComponent(id))
  if (!target || !target.closest('.sl-markdown-content')) return
  // A link to a schema block opens it (easing open, as if its summary were clicked).
  if (target instanceof HTMLDetailsElement) {
    if (!target.open) {
      if (reduce.matches) target.open = true
      else toggle(target)
    }
    target.classList.remove('flash')
    void target.offsetWidth
    target.classList.add('flash')
    target.addEventListener('animationend', () => target.classList.remove('flash'), { once: true })
    return
  }
  target.classList.remove('flash')
  // Restart the animation when the same target is chosen again.
  void target.offsetWidth
  target.classList.add('flash')
  target.addEventListener('animationend', () => target.classList.remove('flash'), { once: true })
}

function headingFlash(): void {
  const fromHash = () => flash(location.hash.slice(1))
  addEventListener('hashchange', fromHash)
  // Clicking a link to the hash already in the address fires no hashchange.
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href*="#"]') as HTMLAnchorElement | null
    if (!a || a.origin !== location.origin || a.pathname !== location.pathname) return
    if (a.hash === location.hash) flash(a.hash.slice(1))
  })
  if (location.hash) requestAnimationFrame(fromHash)
}

// ---------------------------------------------------------------------------
// Sidebar groups ease open and shut instead of snapping. The chevron turns at
// once (Starlight's own transition); the height follows.

const running = new WeakMap<HTMLDetailsElement, Animation>()

function heightWhen(details: HTMLDetailsElement, open: boolean): number {
  const was = details.open
  details.open = open
  const h = details.getBoundingClientRect().height
  details.open = was
  return h
}

function toggle(details: HTMLDetailsElement): void {
  const from = details.getBoundingClientRect().height
  running.get(details)?.cancel()
  const opening = !details.open || details.hasAttribute('data-closing')
  const to = heightWhen(details, opening)
  details.open = true
  details.toggleAttribute('data-closing', !opening)
  details.style.overflow = 'hidden'
  const animation = details.animate({ height: [`${from}px`, `${to}px`] }, { duration: 260, easing: EASE })
  running.set(details, animation)
  const end = () => {
    running.delete(details)
    details.style.overflow = ''
  }
  animation.onfinish = () => {
    end()
    if (!opening) {
      details.open = false
      details.removeAttribute('data-closing')
    }
  }
  animation.oncancel = end
}

function sidebarGroups(): void {
  document.addEventListener('click', (e) => {
    if (reduce.matches || e.defaultPrevented || e.button !== 0) return
    const summary = (e.target as Element | null)?.closest?.('nav.sidebar summary, details.schema > summary')
    // A link inside the summary (the schema file) keeps working.
    if ((e.target as Element).closest('a')) return
    const details = summary?.parentElement
    if (!(details instanceof HTMLDetailsElement)) return
    e.preventDefault()
    toggle(details)
  })
}

// ---------------------------------------------------------------------------
// Copy buttons ([data-copy]): the icon turns into a tick, then back.

function copyButtons(): void {
  document.addEventListener('click', async (e) => {
    const button = (e.target as Element | null)?.closest?.<HTMLButtonElement>('button[data-copy]')
    if (!button) return
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? '')
    } catch {
      return
    }
    button.classList.add('copied')
    clearTimeout(Number(button.dataset.timer))
    button.dataset.timer = String(setTimeout(() => button.classList.remove('copied'), 1500))
  })
}

export function startMotion(): void {
  tocMarker()
  headingFlash()
  sidebarGroups()
  copyButtons()
}
