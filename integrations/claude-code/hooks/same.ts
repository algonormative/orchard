// Structural equality for plain JSON values: how the mod decides a state write would change
// nothing, so it makes none (a write redraws everything that read the atom).

export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]))
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left).filter(k => left[k] !== undefined)
  const others = Object.keys(right).filter(k => right[k] !== undefined)
  return keys.length === others.length && keys.every(k => same(left[k], right[k]))
}
