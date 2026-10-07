import { functionId, type DeclarationId, type StructuralTypeId } from '../../identity/ids.js'
import type { StructuralType } from '../../semantics/model/structural-types.js'
import { cppBodyName, cppClassName, cppGlobalName, cppRecordStructName, sanitizeForCppIdentifier } from './types.js'

/**
 * The names a reader sees in the emitted C++ for classes, records, functions
 * and module-level bindings.
 *
 * Every name the emitter mints is derived from an identity (`gea_class_decl_f3_545`,
 * `gea_record_type_945`) because an identity is the only thing that is unique:
 * two `class Foo` in two files, a local class, and each monomorphized copy of a
 * generic all share a source name, and an interface is not even one struct's
 * name -- every type of the same layout interns to the one record. So the source
 * name is never what a C++ name is derived from. It replaces the identity
 * AFTER the identity is fixed: `GcFoo`, `GrAiServices`, `Gf_jardinouPose`,
 * `Gg_HUG_DURATION`, and `GcFoo_f3_545` for a second `Foo`. A pure
 * relabelling -- no decision upstream reads it.
 *
 * That is also why this is one pass over the finished text rather than a
 * parameter on the ~190 sites that spell these names. A site cannot get the
 * answer wrong when it never asks.
 *
 * The bare spelling goes to ONE declaration per name, chosen before any text is
 * rewritten and over every unit of the program together. A layout that
 * renders several units renders each separately; a name settled unit by unit
 * would call one struct two things, and the link would say so. The choice is
 * the lowest-ranked identity (declaration order, then structural-table order),
 * never the first one a unit happens to print.
 */

const identifierCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
const isIdentifierCharacter = (character: string | undefined): boolean => character !== undefined && identifierCharacters.includes(character)

/**
 * A source name as it reads inside an identifier. Runs of `_` collapse because a
 * double underscore anywhere in a C++ identifier is reserved; the suffix is
 * what makes a repeated name unique, so nothing is lost.
 */
const labelOf = (name: string): string => {
  let label = ''
  for (const character of sanitizeForCppIdentifier(name)) {
    if (character === '_' && label.endsWith('_')) continue
    label += character
  }
  let start = 0
  let end = label.length
  while (start < end && label[start] === '_') start += 1
  while (end > start && label[end - 1] === '_') end -= 1
  return label.slice(start, end)
}

interface Candidate {
  /** The emitted identifier this stands for, e.g. `gea_class_decl_f3_545`. */
  readonly key: string
  /** `Gc`, `Gr`, `Gf_` or `Gg_`. */
  readonly prefix: string
  readonly label: string
  /** The part of the identity that tells two same-named things apart, e.g. `f3_545`. */
  readonly suffix: string
  readonly rank: number
}

const markers = ['gea_class_', 'gea_record_']

/** A body's name continues with the variant it was lowered under (`_stable_borrow`), so its identity is matched as a prefix. */
const bodyMarker = 'gea_body_'

export interface IdentifierRenamer {
  /** The same texts with every class, record, function and global name respelled, as one decision over all of them. */
  readonly renameAll: <Text extends string>(texts: readonly Text[]) => Text[]
}

export const createIdentifierRenamer = (
  structuralTypes: ReadonlyMap<StructuralTypeId, StructuralType>,
  declarationNames: ReadonlyMap<DeclarationId, string>,
  shapeNames: ReadonlyMap<StructuralTypeId, string>
): IdentifierRenamer => {
  const known = new Map<string, Candidate>()
  let rank = 0
  const learn = (key: string, prefix: string, name: string | undefined, identity: string, droppedPrefix: string): void => {
    if (name === undefined || known.has(key)) return
    const label = labelOf(name)
    if (label === '') return
    const sanitized = sanitizeForCppIdentifier(identity)
    known.set(key, {
      key,
      prefix,
      label,
      suffix: sanitized.startsWith(droppedPrefix) ? sanitized.slice(droppedPrefix.length) : sanitized,
      rank: rank++
    })
  }

  for (const [declaration, name] of declarationNames) {
    learn(cppClassName(declaration), 'Gc', name, declaration, 'decl_')
    learn(cppBodyName(functionId(declaration)), 'Gf_', name, functionId(declaration), 'fn_decl_')
    learn(cppGlobalName(declaration), 'Gg_', name, declaration, 'decl_')
  }
  // A record body can be named by several declarations -- an interface family
  // shares one layout, and `type A = B` shares it with `B` -- and the first in
  // the table's own order is the one that is found first.
  for (const [, type] of structuralTypes) {
    const shape = type.shape
    if (shape.kind !== 'declared' || shape.body === null) continue
    learn(cppRecordStructName(shape.body), 'Gr', declarationNames.get(shape.declaration), shape.body, 'type_')
  }
  // After the declared names, so a record that has both keeps its declaration's.
  for (const [shape, name] of shapeNames) learn(cppRecordStructName(shape), 'Gr', name, shape, 'type_')

  /**
   * Calls `visit` for every maximal run of identifier characters. A compound
   * name (`gea_from_dynamic_gea_record_type_298`) ends in the identity it was
   * built from, so the identity is matched as the token's tail as well as its
   * whole.
   */
  const eachToken = (text: string, visit: (start: number, end: number) => void): void => {
    let index = 0
    while (index < text.length) {
      if (!isIdentifierCharacter(text[index])) {
        index += 1
        continue
      }
      let end = index + 1
      while (end < text.length && isIdentifierCharacter(text[end])) end += 1
      visit(index, end)
      index = end
    }
  }

  /** The known identity inside a token, where it starts and where it ends. */
  const keyWithin = (token: string): { readonly key: string; readonly offset: number; readonly end: number } | null => {
    if (known.has(token)) return { key: token, offset: 0, end: token.length }
    if (token.startsWith(bodyMarker)) {
      for (let cut = token.lastIndexOf('_'); cut > bodyMarker.length; cut = token.lastIndexOf('_', cut - 1)) {
        const head = token.slice(0, cut)
        if (known.has(head)) return { key: head, offset: 0, end: cut }
      }
      return null
    }
    for (const marker of markers) {
      let at = token.indexOf(marker, 1)
      while (at > 0) {
        const tail = token.slice(at)
        if (known.has(tail)) return { key: tail, offset: at, end: token.length }
        at = token.indexOf(marker, at + 1)
      }
    }
    return null
  }

  const mentionsKnown = (token: string): boolean =>
    token.includes('gea_class_') || token.includes('gea_record_') || token.startsWith(bodyMarker) || token.startsWith('gea_global_')

  const renameAll = <Text extends string>(texts: readonly Text[]): Text[] => {
    if (known.size === 0) return [...texts]
    const present = new Set<string>()
    const occupied = new Set<string>()
    for (const text of texts) {
      eachToken(text, (start, end) => {
        const token = text.slice(start, end)
        if (token.startsWith('G')) occupied.add(token)
        if (mentionsKnown(token)) {
          const found = keyWithin(token)
          if (found !== null) present.add(found.key)
        }
      })
    }

    const renames = new Map<string, string>()
    const taken = new Set<string>()
    const claim = (name: string): boolean => {
      if (taken.has(name) || occupied.has(name)) return false
      taken.add(name)
      return true
    }
    const ordered = [...present].map((key) => known.get(key) as Candidate).sort((left, right) => left.rank - right.rank)
    // Bare names first, so that a longer spelling never takes a name some
    // other declaration is owed by rank: `Foo_937` is a legal source name too.
    const pending: Candidate[] = []
    for (const candidate of ordered) {
      const bare = `${candidate.prefix}${candidate.label}`
      if (claim(bare)) renames.set(candidate.key, bare)
      else pending.push(candidate)
    }
    for (const candidate of pending) {
      const spelled = `${candidate.prefix}${candidate.label}_${candidate.suffix}`
      if (claim(spelled)) renames.set(candidate.key, spelled)
    }

    return texts.map((text) => {
      let result = ''
      let copied = 0
      eachToken(text, (start, end) => {
        const token = text.slice(start, end)
        if (!mentionsKnown(token)) return
        const found = keyWithin(token)
        const replacement = found === null ? undefined : renames.get(found.key)
        if (found === null || replacement === undefined) return
        result += text.slice(copied, start + found.offset) + replacement
        copied = start + found.end
      })
      return (copied === 0 ? text : result + text.slice(copied)) as Text
    })
  }
  return { renameAll }
}
