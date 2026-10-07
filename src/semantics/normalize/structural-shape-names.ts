import ts from 'typescript'

/**
 * The name an anonymous object type is known by, when the program gives it one:
 * the variable an object literal initializes (`export const POND = { ... } as const`).
 *
 * Display evidence for a target that labels what it emits -- a shape that is
 * not a declared interface or alias has nothing else a reader could search the
 * source for. Nothing decides on it, and the shape's identity is its structure:
 * two literals of one layout intern to one id, which keeps the first name.
 */
export const variableNameOfObjectLiteralType = (type: ts.Type): string | null => {
  const symbol = type.symbol as ts.Symbol | undefined
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.ObjectLiteral) === 0) return null
  let node: ts.Node | undefined = symbol.valueDeclaration?.parent
  while (
    node !== undefined &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node))
  )
    node = node.parent
  return node !== undefined && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : null
}
