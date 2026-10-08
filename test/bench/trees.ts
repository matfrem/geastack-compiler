interface Tree { left: Tree | null; right: Tree | null }
function bottomUp(depth: number): Tree {
  if (depth === 0) return { left: null, right: null }
  return { left: bottomUp(depth - 1), right: bottomUp(depth - 1) }
}
function check(tree: Tree): number {
  return tree.left === null || tree.right === null ? 1 : 1 + check(tree.left) + check(tree.right)
}
const t0 = Date.now()
const maxDepth = 18
let total = check(bottomUp(maxDepth + 1))
const longLived = bottomUp(maxDepth)
for (let depth = 4; depth <= maxDepth; depth += 4) {
  const iterations = 1 << (maxDepth - depth + 4)
  let c = 0
  for (let i = 0; i < iterations; i++) c += check(bottomUp(depth))
  total += c
}
total += check(longLived)
console.log('trees ' + (Date.now() - t0) + ' ' + total)
