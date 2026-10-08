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

/** The index of the bracket closing the `[` at `open`, skipping string and character literals; -1 when unbalanced. */
const matchingBracket = (text: string, open: number): number => {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const character = text[index]
    if (character === '"' || character === "'") {
      index += 1
      while (index < text.length && text[index] !== character) index += text[index] === '\\' ? 2 : 1
    } else if (character === '[') depth += 1
    else if (character === ']') {
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

/** Whether `text` begins with `prefix`: a comparison of spellings in a pass over finished text, which asks nothing of a Representation. */
const hasPrefixAt = (text: string, prefix: string, at = 0): boolean => text.slice(at, at + prefix.length) === prefix

const isDigits = (text: string): boolean => text.length > 0 && [...text].every((character) => character >= '0' && character <= '9')

/**
 * `5`, `-1`, `0.25` as a `double` literal, or null. A leading zero is refused
 * because `010` is octal as an integer and `010.0` is ten: the two spell
 * different numbers, and a cast of the first must not become the second.
 */
const doubleLiteralOf = (text: string): string | null => {
  const negative = text.startsWith('-')
  // `-(1)` is `-1`: the parentheses around the magnitude change nothing.
  const magnitude = negative ? unwrapParentheses(text.slice(1)) : text
  const [whole, fraction, ...rest] = magnitude.split('.')
  if (rest.length > 0 || whole === undefined || !isDigits(whole) || whole.length > 15) return null
  if (whole.length > 1 && whole.startsWith('0')) return null
  if (fraction !== undefined && (!isDigits(fraction) || fraction.length > 15)) return null
  const literal = `${whole}.${fraction ?? '0'}`
  return negative ? `(-${literal})` : literal
}

/** `static_cast<type>(x)` as `helper(x)` everywhere the cast is not part of a longer name; `literal` may respell a constant argument. */
const foldCasts = (text: string, type: string, helper: string, literal: (inner: string) => string | null): string => {
  const needle = `static_cast<${type}>(`
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
    const inner = foldCasts(text.slice(open + 1, close), type, helper, literal)
    result += text.slice(from, at) + (literal(unwrapParentheses(inner)) ?? `${helper}(${inner})`)
    from = close + 1
    at = text.indexOf(needle, from)
  }
  return from === 0 ? text : result + text.slice(from)
}

/**
 * `static_cast<double>(x)` as `gToDouble(x)`, and as the bare literal when `x` is a
 * number written out -- which is exactly what the cast of one means.
 */
export const foldDoubleCasts = (text: string): string => foldCasts(text, 'double', 'gToDouble', doubleLiteralOf)

/** `static_cast<bool>(x)` as `gToBool(x)`. */
export const foldBoolCasts = (text: string): string => foldCasts(text, 'bool', 'gToBool', () => null)

/** `static_cast<std::size_t>(x)` as `gToSizeT(x)`. */
export const foldSizeCasts = (text: string): string => foldCasts(text, 'std::size_t', 'gToSizeT', () => null)

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
      // A leading `*` or `-` (not `--`) makes the atom a unary expression, which never takes a member access or an operand after it.
      const unary = (input[end] === '*' || input[end] === '-') && input[end + 1] !== input[end] ? (input[end] as string) : ''
      if (unary !== '') end += 1
      const quoted = unary === '' && input[end] === '"'
      if (quoted) {
        // A string literal is a primary expression: nothing the parentheses could group.
        end += 1
        while (end < input.length && input[end] !== '"') end += input[end] === '\\' ? 2 : 1
        end += 1
      } else {
        // A name, a number, or a path through members (`a.b`, `p->q`, `ns::x`).
        const digitFirst = input[end] !== undefined && (input[end] as string) >= '0' && (input[end] as string) <= '9'
        while (end < input.length) {
          const here = input[end]
          if (isIdentifierCharacter(here) || here === '.' || here === ':') end += 1
          // `1e-12`: the sign belongs to the exponent of a number.
          else if (digitFirst && (here === '-' || here === '+') && (input[end - 1] === 'e' || input[end - 1] === 'E')) end += 1
          else if (here === '-' && input[end + 1] === '>') end += 2
          // A call or an index on what came before: `n->length()`, `p->at(i)`, `a[i]`.
          else if (
            (here === '(' || here === '[') &&
            end > index + 1 &&
            (isIdentifierCharacter(input[end - 1]) || input[end - 1] === ')' || input[end - 1] === ']')
          ) {
            const close = here === '(' ? matchingParenthesis(input, end) : matchingBracket(input, end)
            if (close < 0) break
            end = close + 1
          } else break
        }
      }
      if (end === index + 1 + (unary === '' ? 0 : 1) || input[end] !== ')') continue
      const atom = input.slice(index + 1, end)
      const first = atom[unary === '' ? 0 : 1] as string
      const numeric = (first >= '0' && first <= '9') || quoted || unary !== ''
      // What comes before: an operator or a separator, never a name, a closing bracket or `>`.
      let before = index - 1
      while (before >= 0 && input[before] === ' ') before -= 1
      const previous = before < 0 ? '' : (input[before] as string)
      // `a < (3)` and `a > (3)`, but not a template's `>(`: the operator must stand apart, with spaces on both sides.
      const spacedComparison = (previous === '<' || previous === '>') && before < index - 1 && input[before - 1] === ' ' && unary === ''
      let afterReturn = false
      if (isIdentifierCharacter(previous)) {
        let wordStart = before
        while (wordStart >= 0 && isIdentifierCharacter(input[wordStart])) wordStart -= 1
        afterReturn = input.slice(wordStart + 1, before + 1) === 'return' && before < index - 1
      }
      if (!afterReturn && !spacedComparison && (previous === '' || !(unary === '' ? '(,={;?:+-*/%&|^!~' : '(,={;?:').includes(previous)))
        continue
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
      // `(a->at(0)) - b`: an atom with a call or a member in it is an expression, never a type, so a minus after it is a subtraction.
      const compound = unary === '' && !numeric && (atom.includes('(') || atom.includes('->') || atom.includes('.'))
      if (!(memberAccess || next === '' || (unary === '' ? ')],;}+*/%<>=!&|^?:' : ')],;}').includes(next) || (compound && next === '-')))
        continue
      result += input.slice(copied, index) + atom
      copied = end + 1
      index = end
    }
    return copied === 0 ? input : result + input.slice(copied)
  }
  // `f((x))` and `a * ((b + c))`: parentheses whose whole content is one more pair.
  const unwrapDoubles = (input: string): string => {
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
      if (character !== '(' || input[index + 1] !== '(' || index < copied) continue
      const inner = matchingParenthesis(input, index + 1)
      if (inner < 0 || input[inner + 1] !== ')') continue
      let before = index - 1
      while (before >= 0 && input[before] === ' ') before -= 1
      const previous = before < 0 ? '' : (input[before] as string)
      if (isIdentifierCharacter(previous) || previous === '>') {
        let wordStart = before
        while (wordStart >= 0 && isIdentifierCharacter(input[wordStart])) wordStart -= 1
        if (wordsBeforeParenthesisThatKeepItMeaningful.has(input.slice(wordStart + 1, before + 1))) continue
        if (hasTopLevelComma(input.slice(index + 2, inner))) continue
      }
      result += `${input.slice(copied, index)}(${input.slice(index + 2, inner)})`
      copied = inner + 2
      index = inner + 1
    }
    return copied === 0 ? input : result + input.slice(copied)
  }
  // A parenthesised expression that is a whole argument or a whole initialiser element: `f(a, (b + c))`.
  const unwrapArguments = (input: string): string => {
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
      if (character !== '(' || index < copied) continue
      let before = index - 1
      while (before >= 0 && input[before] === ' ') before -= 1
      const previous = before < 0 ? '' : (input[before] as string)
      if (previous !== ',' && previous !== '(' && previous !== '{') continue
      const close = matchingParenthesis(input, index)
      if (close < 0) continue
      let after = close + 1
      while (after < input.length && input[after] === ' ') after += 1
      const next = input[after]
      if (next !== ',' && next !== ')' && next !== '}') continue
      if (previous === '(') {
        // The parenthesis must open a call or a statement head, not group something larger, and not be one whose meaning depends on its parentheses.
        let word = before - 1
        while (word >= 0 && input[word] === ' ') word -= 1
        if (word < 0 || !(isIdentifierCharacter(input[word]) || input[word] === '>')) continue
        let wordStart = word
        while (wordStart >= 0 && isIdentifierCharacter(input[wordStart])) wordStart -= 1
        if (wordsBeforeParenthesisThatKeepItMeaningful.has(input.slice(wordStart + 1, word + 1))) continue
      }
      const content = input.slice(index + 1, close)
      if (content === '' || hasTopLevelComma(content)) continue
      result += input.slice(copied, index) + content
      copied = close + 1
      index = close
    }
    return copied === 0 ? input : result + input.slice(copied)
  }
  const withoutAtoms = unwrapAtoms(unwrapAtoms(unwrapArguments(unwrapDoubles(unwrapDoubles(unwrapDoubles(text))))))
  return withoutAtoms
    .split('\n')
    .map((line) => {
      const indent = line.length - line.trimStart().length
      const body = line.slice(indent)
      if (body.startsWith('return (') && body.endsWith(');') && matchingParenthesis(line, indent + 'return '.length) === line.length - 2) {
        const inner = line.slice(indent + 'return ('.length, line.length - 2)
        if (!hasTopLevelComma(inner)) return `${line.slice(0, indent)}return ${inner};`
      }
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

/** Spellings of the program's own record, class and union types, which merge a declaration with its first assignment like any scalar. */
const mergeableRecordPrefixes = ['gea_record_type_', 'gea_union_', 'gea::LocalArrayCursor<', 'Gr', 'Gc', 'gCallable<', 'gDictionary<']

const mergeableTypes = [
  'double ',
  'float ',
  'long long ',
  'bool ',
  'int ',
  'std::size_t ',
  'std::uint32_t ',
  'std::int32_t ',
  'gString ',
  'gValue ',
  'gOptional<',
  'gRef<'
]

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
      if (
        depth === 0 ||
        !trimmed.endsWith(';') ||
        trimmed.includes(' = ') ||
        !(mergeableTypes.some((type) => trimmed.startsWith(type)) || mergeableRecordPrefixes.some((prefix) => trimmed.startsWith(prefix)))
      )
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
  // Blocks nest (`{ a; { b; return; } }`): each pass opens the outermost, so it runs until none is left.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = unwrapFunctionBlockOnce(text)
    if (next === text) return text
    text = next
  }
  return text
}

const unwrapFunctionBlockOnce = (text: string): string => {
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
    out.push(...unwrapTrailingBlocks(lines.slice(start, index + 1)))
    start = -1
  }
  if (start >= 0) out.push(...lines.slice(start))
  return out.join('\n')
}

/** Every `{ ... }` on lines of its own that ends its enclosing block, one at a time, until none is left in the function. */
const unwrapTrailingBlocks = (original: readonly string[]): string[] => {
  let lines = [...original]
  for (let pass = 0; pass < 400; pass += 1) {
    const shapes = shapesOfLines(lines)
    if (shapes === null) return lines
    const levelOf = (index: number): number => (shapes[index] as LineShape).level
    let applied = false
    for (let open = 1; open < lines.length - 1 && !applied; open += 1) {
      if ((lines[open] as string).trim() !== '{') continue
      let close = -1
      for (let at = open + 1; at < lines.length && close < 0; at += 1) {
        if (levelOf(at) < levelOf(open)) break
        if (levelOf(at) === levelOf(open) && (lines[at] as string).trim() === '}') close = at
      }
      // The block must be the last statement of the one around it: the next line closes that.
      if (close < 0 || !(lines[close + 1] as string).trim().startsWith('}')) continue
      const before = new Set<string>()
      for (let at = 0; at < open; at += 1) {
        const entry = lines[at] as string
        eachIdentifier(entry, (token, from) => (isMemberOrQualified(entry, from) ? undefined : before.add(token)))
      }
      let clash = false
      for (let at = open + 1; at < close && !clash; at += 1) {
        if (levelOf(at) !== levelOf(open) + 1) continue
        const name = declaredNameOf((lines[at] as string).trim())
        if (name !== null && before.has(name)) clash = true
      }
      if (clash) continue
      lines = lines.flatMap((entry, at) => {
        if (at === open || at === close) return []
        if (at > open && at < close && !(shapes[at] as LineShape).skipped && entry.startsWith('  ')) return [entry.slice(2)]
        return [entry]
      })
      applied = true
    }
    if (!applied) return lines
  }
  return lines
}

const scalarTypes = ['double', 'bool', 'long long', 'int']

/** The spellings of a string cell, which a conditional can carry like a scalar. */
const stringSpellings = new Set(['gString', ['std', 'string'].join('::')])

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
  const typeOk = (type: string): boolean => scalarTypes.includes(type) || stringSpellings.has(type)
  const renames = new Map<number, { readonly from: number; readonly cell: string; readonly target: string }>()
  const dropped = new Set<number>()
  const replaced = new Map<number, string>()
  let functionStart = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (isFunctionHeader(line)) functionStart = index
    else if (line === '}') functionStart = -1
    const test = line.trim()
    // `if (!(p.has_value())) goto L;` and, once the call's own parentheses are gone, `if (!p.has_value()) goto L;`.
    const guardOfParameter = ifGuardOf(test)
    const condition = guardOfParameter === null ? '' : guardOfParameter.condition
    const tested =
      condition.startsWith('!(') && condition.endsWith(')') ? condition.slice(2, -1) : condition.startsWith('!') ? condition.slice(1) : ''
    const guard = tested.endsWith('.has_value()') && guardOfParameter !== null ? tested : null
    if (guard === null || functionStart < 0 || index + 5 >= lines.length) continue
    const next = lines.slice(index + 1, index + 6).map((entry) => entry.trim())
    const written = guard.slice(0, guard.indexOf('.has_value()'))
    const parameter = written.startsWith('(') && written.endsWith(')') ? written.slice(1, -1) : written
    const skip = (guardOfParameter as IfGuard).label
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

/** `gea::host::Math::PI`: a constant of the runtime, which nothing writes. */
const isMathConstant = (text: string): boolean => {
  const prefix = 'gea::host::Math::'
  if (!text.startsWith(prefix) || text.length === prefix.length) return false
  return [...text.slice(prefix.length)].every(
    (character) => (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character === '_'
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
        (!(cell[0] === 'v' && isDigits(cell.slice(1))) &&
          !source.endsWith('_default') &&
          !(source[0] === 'v' && isDigits(source.slice(1))) &&
          !(cell.startsWith(`${source}_`) && isDigits(cell.slice(source.length + 1)))) ||
        source === '' ||
        !(isMathConstant(source) || [...source].every(isIdentifierCharacter))
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
    // A name written elsewhere still holds one value between a copy of it and the copy's last reader, when nothing
    // in between writes it or can jump: the copy is a snapshot of nothing that changes.
    const stableBetween = (copy: { readonly at: number; readonly cell: string; readonly source: string }): boolean => {
      let lastUse = copy.at
      range.forEach((entry, offset) => {
        if (offset > copy.at) eachIdentifier(entry, (token) => (lastUse = token === copy.cell ? offset : lastUse))
      })
      for (let offset = copy.at + 1; offset <= lastUse; offset += 1) {
        const entry = range[offset] as string
        const trimmed = entry.trim()
        if (labelDefinedBy(trimmed) !== null || trimmed.includes('goto ') || trimmed.startsWith('for (') || trimmed.startsWith('while ('))
          return false
        let written = false
        eachIdentifier(entry, (token, start, end) => {
          if (token !== copy.source || isMemberOrQualified(entry, start)) return
          const before = entry.slice(0, start)
          if (before.endsWith('&') || before.endsWith('++') || before.endsWith('--') || writesAfter(entry, end)) written = true
        })
        if (written) return false
      }
      return true
    }
    const takenOver = new Map<string, string>()
    const numbered = (name: string): boolean => name[0] === 'v' && isDigits(name.slice(1))
    for (const copy of copies) {
      if (!numbered(copy.cell) && numbered(copy.source)) continue
      if (spoiled.has(copy.cell) || declarations.get(copy.cell) !== 1) continue
      if (!isMathConstant(copy.source)) {
        if (declarations.get(copy.source) !== 1) continue
        if (spoiled.has(copy.source) && !stableBetween(copy)) continue
        const declaredAs = range.some(
          (entry) => entry.includes(`${copy.type} ${copy.source}`) && !entry.includes(`${copy.type} ${copy.source}_`)
        )
        if (!declaredAs) continue
      }
      chosen.set(copy.cell, copy.source)
      dropped.add(first + copy.at)
    }
    // `long long sign = v2;` where `v2` is read nowhere else: the named cell IS the value, so its definition takes the name.
    for (const copy of copies) {
      if (numbered(copy.cell) || !numbered(copy.source) || spoiled.has(copy.source) || chosen.has(copy.source)) continue
      if (declarations.get(copy.cell) !== 1 || declarations.get(copy.source) !== 1) continue
      let reads = 0
      for (const entry of range)
        eachIdentifier(entry, (token, start) => (reads += token === copy.source && !isMemberOrQualified(entry, start) ? 1 : 0))
      if (reads !== 2 || !range.some((entry) => entry.trim().startsWith(`${copy.type} ${copy.source} = `))) continue
      takenOver.set(copy.source, copy.cell)
      dropped.add(first + copy.at)
    }
    if (chosen.size === 0 && takenOver.size === 0) continue
    // A copy of a copy: `v16 = radius_0` and `radius_0 = radius_default` both go, so `v16` must read the last name.
    for (const [cell, source] of chosen) {
      let last = source
      for (let hops = 0; chosen.has(last) && hops < chosen.size; hops += 1) last = chosen.get(last) as string
      chosen.set(cell, takenOver.get(last) ?? last)
    }
    range.forEach((entry, offset) => {
      if (dropped.has(first + offset)) return
      let result = ''
      let copied = 0
      eachIdentifier(entry, (token, start, end) => {
        const replacement = chosen.get(token) ?? takenOver.get(token)
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

/** Payloads whose `Optional` assigns from a plain value: the scalars and strings, and a handle (`Optional<Ref<T>>` assigns from a `Ref`, a derived one, or `nullptr`). */
const isAssignablePayload = (type: string): boolean =>
  optionalPayloads.has(type) || type.startsWith('gRef<') || hasPrefixAt(type, 'gea::Ref<')

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
        if (brace < 0 || !isAssignablePayload(line.slice(start + 'gOptional<'.length, brace))) continue
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

const foldStringViewForm = (text: string, open: string, close: string): string => {
  const needle = `std::string_view${open}"`
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
    const quote = index + 1
    let end = quote + 2
    if (text.slice(quote, end) !== ', ') continue
    while (end < text.length && (text[end] as string) >= '0' && (text[end] as string) <= '9') end += 1
    if (text[end] !== close || end === quote + 2 || Number(text.slice(quote + 2, end)) !== length) continue
    result += `${text.slice(copied, at)}${text.slice(at + 'std::string_view'.length + 1, quote)}sv`
    copied = end + 1
  }
  return copied === 0 ? text : result + text.slice(copied)
}

/**
 * `std::string_view{"ball", 4}` and `std::string_view("ball", 4)` as `"ball"sv`: the same view, with the length the
 * compiler already counted. Taken only when the length written is the one the literal really has, so a spelling this
 * scan does not follow (`\x41`, `é`) keeps its explicit form.
 */
export const foldStringViews = (text: string): string => foldStringViewForm(foldStringViewForm(text, '{', '}'), '(', ')')

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
    const declaration = trimmed.startsWith('static inline ') ? trimmed.slice('static inline '.length) : trimmed
    const initial = [' = false;', ' = true;'].find((suffix) => declaration.endsWith(suffix))
    if (range === undefined || initial === undefined || !declaration.startsWith(prefix)) return
    const member = declaration.slice(prefix.length, -initial.length)
    if (!used.has(member) || mentions(range[0], range[1], `set_${member}`)) return
    const indent = line.slice(0, line.length - line.trimStart().length)
    result.push(
      `${indent}template <typename V> void set_${member}(V&& gea_value) { ${member} = std::forward<V>(gea_value); gea_present_${member} = true; }`
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

/** The index just past the `>` closing the `<` at `open`, counting nested angle brackets; -1 when unbalanced. */
const matchingAngle = (text: string, open: number): number => {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '<') depth += 1
    else if (text[index] === '>') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * `gCallable<S>{gCallable<S>::entryWithFacts<&thunk>(name, n, source), env}` as `gCallableOf<&thunk>(name, n, source,
 * env)`: the signature `S` is the destination's, which already states it, and the thunk's type fixes it a second time.
 * Taken only when both spellings of `S` are identical, which is how the printer writes a function object.
 */
export const foldCallableInitialisers = (text: string): string => {
  const head = 'gCallable<'
  let result = ''
  let copied = 0
  for (let at = text.indexOf(head); at >= 0; at = text.indexOf(head, at + head.length)) {
    if (at < copied || isIdentifierCharacter(text[at - 1]) || text[at - 1] === ':') continue
    // Only where the destination names its own type (`x = ...`, `T x = ...`): as an argument the parameter may be deduced.
    if (text.slice(Math.max(0, at - 3), at) !== ' = ') continue
    const signatureEnd = matchingAngle(text, at + head.length - 1)
    if (signatureEnd < 0) continue
    const type = text.slice(at, signatureEnd + 1)
    const factory = `{${type}::entryWithFacts<`
    if (!text.startsWith(factory, signatureEnd + 1)) continue
    const thunkOpen = signatureEnd + factory.length
    const thunkEnd = matchingAngle(text, thunkOpen)
    if (thunkEnd < 0 || text[thunkEnd + 1] !== '(') continue
    const argumentsEnd = matchingParenthesis(text, thunkEnd + 1)
    if (argumentsEnd < 0 || text.slice(argumentsEnd + 1, argumentsEnd + 3) !== ', ') continue
    // The environment runs to the brace that closes the initialiser.
    let depth = 0
    let environmentEnd = -1
    for (let index = argumentsEnd + 3; index < text.length; index += 1) {
      const character = text[index] as string
      if (character === '"') {
        index += 1
        while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
      } else if ('([{'.includes(character)) depth += 1
      else if (')]}'.includes(character)) {
        if (depth === 0) {
          environmentEnd = character === '}' ? index : -1
          break
        }
        depth -= 1
      }
    }
    if (environmentEnd < 0) continue
    const thunk = text.slice(thunkOpen + 1, thunkEnd)
    const callArguments = text.slice(thunkEnd + 2, argumentsEnd)
    const environment = text.slice(argumentsEnd + 3, environmentEnd)
    result += `${text.slice(copied, at)}gCallableOf<${thunk}>(${callArguments}, ${environment})`
    copied = environmentEnd + 1
  }
  return copied === 0 ? text : result + text.slice(copied)
}

const keyVariables = ['gea_name', '__gea_key', 'gea_json_key', 'gea_spread_key', '__gea_ordered_key']

/**
 * `gea_name == "kind"` as `gea_name == "kind"sv`: the key being tested is text the reflection protocol hands over as a
 * view, so the literal is compared as a view whose length is a constant, not measured at run time with `strlen`.
 */
export const foldKeyComparisons = (text: string): string => {
  let result = ''
  let copied = 0
  let at = 0
  // Each search resumes only when the position it found has been passed: a pattern the text never contains would
  // otherwise be searched for to the end of a multi-megabyte unit once per match of the other.
  let equals = text.indexOf(' == "')
  let differs = text.indexOf(' != "')
  while (at < text.length) {
    if (equals >= 0 && equals < at) equals = text.indexOf(' == "', at)
    if (differs >= 0 && differs < at) differs = text.indexOf(' != "', at)
    const found = equals < 0 ? differs : differs < 0 ? equals : Math.min(equals, differs)
    if (found < 0) break
    at = found + 5
    const name = keyVariables.find(
      (variable) => text.endsWith(variable, found) && !isIdentifierCharacter(text[found - variable.length - 1])
    )
    if (name === undefined) continue
    let end = at
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
    if (end >= text.length || text.slice(end + 1, end + 3) === 'sv') continue
    result += `${text.slice(copied, end + 1)}sv`
    copied = end + 1
    at = end + 1
  }
  return copied === 0 ? text : result + text.slice(copied)
}

interface IfGuard {
  readonly condition: string
  readonly label: string
}

/** `if (C) goto block3;`: the test and the label it skips to, or null. */
const ifGuardOf = (trimmed: string): IfGuard | null => {
  if (!trimmed.startsWith('if (') || !trimmed.endsWith(';')) return null
  const at = trimmed.lastIndexOf(') goto ')
  if (at < 4 || matchingParenthesis(trimmed, 3) !== at) return null
  const label = trimmed.slice(at + ') goto '.length, -1)
  if (!label.startsWith('block') || ![...label].every(isIdentifierCharacter)) return null
  return { condition: trimmed.slice(4, at), label }
}

interface IfNode {
  readonly condition: string
  /** Line indices of the branch taken when `condition` holds: from, to (exclusive). */
  readonly then: readonly [number, number]
  readonly otherwise: IfNode | readonly [number, number] | null
}

interface ParsedIf {
  readonly node: IfNode
  /** Index of the last line this structure owns: its join label. */
  readonly end: number
  /** The label every branch ends by jumping to, when it has an else. */
  readonly join: string | null
  /** Jumps to `join` the structure accounts for. */
  readonly jumps: number
  /** The labels it removes besides `join`, each of which only its own guard may mention. */
  readonly owned: readonly string[]
}

const isIfNode = (value: IfNode | readonly [number, number] | null): value is IfNode => value !== null && !Array.isArray(value)

/**
 * `if (!(C)) goto L; { A } L:` as `if (C) { A }`, `if (!(C)) goto L; { A } goto J; L: { B } J:` as `if (C) { A } else { B }`,
 * and a chain of those sharing one join as `if / else if / else`. Taken only when the labels are jumped to by nothing but
 * the structure itself, so the gotos it removes were the whole of its control flow.
 */
export const foldIfStatements = (text: string): string => {
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
    out.push(...foldIfsInFunction(lines.slice(start, index + 1)))
    start = -1
  }
  if (start >= 0) out.push(...lines.slice(start))
  return out.join('\n')
}

const foldIfsInFunction = (original: readonly string[]): string[] => {
  let lines = [...original]
  if (!lines.some((line) => ifGuardOf(line.trim()) !== null)) return lines
  for (let pass = 0; pass < 2000; pass += 1) {
    const shapes = shapesOfLines(lines)
    if (shapes === null) return lines
    const levelOf = (index: number): number => (shapes[index] as LineShape).level
    const referencesTo = (label: string, from = 0, to = lines.length): number => {
      let count = 0
      for (let at = from; at < to; at += 1) eachIdentifier(lines[at] as string, (token) => (count += token === label ? 1 : 0))
      return count
    }
    const labelIndex = (from: number, level: number, label: string): number => {
      for (let at = from; at < lines.length; at += 1) {
        if (levelOf(at) < level) return -1
        if (levelOf(at) === level && labelDefinedBy((lines[at] as string).trim()) === label) return at
      }
      return -1
    }
    const parse = (at: number, join: string | null): ParsedIf | null => {
      const guard = ifGuardOf((lines[at] as string).trim())
      if (guard === null) return null
      const level = levelOf(at)
      const label = labelIndex(at + 1, level, guard.label)
      if (label < 0 || label === at + 1) return null
      if (join !== null && guard.label === join) {
        return {
          node: { condition: negated(guard.condition), then: [at + 1, label], otherwise: null },
          end: label,
          join,
          jumps: 1,
          owned: []
        }
      }
      const last = (lines[label - 1] as string).trim()
      const jump = last.startsWith('goto ') && last.endsWith(';') ? last.slice('goto '.length, -1) : null
      if (jump === null) {
        if (join !== null) return null
        return {
          node: { condition: negated(guard.condition), then: [at + 1, label], otherwise: null },
          end: label,
          join: null,
          jumps: 0,
          owned: [guard.label]
        }
      }
      if (join !== null && jump !== join) return null
      if (label - 1 === at + 1) return null
      const joinIndex = labelIndex(label + 1, level, jump)
      if (joinIndex < 0 || joinIndex === label + 1) return null
      const inner = ifGuardOf((lines[label + 1] as string).trim()) === null ? null : parse(label + 1, jump)
      if (inner !== null && inner.end === joinIndex) {
        return {
          node: { condition: negated(guard.condition), then: [at + 1, label - 1], otherwise: inner.node },
          end: joinIndex,
          join: jump,
          jumps: 1 + inner.jumps,
          owned: [guard.label, ...inner.owned]
        }
      }
      return {
        node: { condition: negated(guard.condition), then: [at + 1, label - 1], otherwise: [label + 1, joinIndex] },
        end: joinIndex,
        join: jump,
        jumps: 1,
        owned: [guard.label]
      }
    }
    // Every branch as the lines it contributes, or null when one cannot be moved into a block of its own.
    const bodyOf = (range: readonly [number, number], indent: string): string[] | null => {
      const [from, to] = range
      if (from >= to) return null
      const braced =
        (lines[from] as string).trim() === '{' &&
        (lines[to - 1] as string).trim() === '}' &&
        levelOf(from) === levelOf(to - 1) &&
        Array.from({ length: to - from - 2 }, (_, offset) => from + 1 + offset).every((at) => levelOf(at) > levelOf(from))
      if (braced) return lines.slice(from + 1, to - 1)
      for (let at = from; at < to; at += 1) {
        const entry = (lines[at] as string).trim()
        if (declaredNameOf(entry) !== null || labelDefinedBy(entry) !== null) return null
      }
      return lines
        .slice(from, to)
        .map((entry) => (entry === '' ? entry : `  ${entry.startsWith(indent) ? entry : `${indent}${entry.trim()}`}`))
    }
    const render = (node: IfNode, indent: string, opening: string): string[] | null => {
      const body = bodyOf(node.then, indent)
      if (body === null) return null
      const result = [`${indent}${opening}if (${node.condition}) {`, ...body]
      if (isIfNode(node.otherwise)) {
        const rest = render(node.otherwise, indent, '} else ')
        return rest === null ? null : [...result, ...rest]
      }
      if (node.otherwise !== null) {
        const otherwise = bodyOf(node.otherwise, indent)
        if (otherwise === null) return null
        return [...result, `${indent}} else {`, ...otherwise, `${indent}}`]
      }
      return [...result, `${indent}}`]
    }
    let changed = false
    for (let at = 0; at < lines.length && !changed; at += 1) {
      const parsed = parse(at, null)
      if (parsed === null) continue
      if (parsed.join !== null && referencesTo(parsed.join) !== parsed.jumps + 1) continue
      if (parsed.owned.some((label) => referencesTo(label) !== 2)) continue
      // A label inside the structure that something outside it jumps to must stay reachable.
      let escapes = false
      for (let inside = at + 1; inside < parsed.end && !escapes; inside += 1) {
        const defined = labelDefinedBy((lines[inside] as string).trim())
        if (defined !== null && !parsed.owned.includes(defined) && referencesTo(defined) !== referencesTo(defined, at, parsed.end + 1))
          escapes = true
      }
      if (escapes) continue
      const indent = (lines[at] as string).slice(0, (lines[at] as string).length - (lines[at] as string).trimStart().length)
      const rendered = render(parsed.node, indent, '')
      if (rendered === null) continue
      lines = [...lines.slice(0, at), ...rendered, ...lines.slice(parsed.end + 1)]
      changed = true
    }
    if (!changed) return lines
  }
  return lines
}

/** Whether `expression` has, outside any bracket or string, an operator that binds looser than `&&` and so needs parentheses as its operand. */
const hasLooseOperator = (expression: string, loosest: '&&' | '||'): boolean => {
  let depth = 0
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index] as string
    if (character === '"' || character === "'") {
      index += 1
      while (index < expression.length && expression[index] !== character) index += expression[index] === '\\' ? 2 : 1
    } else if ('([{'.includes(character)) depth += 1
    else if (')]}'.includes(character)) depth -= 1
    else if (depth === 0) {
      const pair = expression.slice(index, index + 2)
      if (
        character === ',' ||
        character === '?' ||
        (character === '=' &&
          expression[index - 1] !== '=' &&
          expression[index - 1] !== '!' &&
          expression[index - 1] !== '<' &&
          expression[index - 1] !== '>' &&
          expression[index + 1] !== '=')
      )
        return true
      if (pair === '||' && loosest === '&&') return true
    }
  }
  return false
}

/** `bool v12;`: a declaration with no initialiser of a numbered bool cell. */
const isBoolCellDeclaration = (trimmed: string): boolean =>
  trimmed.startsWith('bool v') && trimmed.endsWith(';') && isDigits(trimmed.slice(6, -1))

const operandOf = (expression: string, operator: '&&' | '||'): string =>
  hasLooseOperator(expression, operator) ? `(${expression})` : expression

/**
 * `a && b` and `a || b` as the printer lowers them, a value chosen by a branch:
 *
 *     bool v0;  ...  bool c = a;  if (!c) goto block2;  v0 = b;  goto block3;  block2:  v0 = c;  block3:
 *
 * is `v0 = c && b;`, and `c`'s own definition moves into the expression when nothing else reads it. The result cell must
 * be a `bool` (the other arm copies the tested value into it, which is only the same thing as `&&`'s answer for a bool),
 * and the right operand one plain assignment, so `b` is evaluated under exactly the same condition as before.
 */
export const foldShortCircuits = (text: string): string => {
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
    out.push(...foldShortCircuitsInFunction(lines.slice(start, index + 1)))
    start = -1
  }
  if (start >= 0) out.push(...lines.slice(start))
  return out.join('\n')
}

const foldShortCircuitsInFunction = (original: readonly string[]): string[] => {
  let lines = [...original]
  const referencesTo = (name: string, skip: (trimmed: string) => boolean = () => false): number => {
    let count = 0
    for (const entry of lines) {
      if (skip(entry.trim())) continue
      eachIdentifier(entry, (token, start) => (count += token === name && !isMemberOrQualified(entry, start) ? 1 : 0))
    }
    return count
  }
  for (let pass = 0; pass < 2000; pass += 1) {
    let changed = false
    for (let at = 0; at + 5 < lines.length && !changed; at += 1) {
      const guard = ifGuardOf((lines[at] as string).trim())
      if (guard === null) continue
      const [assign, jump, label, otherwise, join] = lines.slice(at + 1, at + 6).map((entry) => entry.trim()) as [
        string,
        string,
        string,
        string,
        string
      ]
      // `if (!c) goto L` is `&&`; `if (c) goto L` is `||`.
      const negatedGuard = guard.condition.startsWith('!')
      const tested = negatedGuard ? guard.condition.slice(1) : guard.condition
      const operator = negatedGuard ? '&&' : '||'
      if (tested === '' || ![...tested].every(isIdentifierCharacter)) continue
      const cell = assign.slice(0, assign.indexOf(' = '))
      if (cell === '' || !assign.endsWith(';') || !assign.startsWith(`${cell} = `) || !isDigits(cell.slice(1)) || cell[0] !== 'v') continue
      const joinLabel = jump.startsWith('goto ') && jump.endsWith(';') ? jump.slice('goto '.length, -1) : null
      if (joinLabel === null || label !== `${guard.label}:` || otherwise !== `${cell} = ${tested};` || join !== `${joinLabel}:`) continue
      if (referencesTo(guard.label) !== 2 || referencesTo(joinLabel) !== 2) continue
      const declaredBool = lines.slice(0, at).some((entry) => entry.trim() === `bool ${cell};`)
      if (!declaredBool) continue
      const right = assign.slice(cell.length + 3, -1)
      // The tested value's own definition goes into the expression when this diamond is its only reader.
      let definitionAt = at - 1
      while (definitionAt > 0 && isBoolCellDeclaration((lines[definitionAt] as string).trim())) definitionAt -= 1
      const previous = definitionAt >= 0 ? (lines[definitionAt] as string).trim() : ''
      const definition = previous.startsWith(`bool ${tested} = `)
        ? `bool ${tested} = `
        : previous.startsWith(`${tested} = `)
          ? `${tested} = `
          : null
      const readers = referencesTo(tested, (trimmed) => trimmed === `bool ${tested};`)
      let left = tested
      let removePrevious = false
      if (definition !== null && previous.endsWith(';') && readers === 3 && isDigits(tested.slice(1)) && tested[0] === 'v') {
        left = previous.slice(definition.length, -1)
        removePrevious = true
      }
      const replacement = `${(lines[at] as string).slice(0, (lines[at] as string).length - (lines[at] as string).trimStart().length)}${cell} = ${operandOf(left, operator)} ${operator} ${operandOf(right, operator)};`
      lines = [...lines.slice(0, at), replacement, ...lines.slice(at + 6)]
      if (removePrevious) lines.splice(definitionAt, 1)
      if (removePrevious) lines = lines.filter((entry) => entry.trim() !== `bool ${tested};`)
      changed = true
    }
    if (!changed) return lines
  }
  return lines
}

/**
 * `bool v2 = x;  return v2;` as `return x;`: a value named only to be returned. Taken when the cell is read nowhere else
 * in the function and has the function's own return type, so the value is converted the same way on the way out.
 */
export const foldReturnedValues = (text: string): string => {
  // One fold exposes the next (`bool a = ..; bool b = a && ..; return b;`), so it runs to a fixed point.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = foldReturnedValuesOnce(text)
    if (next === text) return text
    text = next
  }
  return text
}

const foldReturnedValuesOnce = (text: string): string => {
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
    const body = lines.slice(start, index + 1)
    const header = body[0] as string
    const folded: string[] = []
    body.forEach((entry, offset) => {
      const trimmed = entry.trim()
      const previous = folded[folded.length - 1]
      if (offset > 0 && previous !== undefined && trimmed.startsWith('return ') && trimmed.endsWith(';')) {
        const value = trimmed.slice('return '.length, -1)
        const before = previous.trim()
        // `bool v1 = X;  return v1 && Y;`: the value is only the left operand of the answer.
        const operator = value.includes(' && ') ? '&&' : value.includes(' || ') ? '||' : null
        const cell = before.startsWith('bool v') ? before.slice('bool '.length, before.indexOf(' = ')) : ''
        if (
          operator !== null &&
          cell !== '' &&
          isDigits(cell.slice(1)) &&
          before.endsWith(';') &&
          value.startsWith(`${cell} ${operator} `) &&
          header.startsWith('bool ')
        ) {
          let uses = 0
          for (const other of body)
            eachIdentifier(other, (token, from) => (uses += token === cell && !isMemberOrQualified(other, from) ? 1 : 0))
          if (uses === 2) {
            const left = before.slice(`bool ${cell} = `.length, -1)
            const rest = value.slice(`${cell} ${operator} `.length)
            folded[folded.length - 1] =
              `${previous.slice(0, previous.length - previous.trimStart().length)}return ${operandOf(left, operator)} ${operator} ${rest};`
            return
          }
        }
        const marker = before.indexOf(` ${value} = `)
        const type = marker > 0 ? before.slice(0, marker) : ''
        if (value[0] === 'v' && isDigits(value.slice(1)) && type !== '' && before.endsWith(';') && header.startsWith(`${type} `)) {
          let reads = 0
          for (const other of body)
            eachIdentifier(other, (token, from) => (reads += token === value && !isMemberOrQualified(other, from) ? 1 : 0))
          if (reads === 2) {
            folded[folded.length - 1] =
              `${previous.slice(0, previous.length - previous.trimStart().length)}return ${before.slice(marker + value.length + 4, -1)};`
            return
          }
        }
      }
      folded.push(entry)
    })
    out.push(...folded)
    start = -1
  }
  if (start >= 0) out.push(...lines.slice(start))
  return out.join('\n')
}

/**
 * `if (c) { v = a; } else { v = b; }` as `v = c ? a : b;`, for a `double` or `bool` cell declared above (and an integer
 * one when both arms are integer literals), so the conditional's two arms agree on a type without a conversion that
 * the two assignments would have made on their own.
 */
export const foldConditionalAssignments = (text: string): string => {
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
    out.push(...foldConditionalAssignmentsInFunction(lines.slice(start, index + 1)))
    start = -1
  }
  if (start >= 0) out.push(...lines.slice(start))
  return out.join('\n')
}

const isIntegerLiteral = (text: string): boolean => isDigits(text.startsWith('-') ? text.slice(1) : text)

const foldConditionalAssignmentsInFunction = (original: readonly string[]): string[] => {
  const lines = [...original]
  for (let at = 0; at + 4 < lines.length; at += 1) {
    const [head, thenLine, middle, elseLine, close] = lines.slice(at, at + 5).map((entry) => entry.trim()) as [
      string,
      string,
      string,
      string,
      string
    ]
    if (!head.startsWith('if (') || !head.endsWith(') {') || middle !== '} else {' || close !== '}') continue
    if (matchingParenthesis(head, 3) !== head.length - 3) continue
    const condition = head.slice(4, -3)
    const target = thenLine.slice(0, thenLine.indexOf(' = '))
    if (target === '' || ![...target].every(isIdentifierCharacter) || !elseLine.startsWith(`${target} = `)) continue
    if (!thenLine.endsWith(';') || !elseLine.endsWith(';')) continue
    const first = thenLine.slice(target.length + 3, -1)
    const second = elseLine.slice(target.length + 3, -1)
    if (first === '' || second === '' || first.includes(';') || second.includes(';')) continue
    const declared = lines
      .slice(0, at)
      .map((entry) => entry.trim())
      .find(
        (entry) =>
          entry === `double ${target};` || entry === `bool ${target};` || entry === `long long ${target};` || entry === `int ${target};`
      )
    // The shape of a defaulted parameter: `if (p.has_value()) { v = *p; } else { v = <default>; }`.
    const parameter = condition.endsWith('.has_value()') ? condition.slice(0, -'.has_value()'.length) : ''
    const defaulted =
      parameter !== '' && [...parameter].every(isIdentifierCharacter) && (first === `*${parameter}` || first === `(*${parameter})`)
    // A handle takes the ternary only when the default is a runtime constructor, whose result is exactly the cell's type.
    const handle =
      defaulted &&
      (hasPrefixAt(second, 'gea::arrayOf<') || hasPrefixAt(second, 'gea::makeRef<')) &&
      lines.slice(0, at).some((entry) => entry.trim().startsWith('gRef<') && entry.trim().endsWith(` ${target};`))
    if (declared === undefined && !handle) continue
    const integer = declared !== undefined && (declared.startsWith('long long ') || declared.startsWith('int '))
    if (integer && !(isIntegerLiteral(first) && isIntegerLiteral(second))) continue
    const indent = (lines[at] as string).slice(0, (lines[at] as string).length - (lines[at] as string).trimStart().length)
    lines.splice(at, 5, `${indent}${target} = ${operandOf(condition, '&&')} ? ${operandOf(first, '&&')} : ${operandOf(second, '&&')};`)
    // The cell holds the parameter's default: it takes the parameter's name.
    const name = `${parameter}_default`
    if (defaulted && target[0] === 'v' && isDigits(target.slice(1)) && parameterNameIsSafe(name)) {
      let used = false
      for (const entry of lines) eachIdentifier(entry, (token) => (used ||= token === name))
      if (!used) {
        for (let row = 0; row < lines.length; row += 1) {
          const entry = lines[row] as string
          let result = ''
          let copied = 0
          eachIdentifier(entry, (token, start, end) => {
            if (token !== target || isMemberOrQualified(entry, start)) return
            result += entry.slice(copied, start) + name
            copied = end
          })
          if (copied !== 0) lines[row] = result + entry.slice(copied)
        }
      }
    }
  }
  return lines
}

/**
 * `goto block6;` where `block6:` is followed by nothing but `return v1;` is `return v1;`: a jump to a return is the
 * return. The label stays only while something else still jumps to it. The returned name must already be in sight at
 * every jump (a parameter, or first written above it), or the copy of the return would name something not declared yet.
 */
export const foldReturnJumps = (text: string): string => {
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
    out.push(...foldReturnJumpsInFunction(lines.slice(start, index + 1)))
    start = -1
  }
  if (start >= 0) out.push(...lines.slice(start))
  return out.join('\n')
}

const foldReturnJumpsInFunction = (original: readonly string[]): string[] => {
  let lines = [...original]
  if (!lines.some((entry) => entry.includes('goto '))) return lines
  for (let at = 0; at + 1 < lines.length; at += 1) {
    const label = labelDefinedBy((lines[at] as string).trim())
    const next = (lines[at + 1] as string).trim()
    if (label === null || !next.startsWith('return') || !next.endsWith(';') || next.includes('(')) continue
    const value = next.slice('return'.length, -1).trim()
    if (value !== '' && !([...value].every(isIdentifierCharacter) || isIntegerLiteral(value))) continue
    const jump = `goto ${label};`
    const firstSeen = (name: string): number => {
      for (let row = 0; row < lines.length; row += 1) {
        let found = false
        eachIdentifier(lines[row] as string, (token) => (found ||= token === name))
        if (found) return row
      }
      return lines.length
    }
    // `value` must be named before the first jump: a parameter on the header line, or written above it.
    const named = value === '' || isIntegerLiteral(value) || value === 'true' || value === 'false' ? 0 : firstSeen(value)
    let allVisible = true
    let jumps = 0
    lines.forEach((entry, row) => {
      if (row === at || !entry.includes(jump)) return
      jumps += 1
      if (named > row) allVisible = false
    })
    if (jumps === 0 || !allVisible) continue
    const replacement = value === '' ? 'return;' : `return ${value};`
    lines = lines.map((entry, row) => (row === at ? entry : entry.split(jump).join(replacement)))
    let remaining = 0
    lines.forEach((entry, row) => {
      if (row !== at) eachIdentifier(entry, (token) => (remaining += token === label ? 1 : 0))
    })
    if (remaining === 0) lines.splice(at, 1)
  }
  return lines
}

/** The start of the operand that ends just before `end`: a name, a member path, a call, or a parenthesised group, with a leading `*`. -1 when none. */
const operandStartBefore = (text: string, end: number): number => {
  let start = end
  const take = (): boolean => {
    const character = text[start - 1]
    if (character === ')' || character === ']') {
      let depth = 0
      for (let at = start - 1; at >= 0; at -= 1) {
        const here = text[at]
        if (here === ')' || here === ']') depth += 1
        else if (here === '(' || here === '[') {
          depth -= 1
          if (depth === 0) {
            start = at
            return true
          }
        }
      }
      return false
    }
    if (isIdentifierCharacter(character) || character === '.' || character === ':') {
      start -= 1
      return true
    }
    if (character === '>' && text[start - 2] === '-') {
      start -= 2
      return true
    }
    return false
  }
  let progressed = false
  while (take()) progressed = true
  if (!progressed) return -1
  if (text[start - 1] === '*' && !isIdentifierCharacter(text[start - 2]) && text[start - 2] !== ')' && text[start - 2] !== ']') start -= 1
  return start
}

/**
 * `X == X && X != 0` as `gTruthy(X)`: a number is truthy unless it is NaN or zero, which the C++ conversion to `bool`
 * gets wrong for NaN, so the test is spelled out; written once per test it said the operand three times. `X` is a name,
 * a member path, a call or a dereference (`(*id)`), whatever the three copies are, as long as they are the same text.
 */
export const foldTruthiness = (text: string): string => {
  let result = ''
  let copied = 0
  for (let at = text.indexOf(' == '); at >= 0; at = text.indexOf(' == ', at + 4)) {
    if (at < copied || !text.slice(at, at + 160).includes(' != 0')) continue
    const start = operandStartBefore(text, at)
    if (start < 0 || start < copied) continue
    const operand = text.slice(start, at)
    const tail = ` == ${operand} && ${operand} != 0`
    if (!text.startsWith(tail, at)) continue
    const end = at + tail.length
    if (isIdentifierCharacter(text[end]) || text[end] === '.') continue
    const bare =
      operand.startsWith('(') && matchingParenthesis(operand, 0) === operand.length - 1 && !hasTopLevelComma(operand.slice(1, -1))
        ? operand.slice(1, -1)
        : operand
    result += `${text.slice(copied, start)}gTruthy(${bare})`
    copied = end
  }
  return copied === 0 ? text : result + text.slice(copied)
}

/**
 * `gToDouble(camYaw)` as `camYaw` when `camYaw` is a `double` of this function (a parameter or a local declared as one,
 * and declared as nothing else): the cast was a conversion from a type that is already the target.
 */
export const dropRedundantDoubleCasts = (text: string): string => {
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
    out.push(...dropRedundantDoubleCastsInFunction(lines.slice(start, index + 1)))
    start = -1
  }
  if (start >= 0) out.push(...lines.slice(start))
  return out.join('\n')
}

const dropRedundantDoubleCastsInFunction = (body: readonly string[]): string[] => {
  if (!body.some((entry) => entry.includes('gToDouble('))) return [...body]
  const types = new Map<string, Set<string>>()
  const note = (type: string, name: string): void => {
    if (name === '' || ![...name].every(isIdentifierCharacter)) return
    const known = types.get(name)
    if (known === undefined) types.set(name, new Set([type]))
    else known.add(type)
  }
  // Parameters: the text between the header's outer parentheses, split where a comma stands outside every bracket.
  const header = body[0] as string
  const open = header.indexOf('(')
  const close = header.lastIndexOf(')')
  if (open >= 0 && close > open) {
    let depth = 0
    let piece = ''
    const pieces: string[] = []
    for (const character of header.slice(open + 1, close)) {
      if ('(<[{'.includes(character)) depth += 1
      else if (')>]}'.includes(character)) depth -= 1
      if (character === ',' && depth === 0) {
        pieces.push(piece)
        piece = ''
      } else piece += character
    }
    pieces.push(piece)
    for (const entry of pieces) {
      const trimmed = entry.trim()
      const split = trimmed.lastIndexOf(' ')
      if (split > 0) note(trimmed.slice(0, split), trimmed.slice(split + 1))
    }
  }
  for (const entry of body) {
    const trimmed = entry.trim()
    const name = declaredNameOf(trimmed)
    if (name === null) continue
    const equals = trimmed.indexOf(' = ')
    const left = equals >= 0 ? trimmed.slice(0, equals) : trimmed.slice(0, -1)
    note(left.slice(0, left.length - name.length - 1), name)
  }
  const doubles = new Set([...types].filter(([, kinds]) => kinds.size === 1 && kinds.has('double')).map(([name]) => name))
  if (doubles.size === 0) return [...body]
  const needle = 'gToDouble('
  return body.map((entry) => {
    let result = ''
    let copied = 0
    for (let at = entry.indexOf(needle); at >= 0; at = entry.indexOf(needle, at + needle.length)) {
      if (at < copied || isIdentifierCharacter(entry[at - 1])) continue
      const close = matchingParenthesis(entry, at + needle.length - 1)
      if (close < 0) continue
      const inner = entry.slice(at + needle.length, close)
      if (!doubles.has(inner)) continue
      result += entry.slice(copied, at) + inner
      copied = close + 1
    }
    return copied === 0 ? entry : result + entry.slice(copied)
  })
}

/**
 * `gRef<T> v = gea::makeRef<T>();` as `auto v = gea::makeRef<T>();`, and likewise for the other initialisers that name
 * their own type: `gRef<gArray<E>> v = gea::arrayOf<E>({...})` and `T v = T{...}`. The type was written twice, and the
 * initialiser already says it. Taken only when the declared type and the initialiser's type are the same text, so the
 * declaration cannot have meant a base class or a conversion; and never for a scalar, where `auto` would hide the type.
 */
export const foldAutoDeclarations = (text: string): string => {
  let result = ''
  let copied = 0
  let lineStart = 0
  while (lineStart < text.length) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd < 0) lineEnd = text.length
    let indent = lineStart
    while (text[indent] === ' ') indent += 1
    // The declared type: a (qualified) name and, if it has one, its template arguments.
    let typeEnd = indent
    while (typeEnd < lineEnd && (isIdentifierCharacter(text[typeEnd]) || text[typeEnd] === ':')) typeEnd += 1
    if (typeEnd > indent && text[typeEnd] === '<') {
      const close = matchingAngle(text, typeEnd)
      typeEnd = close > 0 && close < lineEnd ? close + 1 : indent
    }
    const type = text.slice(indent, typeEnd)
    const scalar =
      type === 'double' ||
      type === 'float' ||
      type === 'bool' ||
      type === 'int' ||
      type === 'long' ||
      type === 'unsigned' ||
      type === 'auto'
    if (typeEnd > indent && !scalar && text[typeEnd] === ' ') {
      let nameEnd = typeEnd + 1
      while (nameEnd < lineEnd && isIdentifierCharacter(text[nameEnd])) nameEnd += 1
      const name = text.slice(typeEnd + 1, nameEnd)
      if (name !== '' && text.startsWith(' = ', nameEnd) && text.slice(lineStart, indent).trim() === '') {
        const initialiser = nameEnd + 3
        const refInner = type.startsWith('gRef<')
          ? type.slice('gRef<'.length, -1)
          : hasPrefixAt(type, 'gea::Ref<')
            ? type.slice('gea::Ref<'.length, -1)
            : null
        const arrayElement = refInner !== null && refInner.startsWith('gArray<') ? refInner.slice('gArray<'.length, -1) : null
        const says =
          text.startsWith(`${type}{`, initialiser) ||
          text.startsWith(`${type}(`, initialiser) ||
          (refInner !== null && hasPrefixAt(text, `gea::makeRef<${refInner}>(`, initialiser)) ||
          (arrayElement !== null && hasPrefixAt(text, `gea::arrayOf<${arrayElement}>(`, initialiser))
        if (says) {
          result += `${text.slice(copied, indent)}auto ${name} = `
          copied = initialiser
        }
      }
    }
    lineStart = lineEnd + 1
  }
  return copied === 0 ? text : result + text.slice(copied)
}

/**
 * `double v17 = Gg_VILLAGE->x;  v19.x = v17;` as `v19.x = Gg_VILLAGE->x;`: a scalar read into a temporary only to be
 * stored on the next line. Taken for a read of a name or a member path (not arithmetic, whose conversion the
 * temporary would have fixed), read by nothing else; C++ evaluates the stored value before the place it goes to, so
 * the order of the two is the one the temporary gave.
 */
export const forwardSingleUseValues = (text: string): string => {
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
    out.push(...forwardSingleUseValuesInFunction(lines.slice(start, index + 1)))
    start = -1
  }
  if (start >= 0) out.push(...lines.slice(start))
  return out.join('\n')
}

const forwardSingleUseValuesInFunction = (original: readonly string[]): string[] => {
  const lines = [...original]
  const reads = new Map<string, number>()
  for (const entry of lines)
    eachIdentifier(entry, (token, start) => (isMemberOrQualified(entry, start) ? undefined : reads.set(token, (reads.get(token) ?? 0) + 1)))
  for (let at = 0; at + 1 < lines.length; at += 1) {
    const definition = (lines[at] as string).trim()
    const type = scalarTypes.find((candidate) => definition.startsWith(`${candidate} v`))
    if (type === undefined || !definition.endsWith(';')) continue
    const equals = definition.indexOf(' = ')
    const cell = equals < 0 ? '' : definition.slice(type.length + 1, equals)
    const value = definition.slice(equals + 3, -1)
    if (cell === '' || cell[0] !== 'v' || !isDigits(cell.slice(1)) || !isPostfixChain(value) || reads.get(cell) !== 2) continue
    const next = (lines[at + 1] as string).trim()
    const store = ` = ${cell};`
    if (!next.endsWith(store)) continue
    const place = next.slice(0, next.length - store.length)
    if (place === '' || place.includes(' ') || place.includes(cell)) continue
    const indent = (lines[at] as string).slice(0, (lines[at] as string).length - (lines[at] as string).trimStart().length)
    lines.splice(at, 2, `${indent}${place} = ${value};`)
  }
  return lines
}

/** Every text-level respelling of a unit, in the order that lets each one see what the one before it made. */
export const makeReadable = (text: string): string =>
  foldAutoDeclarations(
    dropRedundantDoubleCasts(
      nameValues(
        forwardSingleUseValues(
          inlineScalarCopies(
            foldRangeVariables(
              foldReturnedValues(
                unwrapFunctionBlock(
                  mergeDeclarations(
                    foldConditionalAssignments(
                      foldIfStatements(
                        foldShortCircuits(
                          foldReturnJumps(
                            reconstructLoops(
                              mergeDeclarations(
                                unwrapFunctionBlock(
                                  foldDefaultedParameters(
                                    indentBlocks(
                                      simplifyConditions(
                                        foldFieldSetters(
                                          unwrapRedundantParentheses(
                                            foldTruthiness(
                                              unwrapRedundantParentheses(
                                                dropOptionalWrappers(
                                                  dropDefaultedAttributes(
                                                    foldThrowHelpers(
                                                      foldStringViews(
                                                        foldKeyComparisons(
                                                          foldSizeCasts(
                                                            foldBoolCasts(
                                                              foldDoubleCasts(foldCallableInitialisers(foldEmptyOptionalArguments(text)))
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
/** A name, a member path, or either followed by calls and indexes: an operand no operator inside it could regroup. */
const isPostfixChain = (text: string): boolean => {
  let index = 0
  while (index < text.length) {
    const character = text[index] as string
    if (isIdentifierCharacter(character) || character === '.' || character === ':') index += 1
    else if (character === '-' && text[index + 1] === '>') index += 2
    else if ((character === '(' || character === '[') && index > 0) {
      const close = character === '(' ? matchingParenthesis(text, index) : matchingBracket(text, index)
      if (close < 0) return false
      index = close + 1
    } else return false
  }
  return text !== ''
}

const negated = (test: string): string => {
  if (test[0] === '!') {
    const rest = test.slice(1)
    if (rest[0] === '(' && matchingParenthesis(rest, 0) === rest.length - 1) return rest.slice(1, -1)
    if (isPostfixChain(rest)) return rest
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
