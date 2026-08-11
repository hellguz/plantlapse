import { useLayoutEffect, useState, type RefObject } from 'react'

export interface Box {
  w: number
  h: number
}

/**
 * Live content-box size of an element.
 *
 * Rotation needs real numbers. Container query units express "the other axis"
 * declaratively, but only inside an element that actually established a size
 * container — one missing `container-type` and the declaration is dropped, the
 * element silently falls back to filling its parent, and the picture is fitted
 * against the wrong box. Measuring is a few lines and cannot fail quietly.
 */
export function useElementSize(ref: RefObject<Element | null>): Box {
  const [size, setSize] = useState<Box>({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    // Measure before the first paint, so a rotated surface never flashes
    // through at the unrotated size on the way in.
    const rect = el.getBoundingClientRect()
    setSize({ w: rect.width, h: rect.height })

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize((s) => (s.w === width && s.h === height ? s : { w: width, h: height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return size
}
