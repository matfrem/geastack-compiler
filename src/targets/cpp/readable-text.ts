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
  let rawString = false
  let depth = 0
  let inBlockComment = false
  const isLabel = (line: string): boolean => {
    if (!line.endsWith(':') || line.includes(' ') || line.startsWith('case') || line === 'default:') return false
    const name = line.slice(0, -1)
    return [...name].every(isIdentifierCharacter) && name !== 'public' && name !== 'private' && name !== 'protected'
  }
  const indented = text
    .split('\n')
    .map((line) => {
      if (inBlockComment) {
        if (line.includes('*/')) inBlockComment = false
        return line
      }
      if (line.startsWith('#')) return line
      const isNamespaceLine = (line.startsWith('namespace') && line.endsWith('{')) || line.startsWith('}  // namespace')
      let opens = 0
      let closes = 0
      let leadingCloses = 0
      let counting = true
      for (let index = 0; index < line.length && counting; index += 1) {
        const character = line[index]
        if (character === '"' || character === "'") {
          if (character === "'" && index > 0 && isIdentifierCharacter(line[index - 1])) continue
          // A raw string runs across lines in a way this scan does not follow.
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
      if (isNamespaceLine) return line
      const level = Math.max(0, depth - leadingCloses - (isLabel(line) ? 1 : 0))
      depth = Math.max(0, depth + opens - closes)
      return line === '' || line[0] === ' ' || line[0] === '\t' || level === 0 ? line : `${'  '.repeat(level)}${line}`
    })
    .join('\n')
  return rawString ? text : indented
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
