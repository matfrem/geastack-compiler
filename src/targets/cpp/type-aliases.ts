import { throwHelperDefinitions } from './readable-text.js'

/**
 * Short spellings for the runtime types an emitted unit names thousands of times.
 *
 * `gea::Ref<` alone is a third of the identifiers in a large program, and the
 * emitter spells it, and every sibling below, in far more places than one
 * parameter could reach -- the same reason class and record names are respelled
 * in a pass over the finished text (`identifier-names.ts`). The aliases are
 * transparent to the C++ compiler, so nothing about the program changes; the
 * block that declares them goes into the unit once, right after the include
 * that makes the full names visible.
 *
 * A template is abbreviated only where it is written with arguments (`gea::Ref<`).
 * Class template argument deduction through an alias template (`gea::Optional{x}`)
 * needs C++20 support not every toolchain this output is built with has, and
 * the bare spelling is rare enough that leaving it alone costs nothing.
 */

const templates: ReadonlyArray<readonly [string, string]> = [
  ['gea::Ref', 'gRef'],
  ['gea::ArrayObject', 'gArray'],
  ['gea::Optional', 'gOptional'],
  ['gea::Map', 'gMap'],
  ['gea::Set', 'gSet'],
  ['gea::Dictionary', 'gDictionary'],
  ['gea::TypedArray', 'gTypedArray'],
  ['gea::CallableObject', 'gCallable'],
  ['gea::Iterator', 'gIterator'],
  ['std::vector', 'gVector']
]

const types: ReadonlyArray<readonly [string, string]> = [
  ['gea::Undefined', 'gUndefined'],
  ['std::string', 'gString'],
  ['gea::Value', 'gValue'],
  ['gea::NativeClassMethodState', 'gMethodState'],
  ['gea::NativeIndexAttributes', 'gIndexAttributes'],
  ['gea::PropertyDescriptor', 'gPropertyDescriptor'],
  ['gea::PropertyKey', 'gPropertyKey']
]

const compound = { from: 'gea::Ref<gea::NativeClassMethodState>', to: 'gMethodStateRef' }

const identifierCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
const isIdentifierCharacter = (character: string | undefined): boolean =>
  character !== undefined && identifierCharacters.includes(character)

const templateAliases = new Map(templates)
const typeAliases = new Map(types)

/** The line after which the alias block goes: the include that brings in the full names. */
export const runtimeIncludeLine = '#include "gea_runtime.h"'

export const typeAliasBlock = [
  'using namespace std::string_view_literals;',
  'inline constexpr gea::EmptyOptional gEmpty{};',
  ...templates.map(([from, to]) => `template <class... gArguments> using ${to} = ${from}<gArguments...>;`),
  ...types.map(([from, to]) => `using ${to} = ${from};`),
  `using ${compound.to} = ${compound.from};`,
  'template <class T> constexpr double gDouble(const T& value) { return static_cast<double>(value); }',
  'template <class Cursor> inline auto gItems(Cursor& cursor) { return gea::cursorRange(cursor); }',
  ...throwHelperDefinitions
].join('\n')

export const abbreviateTypeSpellings = (text: string): string => {
  let result = ''
  let copied = 0
  let gea = text.indexOf('gea::')
  let std = text.indexOf('std::')
  while (gea >= 0 || std >= 0) {
    const at = std < 0 || (gea >= 0 && gea < std) ? gea : std
    if (at === gea) gea = text.indexOf('gea::', at + 1)
    else std = text.indexOf('std::', at + 1)
    const previous = at === 0 ? undefined : text[at - 1]
    if (isIdentifierCharacter(previous)) continue
    // `ns::gea::Ref` is some other `gea`; a leading `::gea::Ref` is this one.
    if (previous === ':' && !(at >= 2 && text[at - 2] === ':' && !isIdentifierCharacter(text[at - 3]))) continue
    let end = at + 5
    while (end < text.length && isIdentifierCharacter(text[end])) end += 1
    const name = text.slice(at, end)
    let replacement: string | undefined
    let stop = end
    if (name === 'gea::Ref' && text.startsWith(compound.from, at)) {
      replacement = compound.to
      stop = at + compound.from.length
    } else if (text[end] === '<') replacement = templateAliases.get(name)
    else replacement = typeAliases.get(name)
    if (replacement === undefined) continue
    result += text.slice(copied, at) + replacement
    copied = stop
    // A cursor left inside the replaced span would re-read it.
    if (gea >= 0 && gea < stop) gea = text.indexOf('gea::', stop)
    if (std >= 0 && std < stop) std = text.indexOf('std::', stop)
  }
  return copied === 0 ? text : result + text.slice(copied)
}

/** The unit's text with the aliases applied and their declarations spliced in; a unit that does not include the runtime is left alone. */
export const withTypeAliases = (text: string): string => {
  const abbreviated = abbreviateTypeSpellings(text)
  const at = abbreviated.indexOf(`${runtimeIncludeLine}\n`)
  if (at < 0) return abbreviated
  const after = at + runtimeIncludeLine.length + 1
  return `${abbreviated.slice(0, after)}${typeAliasBlock}\n${abbreviated.slice(after)}`
}
