//! expect: 7 6 5 5 3
//! emitted-has: _stable_borrow(((*gea_arg_0->left)))
// A reference formal may be bound to a field read of the caller only when the callee cannot write that field while it
// runs. `sum` and `depth` only read, so `sum(tree.left)` passes the field itself; `consume` writes the very field its
// argument was read from, so it must keep its own copy of the handle, or its parameter would read the cleared field.
interface Tree {
  value: number
  left: Tree | null
  right: Tree | null
}
interface Holder {
  node: Tree | null
}
function sum(tree: Tree): number {
  return tree.left === null || tree.right === null ? tree.value : tree.value + sum(tree.left) + sum(tree.right)
}
function depth(tree: Tree): number {
  return tree.left === null || tree.right === null ? 1 : 1 + depth(tree.left)
}
function consume(node: Tree, holder: Holder): number {
  holder.node = null
  return node.value
}
function consumeThroughChild(node: Tree, branchNode: Tree): number {
  branchNode.left = null
  return node.value
}
const leaf = (value: number): Tree => ({ value, left: null, right: null })
const root: Tree = { value: 1, left: { value: 2, left: leaf(3), right: leaf(4) }, right: leaf(5) }
const holder: Holder = { node: leaf(5) }
const branchNode: Tree = { value: 0, left: leaf(5), right: leaf(1) }
console.log(sum(root.left!) - 2, depth(root.left!) + 4, holder.node ? consume(holder.node, holder) : -1, branchNode.left ? consumeThroughChild(branchNode.left, branchNode) : -1, root.left!.left!.value)
