import { cppRecordFieldName } from './types.js'

/**
 * Text-level respellings that make emitted C++ easier to read and change nothing
 * about what it means. Each is a pure rewrite of the finished text for the
 * reason `identifier-names.ts` states: the sites that spell these constructs are
 * too many for a parameter to reach, and a site cannot spell one wrongly when it
 * never decides.
 */

const identifierCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
const isIdentifierCharacter = (character: string | undefined): boolean =>
  character !== undefined && identifierCharacters.includes(character)

/** The index of the parenthesis closing the one at `open`, skipping string and character literals; -1 when unbalanced. */
const matchingParenthesis = (text: string, open: number): number => {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"' || character === "'") {
      index += 1
      while (index < text.length && text[index] !== character) index += text[index] === '\\' ? 2 : 1
    } else if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

const unwrapParentheses = (text: string): string => {
  let inner = text.trim()
  while (inner.startsWith('(') && matchingParenthesis(inner, 0) === inner.length - 1) inner = inner.slice(1, -1).trim()
  return inner
}

const isDigits = (text: string): boolean => text.length > 0 && [...text].every((character) => character >= '0' && character <= '9')

/**
 * `5`, `-1`, `0.25` as a `double` literal, or null. A leading zero is refused
 * because `010` is octal as an integer and `010.0` is ten: the two spell
 * different numbers, and a cast of the first must not become the second.
 */
const doubleLiteralOf = (text: string): string | null => {
  const negative = text.startsWith('-')
  const magnitude = negative ? text.slice(1) : text
  const [whole, fraction, ...rest] = magnitude.split('.')
  if (rest.length > 0 || whole === undefined || !isDigits(whole) || whole.length > 15) return null
  if (whole.length > 1 && whole.startsWith('0')) return null
  if (fraction !== undefined && (!isDigits(fraction) || fraction.length > 15)) return null
  const literal = `${whole}.${fraction ?? '0'}`
  return negative ? `(-${literal})` : literal
}

/**
 * `static_cast<double>(x)` as `gDouble(x)`, and as the bare literal when `x` is a
 * number written out -- which is exactly what the cast of one means.
 */
export const foldDoubleCasts = (text: string): string => {
  const needle = 'static_cast<double>('
  let result = ''
  let from = 0
  let at = text.indexOf(needle)
  while (at >= 0) {
    if (isIdentifierCharacter(text[at - 1])) {
      at = text.indexOf(needle, at + 1)
      continue
    }
    const open = at + needle.length - 1
    const close = matchingParenthesis(text, open)
    if (close < 0) break
    const inner = foldDoubleCasts(text.slice(open + 1, close))
    result += text.slice(from, at) + (doubleLiteralOf(unwrapParentheses(inner)) ?? `gDouble(${inner})`)
    from = close + 1
    at = text.indexOf(needle, from)
  }
  return from === 0 ? text : result + text.slice(from)
}

const throwHelpers: ReadonlyArray<readonly [name: string, kind: string, message: string]> = [
  ['gThrowRedefine', 'TypeError', 'Cannot redefine property'],
  ['gThrowRO', 'TypeError', 'Cannot assign to read only property'],
  ['gThrowItUndefined', 'TypeError', 'Iterator value undefined is not an entry object']
]

const throwCall = (kind: string, message: string): string => `gea::host::throwRuntimeError("${kind}", "${message}")`

export const throwHelperDefinitions: readonly string[] = throwHelpers.map(
  ([name, kind, message]) => `[[noreturn]] inline void ${name}() { ${throwCall(kind, message)}; }`
)

export const foldThrowHelpers = (text: string): string => {
  let result = text
  for (const [name, kind, message] of throwHelpers) result = result.split(throwCall(kind, message)).join(`${name}()`)
  return result
}

/**
 * `definePropertyFrom(k, v, true, true, true)` as `definePropertyFrom(k, v)`:
 * the runtime's three trailing attributes default to `true`.
 */
export const dropDefaultedAttributes = (text: string): string => {
  const needle = 'definePropertyFrom('
  const suffix = ', true, true, true'
  let result = ''
  let from = 0
  let at = text.indexOf(needle)
  while (at >= 0) {
    const open = at + needle.length - 1
    const close = matchingParenthesis(text, open)
    if (close < 0) break
    if (text.slice(open + 1, close).endsWith(suffix)) {
      result += text.slice(from, close - suffix.length)
      from = close
    }
    at = text.indexOf(needle, close)
  }
  return from === 0 ? text : result + text.slice(from)
}

/** What one line of emitted C++ does to the nesting of braces. A `namespace` line, a preprocessor line and the inside of a block comment do not count. */
interface LineShape {
  /** The depth the line's own statement sits at: the depth on entry, less a `}` the line starts with. */
  readonly level: number
  /** The depth after the line. */
  readonly after: number
  /** A preprocessor line, a `namespace` line or part of a block comment: it is never indented and does not change the depth. */
  readonly skipped: boolean
}

/**
 * Brace depth per line, counted outside string literals, character literals and comments. `null` when the
 * text has a raw string literal, which runs across lines in a way this scan does not follow.
 */
const shapesOfLines = (lines: readonly string[]): LineShape[] | null => {
  let depth = 0
  let inBlockComment = false
  let rawString = false
  const shapes = lines.map((line): LineShape => {
    const unchanged = { level: depth, after: depth, skipped: true }
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false
      return unchanged
    }
    if (line.startsWith('#')) return unchanged
    const isNamespaceLine = (line.startsWith('namespace') && line.endsWith('{')) || line.startsWith('}  // namespace')
    let opens = 0
    let closes = 0
    let leadingCloses = 0
    let counting = true
    for (let index = 0; index < line.length && counting; index += 1) {
      const character = line[index]
      if (character === '"' || character === "'") {
        if (character === "'" && index > 0 && isIdentifierCharacter(line[index - 1])) continue
        if (character === '"' && line[index - 1] === 'R' && !isIdentifierCharacter(line[index - 2])) rawString = true
        index += 1
        while (index < line.length && line[index] !== character) index += line[index] === '\\' ? 2 : 1
      } else if (character === '/' && line[index + 1] === '/') counting = false
      else if (character === '/' && line[index + 1] === '*') {
        const end = line.indexOf('*/', index + 2)
        if (end < 0) {
          inBlockComment = true
          counting = false
        } else index = end + 1
      } else if (character === '{') opens += 1
      else if (character === '}') {
        closes += 1
        if (opens === 0 && line.slice(0, index).trim() === '') leadingCloses += 1
      }
    }
    if (isNamespaceLine) return unchanged
    const shape = { level: Math.max(0, depth - leadingCloses), after: Math.max(0, depth + opens - closes), skipped: false }
    depth = shape.after
    return shape
  })
  return rawString ? null : shapes
}

const isLabelLine = (line: string): boolean => {
  if (!line.endsWith(':') || line.includes(' ') || line.startsWith('case') || line === 'default:') return false
  const name = line.slice(0, -1)
  return [...name].every(isIdentifierCharacter) && name !== 'public' && name !== 'private' && name !== 'protected'
}

/**
 * Indents the lines of a block that the emitter wrote flush left.
 *
 * Only a line that has no indentation of its own is touched, and only by adding
 * leading spaces, so a struct's own layout and every continuation line stay
 * exactly as they were. Depth counts braces outside string literals, character
 * literals and comments; a `namespace` is not a level, and a label (`block3:`)
 * sits one level out from the statements it labels.
 */
export const indentBlocks = (text: string): string => {
  const lines = text.split('\n')
  const shapes = shapesOfLines(lines)
  if (shapes === null) return text
  return lines
    .map((line, index) => {
      const shape = shapes[index] as LineShape
      const level = Math.max(0, shape.level - (isLabelLine(line) ? 1 : 0))
      return shape.skipped || line === '' || line[0] === ' ' || line[0] === '\t' || level === 0 ? line : `${'  '.repeat(level)}${line}`
    })
    .join('\n')
}

/** Names a parameter may not take: another meaning already attached to the spelling, in the language or in the headers a build pulls in. */
const reservedParameterNames = new Set(['near', 'far', 'small', 'interface', 'min', 'max', 'pascal', 'cdecl', 'gea', 'std'])

const parameterNameIsSafe = (name: string): boolean =>
  cppRecordFieldName(name) === name &&
  !reservedParameterNames.has(name) &&
  !name.startsWith('gea') &&
  !(name[0] === 'g' && name[1] !== undefined && name[1] >= 'A' && name[1] <= 'Z') &&
  !(name[0] === 'G' && (name[1] === 'r' || name[1] === 'c' || name[1] === 'f' || name[1] === 'g'))

const eachIdentifier = (text: string, visit: (token: string, start: number, end: number) => void): void => {
  let index = 0
  while (index < text.length) {
    if (!isIdentifierCharacter(text[index])) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < text.length && isIdentifierCharacter(text[end])) end += 1
    visit(text.slice(index, end), index, end)
    index = end
  }
}

/** Whether an identifier at `start` is a member or a qualified name, which never meets a local of the same spelling. */
const isMemberOrQualified = (text: string, start: number): boolean =>
  text[start - 1] === '.' || (text[start - 1] === '>' && text[start - 2] === '-') || (text[start - 1] === ':' && text[start - 2] === ':')

/**
 * The texts of ONE body with `gea_arg_N` spelled as the parameter's own name.
 *
 * Safe by construction rather than by trust: a name is taken only if nothing in
 * any of the body's texts already uses it as an identifier -- a member named
 * after the parameter (`x->x`) does not count, since a member never meets a
 * local -- and a position the source did not name (a pattern) keeps `gea_arg_N`.
 */
export const nameBodyParameters = (texts: readonly string[], names: readonly (string | null)[]): readonly string[] => {
  const used = new Set<string>()
  for (const text of texts) eachIdentifier(text, (token, start) => (isMemberOrQualified(text, start) ? undefined : used.add(token)))
  const chosen = new Map<string, string>()
  const taken = new Set<string>()
  names.forEach((name, ordinal) => {
    const formal = `gea_arg_${ordinal}`
    if (name === null || !used.has(formal) || used.has(name) || taken.has(name) || !parameterNameIsSafe(name)) return
    taken.add(name)
    chosen.set(formal, name)
  })
  if (chosen.size === 0) return texts
  return texts.map((text) => {
    let result = ''
    let copied = 0
    eachIdentifier(text, (token, start, end) => {
      const replacement = chosen.get(token)
      if (replacement === undefined || isMemberOrQualified(text, start)) return
      result += text.slice(copied, start) + replacement
      copied = end
    })
    return copied === 0 ? text : result + text.slice(copied)
  })
}

const firstIndexOfAny = (text: string, characters: string, from: number): number => {
  for (let index = from; index < text.length; index += 1) if (characters.includes(text[index] as string)) return index
  return -1
}

/** What a binding cell of the given C++ type holds, as a word, for a cell the source did not name. */
const prefixOfType = (type: string): string | null => {
  if (type === 'double' || type === 'float') return 'num'
  if (type === 'long long' || type === 'int') return 'int'
  if (type === 'bool') return 'flag'
  if (type === 'gString') return 'str'
  if (type === 'gValue') return 'val'
  if (type.startsWith('gRef<gArray<') || type.startsWith('gRef<gTypedArray<')) return 'arr'
  if (type.startsWith('gRef<gDictionary<')) return 'dict'
  if (type.startsWith('gRef<gMap<')) return 'map'
  if (type.startsWith('gRef<gSet<')) return 'set'
  if (type.startsWith('gCallable<')) return 'fn'
  if (type.startsWith('gOptional<')) return 'opt'
  if (type.startsWith('gVector<')) return 'vec'
  if (type.startsWith('gRef<Gr') || type.startsWith('gRef<Gc')) {
    const start = 'gRef<Gr'.length
    const end = firstIndexOfAny(type, '<>,', start)
    const label = type.slice(start, end < 0 ? undefined : end)
    return label === '' || !isIdentifierCharacter(label[0]) ? null : label[0]!.toLowerCase() + label.slice(1)
  }
  return null
}

/**
 * The texts of ONE body with each binding cell (`b22`) spelled as the variable it was in the source, or, for
 * a cell the source did not name, as a word for what it holds and its ordinal (`num22`, `arr1`, `fn26`).
 *
 * A source name is taken only when nothing in the body already uses it and no earlier cell took it, so two
 * variables that shadowed each other in the source stay two variables here. A cell whose declaration line
 * cannot be found keeps its `bN`.
 */
export const nameBodyBindings = (texts: readonly string[], bindings: ReadonlyMap<string, string | null>): readonly string[] => {
  if (bindings.size === 0) return texts
  const used = new Set<string>()
  for (const text of texts) eachIdentifier(text, (token, start) => (isMemberOrQualified(text, start) ? undefined : used.add(token)))
  // The type each cell was declared with: `<type> b22;` on a line of its own.
  const typeOf = new Map<string, string>()
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.endsWith(';') || trimmed.includes(' = ')) continue
      const split = trimmed.lastIndexOf(' ')
      if (split < 0) continue
      const cell = trimmed.slice(split + 1, -1)
      if (bindings.has(cell) && !typeOf.has(cell)) typeOf.set(cell, trimmed.slice(0, split).trim())
    }
  }
  const ordinalOf = (cell: string): string => cell.slice(1)
  const chosen = new Map<string, string>()
  const taken = new Set<string>()
  const ordered = [...bindings].sort(([left], [right]) => Number(ordinalOf(left)) - Number(ordinalOf(right)))
  for (const [cell, source] of ordered) {
    if (!used.has(cell) || !typeOf.has(cell)) continue
    const free = (name: string): boolean => !used.has(name) && !taken.has(name)
    let name: string | null = null
    if (source !== null && parameterNameIsSafe(source)) {
      if (free(source)) name = source
      else if (free(`${source}_${ordinalOf(cell)}`)) name = `${source}_${ordinalOf(cell)}`
    }
    if (name === null) {
      const prefix = prefixOfType(typeOf.get(cell) as string)
      const typed = prefix === null ? null : `${prefix}${ordinalOf(cell)}`
      if (typed !== null && parameterNameIsSafe(typed) && free(typed)) name = typed
    }
    if (name === null) continue
    taken.add(name)
    chosen.set(cell, name)
  }
  if (chosen.size === 0) return texts
  return texts.map((text) => {
    let result = ''
    let copied = 0
    eachIdentifier(text, (token, start, end) => {
      const replacement = chosen.get(token)
      if (replacement === undefined || isMemberOrQualified(text, start)) return
      result += text.slice(copied, start) + replacement
      copied = end
    })
    return copied === 0 ? text : result + text.slice(copied)
  })
}

const wordsBeforeParenthesisThatKeepItMeaningful = new Set([
  'decltype',
  'sizeof',
  'alignof',
  'alignas',
  'typeid',
  'noexcept',
  'requires',
  '__attribute__',
  '__declspec',
  'asm',
  '__asm__'
])

/**
 * `(x)` as `x` where `x` is one identifier or number and the parentheses cannot mean anything else, and
 * `name = (a / b);` as `name = a / b;`.
 *
 * What the parentheses could mean otherwise is the whole list of reasons not to touch them: a call
 * (`f(x)`), a cast (`(T)x`), `decltype((x))`, a template argument or `sizeof`. The test is on the characters
 * around the pair, so a spelling it does not recognise is left exactly as it was.
 */
export const unwrapRedundantParentheses = (text: string): string => {
  const unwrapAtoms = (input: string): string => {
    let result = ''
    let copied = 0
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index]
      if (character === '"' || character === "'") {
        if (character === "'" && index > 0 && isIdentifierCharacter(input[index - 1])) continue
        index += 1
        while (index < input.length && input[index] !== character) index += input[index] === '\\' ? 2 : 1
        continue
      }
      if (character !== '(') continue
      let end = index + 1
      while (end < input.length && isIdentifierCharacter(input[end])) end += 1
      if (end === index + 1 || input[end] !== ')') continue
      const atom = input.slice(index + 1, end)
      const first = atom[0] as string
      const numeric = first >= '0' && first <= '9'
      // What comes before: an operator or a separator, never a name, a closing bracket or `>`.
      let before = index - 1
      while (before >= 0 && input[before] === ' ') before -= 1
      const previous = before < 0 ? '' : (input[before] as string)
      if (previous === '' || !'(,={;?:+-*/%&|^!~'.includes(previous)) continue
      if (previous === '(') {
        let word = before - 1
        while (word >= 0 && input[word] === ' ') word -= 1
        let wordStart = word
        while (wordStart >= 0 && isIdentifierCharacter(input[wordStart])) wordStart -= 1
        if (wordsBeforeParenthesisThatKeepItMeaningful.has(input.slice(wordStart + 1, word + 1))) continue
      }
      // What comes after: an operator or a separator, or a member access on a name. Not an operand (a cast).
      let after = end + 1
      while (after < input.length && input[after] === ' ') after += 1
      const next = after < input.length ? (input[after] as string) : ''
      const memberAccess = !numeric && (next === '.' || (next === '-' && input[after + 1] === '>') || next === '[')
      if (!(memberAccess || next === '' || ')],;}+*/%<>=!&|^?:'.includes(next))) continue
      result += input.slice(copied, index) + atom
      copied = end + 1
      index = end
    }
    return copied === 0 ? input : result + input.slice(copied)
  }
  const withoutAtoms = unwrapAtoms(unwrapAtoms(text))
  return withoutAtoms
    .split('\n')
    .map((line) => {
      const indent = line.length - line.trimStart().length
      const body = line.slice(indent)
      const equals = body.indexOf(' = (')
      if (equals <= 0 || !body.endsWith(');')) return line
      const name = body.slice(0, equals)
      if (![...name].every(isIdentifierCharacter)) return line
      const open = indent + equals + 3
      if (matchingParenthesis(line, open) !== line.length - 2) return line
      const inner = line.slice(open + 1, line.length - 2)
      // A comma at the top level is the comma operator, which the parentheses keep from ending the statement.
      let depth = 0
      for (let index = 0; index < inner.length; index += 1) {
        const character = inner[index] as string
        if (character === '"' || character === "'") {
          index += 1
          while (index < inner.length && inner[index] !== character) index += inner[index] === '\\' ? 2 : 1
        } else if ('([{<'.includes(character)) depth += 1
        else if (')]}>'.includes(character)) depth -= 1
        else if (character === ',' && depth <= 0) return line
      }
      return `${line.slice(0, open)}${inner};`
    })
    .join('\n')
}

const mergeableTypes = ['double ', 'long long ', 'bool ', 'int ', 'gString ', 'gRef<']

/** The label a line defines (`block4:` or `block4: ;`), or null. */
const labelDefinedBy = (trimmed: string): string | null => {
  const colon = trimmed.indexOf(':')
  if (colon <= 0 || (trimmed[colon + 1] !== undefined && trimmed[colon + 1] !== ' ')) return null
  const name = trimmed.slice(0, colon)
  return [...name].every(isIdentifierCharacter) &&
    name.startsWith('block') &&
    (colon + 1 === trimmed.length || trimmed.slice(colon + 1).trim() === ';')
    ? name
    : null
}

/** Every label a line jumps to. */
const gotoTargetsInLine = (line: string): string[] => {
  const targets: string[] = []
  for (let at = line.indexOf('goto '); at >= 0; at = line.indexOf('goto ', at + 5)) {
    if (isIdentifierCharacter(line[at - 1])) continue
    let end = at + 5
    while (end < line.length && isIdentifierCharacter(line[end])) end += 1
    if (end > at + 5) targets.push(line.slice(at + 5, end))
  }
  return targets
}

/**
 * `double x;` ... `x = a / b;` as `double x = a / b;`.
 *
 * Both ends must be at the same indentation (the same block), the assignment must be the first line that
 * names the variable, and its right side must not name it. Only the types whose initialisation from another
 * value is the same copy their assignment was are merged.
 *
 * A declaration with an initialiser may not be jumped over, which is why the emitter declares everything at
 * the head of its scope. Moving it to the assignment is legal only if no `goto` that sits before that line in
 * the same scope lands on a label after it: such a jump would enter the rest of the scope past the new
 * initialisation. Jumps backwards (a loop's `goto block1`) and jumps that leave the scope do not cross it. A
 * function with a `switch` is left alone.
 */
export const mergeDeclarations = (text: string): string => {
  const lines = text.split('\n')
  const shapes = shapesOfLines(lines)
  if (shapes === null) return text
  const removed = new Set<number>()
  let functionStart = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (functionStart < 0) {
      if (line !== '' && line[0] !== ' ' && line[0] !== '}' && line[0] !== '#' && line.endsWith(' {')) functionStart = index
      continue
    }
    if (line !== '}') continue
    const first = functionStart
    const range = lines.slice(functionStart, index + 1)
    functionStart = -1
    if (range.some((entry) => entry.includes('switch (') || entry.trimStart().startsWith('case '))) continue
    // Where each name occurs, as a line offset, ignoring members and qualified names; and where jumps start and land.
    const occurrences = new Map<string, number[]>()
    const labelLine = new Map<string, number>()
    const jumps: { readonly from: number; readonly to: string }[] = []
    range.forEach((entry, offset) => {
      eachIdentifier(entry, (token, start) => {
        if (isMemberOrQualified(entry, start)) return
        const found = occurrences.get(token)
        if (found === undefined) occurrences.set(token, [offset])
        else if (found[found.length - 1] !== offset) found.push(offset)
      })
      const label = labelDefinedBy(entry.trim())
      if (label !== null) labelLine.set(label, offset)
      for (const to of gotoTargetsInLine(entry)) jumps.push({ from: offset, to })
    })
    /** The line where the block holding `offset` ends, and where it begins (the line whose `{` opened it). */
    const scopeOf = (offset: number): { readonly start: number; readonly end: number } => {
      const depth = (shapes[first + offset] as LineShape).level
      let start = 0
      for (let up = offset - 1; up >= 0; up -= 1) {
        const shape = shapes[first + up] as LineShape
        if (!shape.skipped && shape.after === depth && shape.level === depth - 1) {
          start = up
          break
        }
      }
      let end = range.length - 1
      for (let down = offset + 1; down < range.length; down += 1) {
        const shape = shapes[first + down] as LineShape
        if (!shape.skipped && shape.level < depth) {
          end = down
          break
        }
      }
      return { start, end }
    }
    const crossed = (offset: number): boolean => {
      const { start, end } = scopeOf(offset)
      return jumps.some((jump) => {
        const lands = labelLine.get(jump.to)
        return jump.from > start && jump.from < offset && lands !== undefined && lands > offset && lands <= end
      })
    }
    range.forEach((entry, offset) => {
      const indent = entry.length - entry.trimStart().length
      const trimmed = entry.slice(indent)
      const depth = (shapes[first + offset] as LineShape).level
      if (depth === 0 || !trimmed.endsWith(';') || trimmed.includes(' = ') || !mergeableTypes.some((type) => trimmed.startsWith(type)))
        return
      const split = trimmed.lastIndexOf(' ')
      const name = trimmed.slice(split + 1, -1)
      if (name === '' || ![...name].every(isIdentifierCharacter)) return
      const next = occurrences.get(name)?.find((candidate) => candidate > offset)
      if (next === undefined) return
      const user = range[next] as string
      const userIndent = user.length - user.trimStart().length
      const prefix = `${name} = `
      if (!user.slice(userIndent).startsWith(prefix) || !user.endsWith(';')) return
      // The same block, not merely the same indentation: it is still open at the assignment, which is in it and not in a block it contains.
      if ((shapes[first + next] as LineShape).level !== depth) return
      for (let between = offset + 1; between < next; between += 1) {
        const shape = shapes[first + between] as LineShape
        if (!shape.skipped && shape.level < depth) return
      }
      const right = user.slice(userIndent + prefix.length, -1)
      let mentionsItself = false
      eachIdentifier(right, (token, start) => {
        if (token === name && !isMemberOrQualified(right, start)) mentionsItself = true
      })
      if (mentionsItself || removed.has(first + next) || crossed(next)) return
      lines[first + next] = `${user.slice(0, userIndent)}${trimmed.slice(0, split)} ${name} = ${right};`
      removed.add(first + offset)
    })
  }
  return removed.size === 0 ? text : lines.filter((_, index) => !removed.has(index)).join('\n')
}

/**
 * A function that writes a source file's path relative to the directory the program's own files share, with
 * forward slashes: `src/ai/jardinouAI.ts`. Files under `node_modules` and the compiler's library files do not
 * count towards that directory. Display only.
 */
export const displayPathsOf = (files: readonly string[]): ((file: string) => string) => {
  const normalized = files
    .map((file) => file.split('\\').join('/'))
    .filter((file) => !file.includes('/node_modules/') && !file.includes('/typescript/lib/'))
  const directories = normalized.map((file) => file.split('/').slice(0, -1))
  let common = directories[0] ?? []
  for (const directory of directories) {
    let shared = 0
    while (shared < common.length && shared < directory.length && common[shared] === directory[shared]) shared += 1
    common = common.slice(0, shared)
  }
  const root = common.length === 0 ? '' : `${common.join('/')}/`
  return (file) => {
    const path = file.split('\\').join('/')
    return root !== '' && path.startsWith(root) ? path.slice(root.length) : path
  }
}

/** The word a value's initialiser says it is: the member it reads (`gea_this->hugT`, `b2.x`) or the function it calls (`gea::runtime::string::trim(s)`). */
const wordOfInitialiser = (expression: string): string | null => {
  const text = expression.trim()
  if (text === '') return null
  // `a->b`, `a.b`, `*a.b`: one access path and nothing else.
  const lastDot = Math.max(text.lastIndexOf('.'), text.lastIndexOf('>'))
  const member = text.slice(lastDot + 1)
  if (lastDot > 0 && [...member].every(isIdentifierCharacter) && member !== '' && !member.startsWith('gea_')) {
    const owner = text.slice(0, lastDot + (text[lastDot] === '>' ? -1 : 0))
    if (owner !== '' && [...owner].every((character) => isIdentifierCharacter(character) || '.:-*&'.includes(character))) return member
  }
  // `gea::makeRef<GrPose>()`: a new record or class instance, named by its type.
  const made = text.indexOf('makeRef<Gr') >= 0 ? text.indexOf('makeRef<Gr') : text.indexOf('makeRef<Gc')
  if (made >= 0 && text.slice(0, made) === 'gea::' && text.endsWith('>()')) {
    const label = text.slice(made + 'makeRef<Gr'.length, text.length - 3)
    if (label !== '' && [...label].every(isIdentifierCharacter)) return label[0]!.toLowerCase() + label.slice(1)
  }
  // `ns::name(arguments)`: a call, named by its last qualified part.
  const open = text.indexOf('(')
  if (open > 0 && text.endsWith(')') && matchingParenthesis(text, open) === text.length - 1) {
    const callee = text.slice(0, open)
    if (![...callee].every((character) => isIdentifierCharacter(character) || character === ':')) return null
    const name = callee.slice(callee.lastIndexOf(':') + 1)
    if (name === '' || name.startsWith('gea_') || name === 'move' || name === 'forward' || name === 'static_cast') return null
    return name === 'fabs' ? 'abs' : name
  }
  return null
}

/**
 * `double v46 = b20 / v47;` keeps its SSA number but says what it holds: `v46` stays when the initialiser says
 * nothing, and becomes `abs46` or `hugT46` when it is a call or a member read. The number stays because it is
 * what keeps two values of one function apart; the word is only for the reader.
 *
 * A name is taken only if nothing else in the function already uses it. Applied per function, since `vN` restarts in
 * each, and only to values declared with an initialiser on one line.
 */
export const nameValues = (text: string): string => {
  const lines = text.split('\n')
  let functionStart = -1
  const renamedLines = new Map<number, string>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (functionStart < 0) {
      if (line !== '' && line[0] !== ' ' && line[0] !== '}' && line[0] !== '#' && line.endsWith(' {')) functionStart = index
      continue
    }
    if (line !== '}') continue
    const first = functionStart
    functionStart = -1
    const range = lines.slice(first, index + 1)
    const used = new Set<string>()
    for (const entry of range) eachIdentifier(entry, (token, start) => (isMemberOrQualified(entry, start) ? undefined : used.add(token)))
    const chosen = new Map<string, string>()
    for (const entry of range) {
      const trimmed = entry.trim()
      const equals = trimmed.indexOf(' = ')
      if (equals < 0 || !trimmed.endsWith(';')) continue
      const left = trimmed.slice(0, equals)
      const split = left.lastIndexOf(' ')
      const cell = left.slice(split + 1)
      if (split < 0 || cell[0] !== 'v' || !isDigits(cell.slice(1)) || chosen.has(cell)) continue
      const word = wordOfInitialiser(trimmed.slice(equals + 3, -1))
      const name = word === null ? null : `${word}${cell.slice(1)}`
      if (name === null || used.has(name) || !parameterNameIsSafe(name)) continue
      used.add(name)
      chosen.set(cell, name)
    }
    if (chosen.size === 0) continue
    range.forEach((entry, offset) => {
      let result = ''
      let copied = 0
      eachIdentifier(entry, (token, start, end) => {
        const replacement = chosen.get(token)
        if (replacement === undefined || isMemberOrQualified(entry, start)) return
        result += entry.slice(copied, start) + replacement
        copied = end
      })
      if (copied !== 0) renamedLines.set(first + offset, result + entry.slice(copied))
    })
  }
  return renamedLines.size === 0 ? text : lines.map((line, index) => renamedLines.get(index) ?? line).join('\n')
}
