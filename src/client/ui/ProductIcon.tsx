/** A product's icon: the official one when Outpost has it, else one uniform tile with the name's first character (design §5.8). */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Product } from '../../core/types.ts'

/** The first character a reader sees in `name`, a Latin letter upper-cased. */
const initial = (name: string) => (Array.from(name.trim())[0] ?? '?').toUpperCase()

/**
 * Draws the icon at `size` pixels (20 in lists, 44 in a page header). The image comes from `/outpost/api/icons/<id>`;
 * if it fails to load, the tile takes its place. The tile's colors come from the stylesheet only (the theme's light blue
 * and blue), so every product without an icon looks the same. The icon is decorative: the name always stands beside it.
 */
export function ProductIcon({ product, size = 20 }: { product: Pick<Product, 'id' | 'name' | 'iconPath'>; size?: number }): ReactNode {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [product.id, product.iconPath])
  const style = { '--op-icon-size': `${size}px` } as CSSProperties
  if (product.iconPath && !failed) {
    return <img className="op-icon" src={`/outpost/api/icons/${encodeURIComponent(product.id)}`} width={size} height={size} alt=""
      style={style} onError={() => { setFailed(true) }} />
  }
  return <span className="op-icon op-icon-tile" style={style} aria-hidden="true">{initial(product.name)}</span>
}
