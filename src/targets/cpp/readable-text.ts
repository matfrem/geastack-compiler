import { structuredJumpsIn } from './emit-loops.js'
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
    // A string literal is text, not a name: `"deck"` must not make a parameter called `deck` look taken.
    if (text[index] === '"') {
      index += 1
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
      index += 1
      continue
    }
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

/**
 * The first line of a function definition: unindented, opening a body, with a parameter list. A `struct X final {`
 * also opens a brace at the margin but closes with `};`, so taking it for a function would leave the "current
 * function" open across the next real one.
 */
const isFunctionHeader = (line: string): boolean =>
  line !== '' &&
  line[0] !== ' ' &&
  line[0] !== '}' &&
  line[0] !== '#' &&
  line.endsWith(' {') &&
  line.includes('(') &&
  !['struct ', 'class ', 'union ', 'enum ', 'namespace ', 'extern '].some((word) => line.startsWith(word))

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
      const quoted = input[end] === '"'
      const startsWithDigit = input[end] !== undefined && (input[end] as string) >= '0' && (input[end] as string) <= '9'
      if (quoted) {
        // A string literal is a primary expression: nothing the parentheses could group.
        end += 1
        while (end < input.length && input[end] !== '"') end += input[end] === '\\' ? 2 : 1
        end += 1
      } else {
        while (end < input.length && (isIdentifierCharacter(input[end]) || (startsWithDigit && input[end] === '.'))) end += 1
      }
      if (end === index + 1 || input[end] !== ')') continue
      const atom = input.slice(index + 1, end)
      const first = atom[0] as string
      const numeric = (first >= '0' && first <= '9') || quoted
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
      if (isFunctionHeader(line)) functionStart = index
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
      if (isFunctionHeader(line)) functionStart = index
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

/** The name a declaration statement (`T name = ...;`, `T name;`) introduces, or null for any other statement. */
const declaredNameOf = (trimmed: string): string | null => {
  if (!trimmed.endsWith(';') || trimmed.startsWith('{') || trimmed.startsWith('return ') || trimmed.startsWith('goto ')) return null
  const equals = trimmed.indexOf(' = ')
  const left = equals >= 0 ? trimmed.slice(0, equals) : trimmed.slice(0, -1)
  const split = left.lastIndexOf(' ')
  const name = left.slice(split + 1)
  if (split < 0 || name === '' || ![...name].every(isIdentifierCharacter) || left.slice(0, split).includes('(')) return null
  return name
}

/**
 * A function whose whole body after a few statements is one `{ ... }` block: the block was the scope of everything
 * the last label dominates, and nothing else shares it, so its braces and one level of indentation are noise. Only
 * when no name declared directly in the block is already spelled before it.
 */
export const unwrapFunctionBlock = (text: string): string => {
  const lines = text.split('\n')
  const shapes = shapesOfLines(lines)
  if (shapes === null) return text
  const removed = new Set<number>()
  const dedented = new Set<number>()
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (start < 0) {
      if (isFunctionHeader(line)) start = index
      continue
    }
    if (line !== '}') continue
    const header = start
    start = -1
    // The block is the last statement: its closing brace is the line before the function's.
    if (lines[index - 1] !== '  }') continue
    const close = index - 1
    let open = -1
    for (let at = close - 1; at > header && open < 0; at -= 1) {
      if (lines[at] === '  {' && (shapes[at] as LineShape).level === (shapes[close] as LineShape).level) open = at
    }
    if (open < 0) continue
    const before = new Set<string>()
    for (let at = header; at < open; at += 1)
      eachIdentifier(lines[at] as string, (token, from) => (isMemberOrQualified(lines[at] as string, from) ? undefined : before.add(token)))
    let clash = false
    for (let at = open + 1; at < close; at += 1) {
      const entry = lines[at] as string
      if (entry.startsWith('    ') && entry[4] !== ' ') {
        const name = declaredNameOf(entry.trim())
        if (name !== null && before.has(name)) clash = true
      }
    }
    if (clash) continue
    removed.add(open)
    removed.add(close)
    for (let at = open + 1; at < close; at += 1)
      if (!(shapes[at] as LineShape).skipped && (lines[at] as string).startsWith('  ')) dedented.add(at)
  }
  if (removed.size === 0) return text
  return lines.flatMap((line, index) => (removed.has(index) ? [] : [dedented.has(index) ? line.slice(2) : line])).join('\n')
}

const scalarTypes = ['double', 'bool', 'long long', 'int']

/**
 * A parameter with a default, which the printer lowers as a diamond of two gotos:
 *
 *     double v0;  if (!(p.has_value())) goto block2;  v0 = (*p);  goto block3;  block2:  v0 = 0;  block3:
 *
 * becomes `double pDefault = p.has_value() ? (*p) : 0;`. Only when the default is one assignment of a scalar or a
 * string (a `?:` needs both arms to agree, and a handle's arms may not) and neither label is jumped to from anywhere
 * else in the function.
 */
export const foldDefaultedParameters = (text: string): string => {
  const lines = text.split('\n')
  const typeOk = (type: string): boolean => scalarTypes.includes(type) || type === 'gString' || type === 'std::string'
  const renames = new Map<number, { readonly from: number; readonly cell: string; readonly target: string }>()
  const dropped = new Set<number>()
  const replaced = new Map<number, string>()
  let functionStart = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (isFunctionHeader(line)) functionStart = index
    else if (line === '}') functionStart = -1
    const test = line.trim()
    const guard = test.startsWith('if (!(') && test.includes('.has_value())) goto ') ? test.slice('if (!('.length) : null
    if (guard === null || functionStart < 0 || index + 5 >= lines.length) continue
    const next = lines.slice(index + 1, index + 6).map((entry) => entry.trim())
    const written = guard.slice(0, guard.indexOf('.has_value()'))
    const parameter = written.startsWith('(') && written.endsWith(')') ? written.slice(1, -1) : written
    const skip = guard.slice(guard.indexOf('goto ') + 5, -1)
    const [assignRead, jump, label, assignDefault, join] = next as [string, string, string, string, string]
    const cell = assignRead.slice(0, assignRead.indexOf(' = '))
    const defined = (statement: string): string | null =>
      statement.startsWith(`${cell} = `) && statement.endsWith(';') ? statement.slice(cell.length + 3, -1) : null
    const taken = defined(assignRead)
    const fallback = defined(assignDefault)
    const joinLabel = jump.startsWith('goto ') && jump.endsWith(';') ? jump.slice(5, -1) : null
    if (
      parameter === '' ||
      ![...parameter].every(isIdentifierCharacter) ||
      cell === '' ||
      !isDigits(cell.slice(1)) ||
      taken === null ||
      fallback === null ||
      joinLabel === null ||
      label !== `${skip}:` ||
      join !== `${joinLabel}:` ||
      !taken.includes(parameter)
    )
      continue
    let end = index + 6
    while (end < lines.length && lines[end] !== '}') end += 1
    // The two labels are the whole diamond only if nothing else in the function names them, and the cell must be
    // declared with a type a conditional can carry.
    let jumpedElsewhere = false
    let declaredType: string | null = null
    let used = false
    const name = `${parameter}_default`
    for (let at = functionStart; at <= end; at += 1) {
      if (at >= index && at < index + 6) continue
      const entry = lines[at] as string
      eachIdentifier(entry, (token) => {
        if (token === skip || token === joinLabel) jumpedElsewhere = true
        if (token === name) used = true
      })
      const trimmed = entry.trim()
      if (at < index && trimmed.endsWith(` ${cell};`) && typeOk(trimmed.slice(0, -cell.length - 2)))
        declaredType = trimmed.slice(0, -cell.length - 2)
    }
    if (jumpedElsewhere || declaredType === null) continue
    const indent = line.slice(0, line.length - line.trimStart().length)
    const target = used || !parameterNameIsSafe(name) ? cell : name
    replaced.set(index, `${indent}${cell} = ${parameter}.has_value() ? ${taken} : ${fallback};`)
    for (let at = index + 1; at < index + 6; at += 1) dropped.add(at)
    if (target !== cell) renames.set(index, { from: functionStart, cell, target })
    index += 5
  }
  for (const [at, { from, cell, target }] of renames) {
    let end = at
    while (end < lines.length && lines[end] !== '}') end += 1
    for (let row = from; row <= end; row += 1) {
      const entry = replaced.get(row) ?? (lines[row] as string)
      let out = ''
      let copied = 0
      eachIdentifier(entry, (token, start, tokenEnd) => {
        if (token !== cell || isMemberOrQualified(entry, start)) return
        out += entry.slice(copied, start) + target
        copied = tokenEnd
      })
      if (copied !== 0) replaced.set(row, out + entry.slice(copied))
    }
  }
  if (replaced.size === 0) return text
  return lines.flatMap((line, index) => (dropped.has(index) ? [] : [replaced.get(index) ?? line])).join('\n')
}

/** The text after a name that reaches the assignment of that name: `= `, `+= `, `++`, `--`; `==` and `=>` are reads. */
const writesAfter = (text: string, end: number): boolean => {
  let at = end
  while (text[at] === ' ') at += 1
  const next = text[at]
  const after = text[at + 1]
  if (next === '=') return after !== '=' && after !== '>'
  if ('+-*/%&|^'.includes(next ?? '#') && after === '=') return true
  return (
    (next === '+' && after === '+') ||
    (next === '-' && after === '-') ||
    (next === '<' && after === '<' && text[at + 2] === '=') ||
    (next === '>' && after === '>' && text[at + 2] === '=')
  )
}

/**
 * `double v3 = color;` where `color` is a scalar of the same type that nothing in the function ever writes or takes
 * the address of, and `v3` is itself never written: the copy is the name, so the statement goes and `v3` reads
 * `color`. The shorthand `{color, emissive: color}` made one copy per read of the property, which the C++ compiler
 * folds away and a reader cannot.
 *
 * Scalars only. A copied `Ref` is a retained handle, and dropping it would change when the object dies.
 */
export const inlineScalarCopies = (text: string): string => {
  const lines = text.split('\n')
  let functionStart = -1
  const dropped = new Set<number>()
  const replaced = new Map<number, string>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (functionStart < 0) {
      if (isFunctionHeader(line)) functionStart = index
      continue
    }
    if (line !== '}') continue
    const first = functionStart
    functionStart = -1
    const range = lines.slice(first, index + 1)
    const copies: Array<{ readonly at: number; readonly type: string; readonly cell: string; readonly source: string }> = []
    range.forEach((entry, offset) => {
      const trimmed = entry.trim()
      const type = scalarTypes.find((candidate) => trimmed.startsWith(`${candidate} `))
      if (type === undefined || !trimmed.endsWith(';')) return
      const equals = trimmed.indexOf(' = ')
      const cell = trimmed.slice(type.length + 1, equals)
      const source = trimmed.slice(equals + 3, -1)
      if (
        equals < 0 ||
        (!(cell[0] === 'v' && isDigits(cell.slice(1))) && !source.endsWith('_default')) ||
        source === '' ||
        ![...source].every(isIdentifierCharacter)
      )
        return
      if (isDigits(source[0] as string) || source === cell) return
      copies.push({ at: offset, type, cell, source })
    })
    if (copies.length === 0) continue
    const declarations = new Map<string, number>()
    const spoiled = new Set<string>()
    for (const entry of range) {
      eachIdentifier(entry, (token, start, end) => {
        if (isMemberOrQualified(entry, start)) return
        const before = entry.slice(0, start)
        if (before.endsWith('&') || before.endsWith('++') || before.endsWith('--') || writesAfter(entry, end)) {
          // `T& x`, `&x`, `++x`, `x = ...`: the declaration itself ends in `= ` when it has an initialiser, so only a
          // statement that is not a declaration of the name counts as a write.
          const declares = scalarTypes.some((type) => before.endsWith(`${type} `))
          if (!declares) spoiled.add(token)
        }
        if (scalarTypes.some((type) => before.endsWith(`${type} `))) declarations.set(token, (declarations.get(token) ?? 0) + 1)
      })
    }
    const chosen = new Map<string, string>()
    for (const copy of copies) {
      if (spoiled.has(copy.cell) || spoiled.has(copy.source) || declarations.get(copy.cell) !== 1 || declarations.get(copy.source) !== 1)
        continue
      const declaredAs = range.some(
        (entry) => entry.includes(`${copy.type} ${copy.source}`) && !entry.includes(`${copy.type} ${copy.source}_`)
      )
      if (!declaredAs) continue
      chosen.set(copy.cell, copy.source)
      dropped.add(first + copy.at)
    }
    if (chosen.size === 0) continue
    // A copy of a copy: `v16 = radius_0` and `radius_0 = radius_default` both go, so `v16` must read the last name.
    for (const [cell, source] of chosen) {
      let last = source
      for (let hops = 0; chosen.has(last) && hops < chosen.size; hops += 1) last = chosen.get(last) as string
      chosen.set(cell, last)
    }
    range.forEach((entry, offset) => {
      if (dropped.has(first + offset)) return
      let result = ''
      let copied = 0
      eachIdentifier(entry, (token, start, end) => {
        const replacement = chosen.get(token)
        if (replacement === undefined || isMemberOrQualified(entry, start)) return
        result += entry.slice(copied, start) + replacement
        copied = end
      })
      if (copied !== 0) replaced.set(first + offset, result + entry.slice(copied))
    })
  }
  if (dropped.size === 0) return text
  return lines.flatMap((line, index) => (dropped.has(index) ? [] : [replaced.get(index) ?? line])).join('\n')
}

/** `if (!(!done)) break;` as `if (done) break;`: a condition that negates a name twice says the name. */
export const simplifyConditions = (text: string): string => {
  const needle = 'if (!(!'
  let result = ''
  let from = 0
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    if (isIdentifierCharacter(text[at - 1])) continue
    let end = at + needle.length
    while (end < text.length && isIdentifierCharacter(text[end])) end += 1
    if (end === at + needle.length || text.slice(end, end + 2) !== '))') continue
    result += `${text.slice(from, at)}if (${text.slice(at + needle.length, end)})`
    from = end + 2
  }
  return from === 0 ? text : result + text.slice(from)
}

const optionalPayloads = new Set(['double', 'bool', 'long long', 'int', 'gString', 'std::string'])

/** The index of the `}` that closes the `{` at `open`, or -1; strings and nested brackets are skipped, a top-level comma refuses. */
const closingBraceOf = (line: string, open: number): number => {
  let depth = 0
  for (let index = open; index < line.length; index += 1) {
    const character = line[index] as string
    if (character === '"') {
      index += 1
      while (index < line.length && line[index] !== '"') index += line[index] === '\\' ? 2 : 1
    } else if ('([{'.includes(character)) depth += 1
    else if (')]}'.includes(character)) {
      depth -= 1
      if (depth === 0) return character === '}' ? index : -1
    } else if (character === ',' && depth === 1) return -1
  }
  return -1
}

/**
 * `o->f = (gOptional<double>{0.4}); o->gea_present_f = true;` as `o->f = 0.4; o->gea_present_f = true;`.
 *
 * The runtime's `Optional` assigns from a value, so the braces only repeat the field's own type. Taken only when
 * the same line then marks THAT field present, which is how the printer writes a store into an optional field and
 * proves the left side is one: a union or a `Value` assigned from a `gOptional<double>` would convert differently.
 */
export const dropOptionalWrappers = (text: string): string =>
  text
    .split('\n')
    .map((original) => {
      let line = original
      for (let from = 0; ;) {
        const equals = line.indexOf(' = ', from)
        if (equals < 0) break
        from = equals + 3
        const wrapped = line[from] === '('
        const start = wrapped ? from + 1 : from
        if (!line.startsWith('gOptional<', start)) continue
        const brace = line.indexOf('>{', start)
        if (brace < 0 || !optionalPayloads.has(line.slice(start + 'gOptional<'.length, brace))) continue
        const close = closingBraceOf(line, brace + 1)
        if (close < 0 || (wrapped && line[close + 1] !== ')')) continue
        const tail = wrapped ? close + 2 : close + 1
        if (line[tail] !== ';') continue
        const lhsStart = Math.max(line.lastIndexOf(' ', equals - 1), line.lastIndexOf(';', equals - 1)) + 1
        const lhs = line.slice(lhsStart, equals)
        const arrow = lhs.lastIndexOf('->')
        if (arrow <= 0) continue
        const member = lhs.slice(arrow + 2)
        if (member === '' || ![...member].every(isIdentifierCharacter)) continue
        if (!line.slice(tail + 1).includes(`${lhs.slice(0, arrow)}->gea_present_${member} = true;`)) continue
        line = `${line.slice(0, from)}${line.slice(brace + 2, close)}${line.slice(tail)}`
      }
      return line
    })
    .join('\n')

/**
 * `std::string_view{"ball", 4}` as `"ball"sv`: the same view, with the length the compiler already counted. Taken only
 * when the length written is the one the literal really has, so a spelling this scan does not follow (`\x41`, `é`)
 * keeps its explicit form.
 */
export const foldStringViews = (text: string): string => {
  const needle = 'std::string_view{"'
  let result = ''
  let copied = 0
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    if (at < copied) continue
    let index = at + needle.length
    let length = 0
    let understood = true
    while (index < text.length && text[index] !== '"') {
      if (text[index] === '\\') {
        const escaped = text[index + 1]
        if (escaped === undefined || !'ntr"\\\'abfv'.includes(escaped)) {
          understood = false
          break
        }
        length += 1
        index += 2
        continue
      }
      const point = text.codePointAt(index) as number
      length += Buffer.byteLength(String.fromCodePoint(point))
      index += point > 0xffff ? 2 : 1
    }
    if (!understood || text[index] !== '"') continue
    const close = index + 1
    let end = close + 2
    if (text.slice(close, end) !== ', ') continue
    while (end < text.length && text[end] !== undefined && (text[end] as string) >= '0' && (text[end] as string) <= '9') end += 1
    if (text[end] !== '}' || end === close + 2 || Number(text.slice(close + 2, end)) !== length) continue
    result += `${text.slice(copied, at)}${text.slice(at + 'std::string_view{'.length, close)}sv`
    copied = end + 1
  }
  return copied === 0 ? text : result + text.slice(copied)
}

/** The index of the `;` that ends the statement starting at `from`, outside strings and brackets; -1 when there is none. */
const statementEnd = (line: string, from: number): number => {
  let depth = 0
  for (let index = from; index < line.length; index += 1) {
    const character = line[index] as string
    if (character === '"' || character === "'") {
      index += 1
      while (index < line.length && line[index] !== character) index += line[index] === '\\' ? 2 : 1
    } else if ('([{'.includes(character)) depth += 1
    else if (')]}'.includes(character)) depth -= 1
    else if (character === ';' && depth === 0) return index
  }
  return -1
}

const hasTopLevelComma = (text: string): boolean => {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string
    if (character === '"' || character === "'") {
      index += 1
      while (index < text.length && text[index] !== character) index += text[index] === '\\' ? 2 : 1
    } else if ('([{<'.includes(character)) depth += 1
    else if (')]}>'.includes(character)) depth -= 1
    else if (character === ',' && depth <= 0) return true
  }
  return false
}

/**
 * `o->emissive = 16726784; o->gea_present_emissive = true;` as `o->set_emissive(16726784);`, and the setter itself in
 * every record that declares the presence bit: `template <typename V> void set_emissive(V&& v)` stores the value and
 * marks the property present, which is what a store to a property means. The caller says what it stores; the
 * bookkeeping of the reflection protocol stays in the record.
 *
 * Taken only when the second statement sets THAT object's presence for THAT field, immediately after the store. A
 * record that already has a member of the setter's name keeps the two statements.
 */
export const foldFieldSetters = (text: string): string => {
  const used = new Set<string>()
  const lines = text.split('\n').map((original) => {
    let line = original
    for (let from = 0; ;) {
      const equals = line.indexOf(' = ', from)
      if (equals < 0) break
      from = equals + 3
      const lhsStart = Math.max(line.lastIndexOf(' ', equals - 1), line.lastIndexOf(';', equals - 1)) + 1
      const lhs = line.slice(lhsStart, equals)
      const arrow = lhs.indexOf('->')
      if (arrow <= 0 || lhs.indexOf('->', arrow + 2) >= 0 || line[lhsStart - 1] === '&') continue
      const object = lhs.slice(0, arrow)
      const member = lhs.slice(arrow + 2)
      if (![...object].every(isIdentifierCharacter) || member === '' || ![...member].every(isIdentifierCharacter)) continue
      if (member.startsWith('gea_')) continue
      const end = statementEnd(line, from)
      if (end < 0 || !line.startsWith(` ${object}->gea_present_${member} = true;`, end + 1)) continue
      const expression = line.slice(from, end)
      if (expression === '') continue
      const inner = unwrapParentheses(expression)
      const value = inner !== expression && !hasTopLevelComma(inner) ? inner : expression
      const consumed = ` ${object}->gea_present_${member} = true;`.length
      const replacement = `${object}->set_${member}(${value});`
      line = `${line.slice(0, lhsStart)}${replacement}${line.slice(end + 1 + consumed)}`
      used.add(member)
      from = lhsStart + replacement.length
    }
    return line
  })
  if (used.size === 0) return text
  const ranges = new Map<number, readonly [number, number]>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (!line.startsWith('struct ') || !line.endsWith(' {')) continue
    let end = index
    while (end < lines.length && lines[end] !== '};') end += 1
    for (let at = index; at <= end; at += 1) ranges.set(at, [index, end])
    index = end
  }
  const mentions = (from: number, to: number, name: string): boolean => {
    for (let at = from; at < to; at += 1) {
      let found = false
      eachIdentifier(lines[at] as string, (token) => (found ||= token === name))
      if (found) return true
    }
    return false
  }
  const result: string[] = []
  const prefix = 'bool gea_present_'
  lines.forEach((line, index) => {
    result.push(line)
    const range = ranges.get(index)
    const trimmed = line.trim()
    if (range === undefined || !trimmed.startsWith(prefix) || !trimmed.endsWith(' = false;')) return
    const member = trimmed.slice(prefix.length, -' = false;'.length)
    if (!used.has(member) || mentions(range[0], range[1], `set_${member}`)) return
    const indent = line.slice(0, line.length - line.trimStart().length)
    result.push(
      `${indent}template <typename V> void set_${member}(V&& value) { ${member} = std::forward<V>(value); gea_present_${member} = true; }`
    )
  })
  return result.join('\n')
}

/**
 * `Gf_box(gOptional<double>(), v)` as `Gf_box(gEmpty, v)`: an argument that is an empty optional of the parameter's own
 * type says the same thing as `gEmpty`, which converts to any `Optional`. Only inside a call of a compiled function
 * (`Gf_...`) or a construct helper, whose parameters are those optionals; elsewhere (`auto x = gOptional<double>()`)
 * the type is the point and stays.
 */
export const foldEmptyOptionalArguments = (text: string): string => {
  const needle = 'gOptional<'
  const callees: string[] = []
  let result = ''
  let copied = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string
    if (character === '"' || character === "'") {
      if (character === "'" && index > 0 && isIdentifierCharacter(text[index - 1])) continue
      index += 1
      while (index < text.length && text[index] !== character) index += text[index] === '\\' ? 2 : 1
      continue
    }
    if (character === '(') {
      let start = index
      while (start > 0 && (isIdentifierCharacter(text[start - 1]) || text[start - 1] === ':')) start -= 1
      callees.push(text.slice(start, index))
      continue
    }
    if (character === ')') {
      callees.pop()
      continue
    }
    if (!text.startsWith(needle, index) || isIdentifierCharacter(text[index - 1]) || text[index - 1] === ':') continue
    const callee = callees[callees.length - 1] ?? ''
    if (!callee.startsWith('Gf_') && !callee.startsWith('gea_construct')) continue
    let before = index - 1
    while (before >= 0 && text[before] === ' ') before -= 1
    if (text[before] !== '(' && text[before] !== ',') continue
    let depth = 0
    let end = index + needle.length - 1
    for (; end < text.length; end += 1) {
      if (text[end] === '<') depth += 1
      else if (text[end] === '>') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (text.slice(end + 1, end + 3) !== '()' || (text[end + 3] !== ',' && text[end + 3] !== ')')) continue
    result += `${text.slice(copied, index)}gEmpty`
    copied = end + 3
    index = end + 2
  }
  return copied === 0 ? text : result + text.slice(copied)
}

/** Every text-level respelling of a unit, in the order that lets each one see what the one before it made. */
export const makeReadable = (text: string): string =>
  nameValues(
    inlineScalarCopies(
      foldRangeVariables(
        reconstructLoops(
          mergeDeclarations(
            unwrapFunctionBlock(
              foldDefaultedParameters(
                indentBlocks(
                  simplifyConditions(
                    foldFieldSetters(
                      unwrapRedundantParentheses(
                        dropOptionalWrappers(
                          dropDefaultedAttributes(foldThrowHelpers(foldStringViews(foldDoubleCasts(foldEmptyOptionalArguments(text)))))
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  )

const isLabelStatement = (trimmed: string): boolean => labelDefinedBy(trimmed) !== null

/** `i = i + 1` as `++i`, `i = i - 1` as `--i`, `i = i + k` as `i += k`; null for any other statement. */
const stepOf = (trimmed: string): { readonly variable: string; readonly text: string } | null => {
  if (!trimmed.endsWith(';')) return null
  const equals = trimmed.indexOf(' = ')
  if (equals <= 0) return null
  const variable = trimmed.slice(0, equals)
  if (![...variable].every(isIdentifierCharacter)) return null
  const right = trimmed.slice(equals + 3, -1)
  const operator = right.startsWith(`${variable} + `) ? '+' : right.startsWith(`${variable} - `) ? '-' : null
  if (operator === null) return null
  const amount = right.slice(variable.length + 3)
  if (amount === '' || ![...amount].every(isIdentifierCharacter)) return null
  if (amount === variable) return null
  if (amount === '1') return { variable, text: operator === '+' ? `++${variable}` : `--${variable}` }
  return { variable, text: `${variable} ${operator}= ${amount}` }
}

/** `if (!(i < n)) break;` as the condition that keeps the loop going, `i < n`; null for any other statement. */
const continuationOf = (trimmed: string): string | null => {
  const tail = ') break;'
  if (!trimmed.startsWith('if (') || !trimmed.endsWith(tail)) return null
  const test = trimmed.slice(4, trimmed.length - tail.length)
  return test === '' ? null : negated(test)
}

/** The condition that is true when `test` is false, without piling up negations. */
const negated = (test: string): string => {
  if (test[0] === '!') {
    const rest = test.slice(1)
    if (rest[0] === '(' && matchingParenthesis(rest, 0) === rest.length - 1) return rest.slice(1, -1)
    if ([...rest].every((character) => isIdentifierCharacter(character) || character === '.')) return rest
  }
  return `!(${test})`
}

const startsInnerLoop = (trimmed: string): boolean =>
  (trimmed.startsWith('for (') || trimmed.startsWith('while (') || trimmed.startsWith('do ') || trimmed.startsWith('switch (')) &&
  trimmed.endsWith('{')

/**
 * Writes the `for (;;)` loops of a unit as the loops they were: `for (init; test; step)` where the body is the
 * test, the work, and one step ending in `continue`, and `while (test)` where a loop starts with its test and has no
 * step to hand.
 *
 * A `continue` anywhere else in the body (outside a loop the body itself holds) would run a step it used to skip, so
 * such a loop only becomes a `while`, whose `continue` goes back to the test. The step is also left alone when
 * anything jumps to it. The initialiser moves into the `for` only when the variable is not named after the loop.
 */
export const reconstructLoops = (text: string): string => {
  const lines = text.split('\n')
  const out: string[] = []
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (start < 0) {
      if (isFunctionHeader(line)) start = index
      else out.push(line)
      continue
    }
    if (line !== '}') continue
    out.push(...dropTrailingContinues(foldSkips(reconstructLoopsInFunction(lines.slice(start, index + 1)))))
    start = -1
  }
  // A function left open at the end of the text is written as it was.
  if (start >= 0) out.push(...lines.slice(start))
  return out.join('\n')
}

const reconstructLoopsInFunction = (original: readonly string[]): string[] => {
  let lines = [...original]
  if (!lines.some((line) => line.trim() === 'for (;;) {')) return lines
  let shapes = shapesOfLines(lines)
  if (shapes === null) return lines
  const closeOf = (open: number): number => {
    const depth = (shapes as LineShape[])[open]!.after
    for (let at = open + 1; at < lines.length; at += 1) {
      const shape = (shapes as LineShape[])[at] as LineShape
      if (!shape.skipped && shape.level < depth) return at
    }
    return -1
  }
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (lines[k]!.trim() !== 'for (;;) {') continue
    const end = closeOf(k)
    const cursor = end < 0 ? null : cursorLoopOf(lines, k, end)
    const test = cursor === null ? continuationOf((lines[k + 1] ?? '').trim()) : ''
    if (end < 0 || test === null) continue
    const indent = lines[k]!.slice(0, lines[k]!.length - lines[k]!.trimStart().length)
    // The last statement of the body, past the braces that close the blocks it is nested in.
    let last = end - 1
    while (last > k && lines[last]!.trim() === '}') last -= 1
    let step: { readonly variable: string; readonly text: string } | null = null
    if (last - 1 > k + 1 && lines[last]!.trim() === 'continue;' && !isLabelStatement((lines[last - 2] ?? '').trim()))
      step = stepOf(lines[last - 1]!.trim())
    // A source `continue` makes the printer share one step block -- `L: i = i + 1; continue;` -- that every continue jumps to.
    let shared: { readonly at: number; readonly label: string } | null = null
    if (step === null) {
      const found: { readonly at: number; readonly label: string }[] = []
      for (let at = k + 2; at + 2 < end; at += 1) {
        const label = labelDefinedBy(lines[at]!.trim())
        if (label !== null && stepOf((lines[at + 1] ?? '').trim()) !== null && (lines[at + 2] ?? '').trim() === 'continue;')
          found.push({ at, label })
      }
      if (found.length === 1) {
        shared = found[0]!
        step = stepOf(lines[shared.at + 1]!.trim())
      }
    }
    // Another `continue` at this loop's level would, with a step, skip it no longer.
    const strays = (): boolean => {
      for (let at = k + 2; at < end; at += 1) {
        const trimmed = lines[at]!.trim()
        if (startsInnerLoop(trimmed)) {
          const inner = (shapes as LineShape[])[at]!.after
          let close = at + 1
          while (close < end && ((shapes as LineShape[])[close]!.skipped || (shapes as LineShape[])[close]!.level >= inner)) close += 1
          at = close
          continue
        }
        if (trimmed.includes('continue;') && !(step !== null && (at === last || (shared !== null && at === shared.at + 2)))) return true
      }
      return false
    }
    const testTokens = new Set<string>()
    eachIdentifier(test, (token, at) => (isMemberOrQualified(test, at) ? undefined : testTokens.add(token)))
    // Every jump to the shared step block is a `continue` of the `for`, which runs its step.
    let sharedBody: string[] | null = null
    if (shared !== null && cursor === null && step !== null && testTokens.has(step.variable) && !strays()) {
      const converted = structuredJumpsIn(lines.slice(k + 1, end).join('\n'), shared.label, null).split('\n')
      if (!converted.some((line) => gotoTargetsInLine(line).includes((shared as { label: string }).label))) sharedBody = converted
    }
    const counted = cursor === null && step !== null && testTokens.has(step.variable) && (shared === null ? !strays() : sharedBody !== null)
    const header = counted
      ? loopHeader(lines, k, end, test, step as { readonly variable: string; readonly text: string })
      : { init: '', removeInit: -1 }
    const keyword =
      cursor !== null
        ? `for (${cursor.type} ${cursor.item} : gItems(${cursor.cursor}))`
        : counted
          ? `for (${header.init}; ${test}; ${(step as { text: string }).text})`
          : `while (${test})`
    const removed = new Set<number>(cursor === null ? [k + 1] : [k + 1, k + 2, k + 3])
    if (counted && shared !== null) {
      removed.add(shared.at)
      removed.add(shared.at + 1)
    } else if (counted) {
      removed.add(last)
      removed.add(last - 1)
    }
    // The `continue` that ends a range-for body goes where the body's end goes.
    if (cursor !== null && last > k + 3 && lines[last]!.trim() === 'continue;' && !isLabelStatement((lines[last - 1] ?? '').trim()))
      removed.add(last)
    if (header.removeInit >= 0) removed.add(header.removeInit)
    // The body is one block (`{ ... }`) the test and the step sit around: it is the loop body itself.
    const first = cursor === null ? k + 2 : k + 4
    let flattened = false
    if (lines[first]?.trim() === '{') {
      const depth = (shapes as LineShape[])[first]!.after
      let close = first + 1
      while (close < end && ((shapes as LineShape[])[close]!.skipped || (shapes as LineShape[])[close]!.level >= depth)) close += 1
      if (close === end - 1 && lines[close]!.trim() === '}') {
        removed.add(first)
        removed.add(close)
        flattened = true
      }
    }
    const rewritten: string[] = []
    lines.forEach((line, at) => {
      if (removed.has(at)) return
      if (at === k) rewritten.push(`${indent}${keyword} {`)
      else if (counted && sharedBody !== null && at > k && at < end) {
        const body = sharedBody[at - k - 1] as string
        rewritten.push(flattened && at > first && at < end - 1 && body.startsWith('  ') ? body.slice(2) : body)
      } else if (flattened && at > first && at < end - 1) rewritten.push(line.startsWith('  ') ? line.slice(2) : line)
      else rewritten.push(line)
    })
    lines = rewritten
    shapes = shapesOfLines(lines)
    if (shapes === null) return [...original]
  }
  return lines
}

/**
 * The declaration `T v = init;` a counted loop starts from, to move into the `for`, when the lines between it and
 * the loop are only declarations that neither name `v` nor `init`, and `v` is not named after the loop.
 */
const loopHeader = (
  lines: readonly string[],
  loop: number,
  end: number,
  test: string,
  step: { readonly variable: string }
): { readonly init: string; readonly removeInit: number } => {
  const none = { init: '', removeInit: -1 }
  const variable = step.variable
  const mentions = (text: string, name: string): boolean => {
    let found = false
    eachIdentifier(text, (token, at) => {
      if (token === name && !isMemberOrQualified(text, at)) found = true
    })
    return found
  }
  for (let at = loop - 1; at >= 0 && at >= loop - 8; at -= 1) {
    const trimmed = lines[at]!.trim()
    if (!mentions(trimmed, variable)) {
      if (!trimmed.endsWith(';') || isLabelStatement(trimmed) || trimmed.includes('goto ') || trimmed.includes('{')) return none
      continue
    }
    const marker = ` ${variable} = `
    const split = trimmed.indexOf(marker)
    if (split <= 0 || !trimmed.endsWith(';') || trimmed.includes('goto ')) return none
    const type = trimmed.slice(0, split)
    const init = trimmed.slice(split + marker.length, -1)
    if (!mergeableTypes.some((candidate) => `${type} `.startsWith(candidate)) || type.includes('(')) return none
    const initIsAtom = init !== '' && [...init].every((character) => isIdentifierCharacter(character) || character === '.')
    if (!initIsAtom) return none
    for (let between = at + 1; between < loop; between += 1) if (mentions(lines[between]!, init)) return none
    for (let after = end + 1; after < lines.length; after += 1) if (mentions(lines[after]!, variable)) return none
    if (mentions(init, variable) || !mentions(test, variable)) return none
    return { init: `${type} ${variable} = ${init}`, removeInit: at }
  }
  return none
}

/**
 * The loop header `T item = cursor.arrayNext(); bool done = cursor.done(); if (done) break;`: the three statements that
 * start a loop over a cursor, where `done` is named nowhere else in the loop.
 */
const cursorLoopOf = (
  lines: readonly string[],
  loop: number,
  end: number
): { readonly type: string; readonly item: string; readonly cursor: string } | null => {
  const next = (lines[loop + 1] ?? '').trim()
  const done = (lines[loop + 2] ?? '').trim()
  const exit = (lines[loop + 3] ?? '').trim()
  const call = '.arrayNext();'
  if (!next.endsWith(call)) return null
  const equals = next.indexOf(' = ')
  const left = next.slice(0, equals)
  const split = left.lastIndexOf(' ')
  const cursor = next.slice(equals + 3, next.length - call.length)
  if (equals <= 0 || split <= 0 || cursor === '' || ![...cursor].every(isIdentifierCharacter)) return null
  const item = left.slice(split + 1)
  if (item === '' || ![...item].every(isIdentifierCharacter)) return null
  const prefix = 'bool '
  const suffix = ` = ${cursor}.done();`
  if (!done.startsWith(prefix) || !done.endsWith(suffix)) return null
  const flag = done.slice(prefix.length, done.length - suffix.length)
  if (flag === '' || ![...flag].every(isIdentifierCharacter) || exit !== `if (${flag}) break;`) return null
  for (let at = loop + 4; at < end; at += 1) {
    let named = false
    eachIdentifier(lines[at]!, (token, start) => {
      if (token === flag && !isMemberOrQualified(lines[at]!, start)) named = true
    })
    if (named) return null
  }
  return { type: left.slice(0, split), item, cursor }
}

/**
 * `for (T v1 : gItems(c)) { T item = std::move(v1); ...` as `for (T item : gItems(c)) { ...`: the loop variable is
 * named by the first statement of the body, which only moves it into the name the source gave it. Two spellings of
 * that statement (`T x = std::move(v1);` and `T x; assignString(x, std::move(v1));`), and only when `v1` is named
 * nowhere else in the loop.
 */
export const foldRangeVariables = (text: string): string => {
  const lines = text.split('\n')
  const removed = new Set<number>()
  const renamed = new Map<number, string>()
  for (let k = 0; k < lines.length; k += 1) {
    const trimmed = lines[k]!.trim()
    const marker = ' : gItems('
    const at = trimmed.indexOf(marker)
    if (!trimmed.startsWith('for (') || at < 0 || !trimmed.endsWith(') {')) continue
    const left = trimmed.slice(5, at)
    const split = left.lastIndexOf(' ')
    if (split <= 0) continue
    const type = left.slice(0, split)
    const item = left.slice(split + 1)
    const indent = lines[k]!.length - lines[k]!.trimStart().length
    let end = k + 1
    while (end < lines.length && !(lines[end] === `${' '.repeat(indent)}}`)) end += 1
    if (end >= lines.length) continue
    const first = (lines[k + 1] ?? '').trim()
    const moved = `std::move(${item})`
    let name = ''
    let consumed = 0
    if (first.startsWith(`${type} `) && first.endsWith(` = ${moved};`)) {
      name = first.slice(type.length + 1, first.length - ` = ${moved};`.length)
      consumed = 1
    } else if (first.startsWith(`${type} `) && first.endsWith(';') && !first.includes(' = ')) {
      name = first.slice(type.length + 1, -1)
      const second = (lines[k + 2] ?? '').trim()
      if (second === `gea::detail::assignString(${name}, ${moved});`) consumed = 2
    }
    if (consumed === 0 || name === '' || ![...name].every(isIdentifierCharacter)) continue
    let namedElsewhere = false
    for (let body = k + 1 + consumed; body < end && !namedElsewhere; body += 1)
      eachIdentifier(lines[body]!, (token, start) => {
        if (token === item && !isMemberOrQualified(lines[body]!, start)) namedElsewhere = true
      })
    if (namedElsewhere) continue
    for (let body = k + 1; body < k + 1 + consumed; body += 1) removed.add(body)
    renamed.set(k, `${lines[k]!.slice(0, indent)}for (${type} ${name}${trimmed.slice(at)}`)
  }
  return removed.size === 0 && renamed.size === 0
    ? text
    : lines
        .map((line, index) => renamed.get(index) ?? line)
        .filter((_, index) => !removed.has(index))
        .join('\n')
}

/**
 * `if (x) goto L; continue; L:` as `if (!x) continue;` (or `break;`): a jump over a single `continue` or `break`, to
 * a label nothing else in the function jumps to.
 */
const foldSkips = (lines: string[]): string[] => {
  const references = new Map<string, number>()
  for (const line of lines) for (const target of gotoTargetsInLine(line)) references.set(target, (references.get(target) ?? 0) + 1)
  if (![...references.values()].some((count) => count === 1)) return lines
  const out: string[] = []
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!
    const trimmed = line.trim()
    const split = trimmed.lastIndexOf(') goto ')
    if (trimmed.startsWith('if (') && trimmed.endsWith(';') && split > 0) {
      const target = trimmed.slice(split + 7, -1)
      const leave = (lines[at + 1] ?? '').trim()
      if ((leave === 'continue;' || leave === 'break;') && (lines[at + 2] ?? '').trim() === `${target}:` && references.get(target) === 1) {
        out.push(`${line.slice(0, line.length - line.trimStart().length)}if (${negated(trimmed.slice(4, split))}) ${leave}`)
        at += 2
        continue
      }
    }
    out.push(line)
  }
  return out
}

/**
 * A `continue;` that ends a loop's body, past the braces closing the blocks it sits in, goes where the end of the
 * body goes, so it is dropped. That holds for any loop, and for the `continue` of whichever loop it binds to: the
 * line after it is the end of that body. Only a run of plain `}` lines counts; `} while (...)`, `} else {` and `case`
 * labels after it mean something runs next.
 */
const dropTrailingContinues = (lines: string[]): string[] => {
  const shapes = shapesOfLines(lines)
  if (shapes === null || !lines.some((line) => line.trim() === 'continue;')) return lines
  const removed = new Set<number>()
  lines.forEach((line, open) => {
    const trimmed = line.trim()
    if (!(trimmed.startsWith('for (') || trimmed.startsWith('while (')) || !trimmed.endsWith(') {')) return
    const depth = shapes[open]!.after
    let close = open + 1
    while (close < lines.length && (shapes[close]!.skipped || shapes[close]!.level >= depth)) close += 1
    if (close >= lines.length) return
    let last = close - 1
    while (last > open && lines[last]!.trim() === '}') last -= 1
    if (last > open && lines[last]!.trim() === 'continue;' && !isLabelStatement((lines[last - 1] ?? '').trim())) removed.add(last)
  })
  return removed.size === 0 ? lines : lines.filter((_, index) => !removed.has(index))
}
