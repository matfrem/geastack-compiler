import ts from 'typescript'

/**
 * What a declaration is called in the source, for a target that labels what it
 * emits. Display evidence: nothing may decide on it, and an identity stays the
 * only thing that tells two declarations apart.
 *
 * A method is named after its class (`Beam_update`) because a bare `update` is
 * every class's; an arrow bound to a variable takes the variable's name, since
 * the arrow has none of its own. A callback that is bound to nothing is named
 * after the function that contains it and its position among that function's
 * callbacks (`Beam_update_cb2`), which is as much as the source says about it.
 */

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

const isFunctionLike = (node: ts.Node): node is FunctionLike =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node)

const memberNameOf = (name: ts.PropertyName | undefined): string | null => {
  if (name === undefined) return null
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text.startsWith('#') ? name.text.slice(1) : name.text
  return ts.isStringLiteral(name) ? name.text : null
}

const fileLabelOf = (file: ts.SourceFile): string => {
  const base = file.fileName.slice(Math.max(file.fileName.lastIndexOf('/'), file.fileName.lastIndexOf('\\')) + 1)
  const dot = base.indexOf('.')
  return `module_${dot > 0 ? base.slice(0, dot) : base}`
}

/** The name the source gives a declaration itself, without inventing one for what it left unnamed. */
const ownNameOf = (declaration: ts.Declaration): string | null => {
  if (
    ts.isClassLike(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration)
  )
    return declaration.name === undefined ? null : declaration.name.text
  if (ts.isVariableDeclaration(declaration)) return ts.isIdentifier(declaration.name) ? declaration.name.text : null
  if (ts.isConstructorDeclaration(declaration)) {
    const owner = declaration.parent.name?.text
    return owner === undefined ? null : `${owner}_constructor`
  }
  if (ts.isMethodDeclaration(declaration) || ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) {
    const member = memberNameOf(declaration.name)
    if (member === null) return null
    const owner = ts.isClassLike(declaration.parent) ? declaration.parent.name?.text : enclosingNameOf(declaration)
    if (owner === undefined || owner === null) return null
    const accessor = ts.isGetAccessorDeclaration(declaration) ? 'get_' : ts.isSetAccessorDeclaration(declaration) ? 'set_' : ''
    return `${owner}_${accessor}${member}`
  }
  if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
    if (ts.isFunctionExpression(declaration) && declaration.name !== undefined) return declaration.name.text
    const parent = declaration.parent
    if (ts.isVariableDeclaration(parent)) return ts.isIdentifier(parent.name) ? parent.name.text : null
    if (ts.isPropertyDeclaration(parent) && ts.isClassLike(parent.parent)) {
      const member = memberNameOf(parent.name)
      const owner = parent.parent.name?.text
      return member === null || owner === undefined ? null : `${owner}_${member}`
    }
    if (ts.isPropertyAssignment(parent)) {
      const member = memberNameOf(parent.name)
      const owner = enclosingNameOf(declaration)
      return member === null || owner === null ? null : `${owner}_${member}`
    }
  }
  return null
}

/** The nearest named function, class or, failing that, module that contains a node. */
const enclosingNameOf = (node: ts.Node): string | null => {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isSourceFile(current)) return fileLabelOf(current)
    if (ts.isClassLike(current) && current.name !== undefined) return current.name.text
    if (isFunctionLike(current)) {
      const name = ownNameOf(current)
      if (name !== null) return name
    }
  }
  return null
}

/** Every callback bound to nothing, by position within the named function (or module) it belongs to. */
const callbackOrder = new WeakMap<ts.Node, Map<ts.Node, number>>()

const callbacksWithin = (anchor: ts.Node): Map<ts.Node, number> => {
  const known = callbackOrder.get(anchor)
  if (known !== undefined) return known
  const order = new Map<ts.Node, number>()
  const walk = (node: ts.Node): void => {
    if (node !== anchor && isFunctionLike(node)) {
      if (ownNameOf(node) !== null) return
      order.set(node, order.size + 1)
    }
    if (node !== anchor && ts.isClassLike(node)) return
    ts.forEachChild(node, walk)
  }
  walk(anchor)
  callbackOrder.set(anchor, order)
  return order
}

const anchorOf = (node: ts.Node): ts.Node => {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isSourceFile(current)) return current
    if (isFunctionLike(current) && ownNameOf(current) !== null) return current
  }
  return node.getSourceFile()
}

export const displayNameOfDeclaration = (declaration: ts.Declaration): string | null => {
  const own = ownNameOf(declaration)
  if (own !== null) return own
  if (!isFunctionLike(declaration) || ts.isConstructorDeclaration(declaration)) return null
  const owner = enclosingNameOf(declaration)
  const index = callbacksWithin(anchorOf(declaration)).get(declaration)
  return owner === null || index === undefined ? null : `${owner}_cb${index}`
}

/** The names a callable's parameters were written under, `null` for a pattern; `this` is not a parameter of the emitted function. */
export const parameterNamesOf = (declaration: ts.Declaration): readonly (string | null)[] | null => {
  if (!isFunctionLike(declaration)) return null
  return declaration.parameters
    .filter((parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'))
    .map((parameter) => (ts.isIdentifier(parameter.name) ? parameter.name.text : null))
}
