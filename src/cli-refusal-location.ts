import type { CompilationResult } from './compiler.js'
import type { DiagnosticLocation } from './diagnostics/model.js'
import type { DeclarationId, FunctionId, OperationId, SemanticResultId } from './identity/ids.js'
import { declarationOfFunction, nodeOfOperation, operationOfResult } from './identity/ids.js'

type Locator = Pick<CompilationResult, 'locationOfNode' | 'locationOfDeclaration'>

const attempt = (find: () => DiagnosticLocation | null): DiagnosticLocation | null => {
  try {
    return find()
  } catch {
    return null
  }
}

/**
 * Where a refusal is, for a human. Display only: nothing here feeds admission.
 *
 * A refusal names its place three ways depending on the stage that raised it: a
 * `lineage` (print, and certify when it knows the site), an operation id as
 * `owner` (a slot conversion that has no runtime recipe), or a function id as
 * `owner` (abi, certify per body). Reading only the first left the other two
 * printing a raw identity with no line.
 */
export const locationOfRefusal = (
  result: Locator,
  refusal: { readonly owner: string; readonly lineage?: SemanticResultId }
): DiagnosticLocation | null => {
  if (refusal.lineage !== undefined) {
    const lineage = refusal.lineage
    const found = attempt(() => result.locationOfNode(nodeOfOperation(operationOfResult(lineage))))
    if (found !== null) return found
  }
  if (refusal.owner.startsWith('op|')) return attempt(() => result.locationOfNode(nodeOfOperation(refusal.owner as OperationId)))
  if (refusal.owner.startsWith('fn|'))
    return attempt(() => result.locationOfDeclaration(declarationOfFunction(refusal.owner as FunctionId) as DeclarationId))
  return null
}

export const refusalSourceLocation = (
  result: Locator,
  refusal: { readonly owner: string; readonly lineage?: SemanticResultId }
): string => {
  const location = locationOfRefusal(result, refusal)
  return location === null ? refusal.owner : `${location.file}:${location.line}:${location.column}  (${refusal.owner})`
}
