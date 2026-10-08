// Unit tests for the passes `--short-names` runs over a finished unit (`readable-text.ts`, `emit-loops.ts`,
// `identifier-names.ts`, `type-aliases.ts`). Each takes text and returns text, so the cases are the shapes the printer
// writes, small enough to read, and the refusals are tested as carefully as the rewrites: a pass that rewrites too
// much is a miscompile, one that rewrites too little only costs readability.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createIdentifierRenamer } from '../dist/targets/cpp/identifier-names.js'
import { structuredJumpsIn } from '../dist/targets/cpp/emit-loops.js'
import {
  displayPathsOf,
  dropDefaultedAttributes,
  dropOptionalWrappers,
  foldBoolCasts,
  foldCallableInitialisers,
  foldDefaultedParameters,
  foldDoubleCasts,
  foldEmptyOptionalArguments,
  foldFieldSetters,
  foldIfStatements,
  foldKeyComparisons,
  foldReturnedValues,
  foldShortCircuits,
  foldSizeCasts,
  foldStringViews,
  foldRangeVariables,
  foldThrowHelpers,
  indentBlocks,
  inlineScalarCopies,
  makeReadable,
  mergeDeclarations,
  nameBodyBindings,
  nameBodyParameters,
  nameValues,
  reconstructLoops,
  simplifyConditions,
  unwrapFunctionBlock,
  unwrapRedundantParentheses
} from '../dist/targets/cpp/readable-text.js'
import { abbreviateTypeSpellings, withTypeAliases } from '../dist/targets/cpp/type-aliases.js'

const lines = (...text) => text.join('\n')

test('static_cast<double> of a number is the double literal, of anything else gToDouble()', () => {
  assert.equal(foldDoubleCasts('x = static_cast<double>((0)) + static_cast<double>((b1));'), 'x = 0.0 + gToDouble((b1));')
  assert.equal(foldDoubleCasts('static_cast<double>((-2))'), '(-2.0)')
  // octal: 010 is eight as an integer and ten as 010.0, so the cast of it is not rewritten as a literal
  assert.equal(foldDoubleCasts('static_cast<double>((010))'), 'gToDouble((010))')
  assert.equal(foldDoubleCasts('static_cast<double>((f(static_cast<double>((1)))))'), 'gToDouble((f(1.0)))')
  assert.equal(foldDoubleCasts('my_static_cast<double>((1))'), 'my_static_cast<double>((1))')
})

test('throw helpers and defaulted attributes', () => {
  const redefine = 'gea::host::throwRuntimeError("TypeError", "Cannot redefine property")'
  assert.equal(foldThrowHelpers(`if (!ok) ${redefine};`), 'if (!ok) gThrowRedefine();')
  assert.equal(
    dropDefaultedAttributes('d->definePropertyFrom(("S"), ("straw"), true, true, true)'),
    'd->definePropertyFrom(("S"), ("straw"))'
  )
  // only the exact three trailing trues, so a call that states anything else keeps its arguments
  assert.equal(dropDefaultedAttributes('d->definePropertyFrom(k, v, true, false, true)'), 'd->definePropertyFrom(k, v, true, false, true)')
})

test('redundant parentheses go, the ones that mean something stay', () => {
  assert.equal(
    unwrapRedundantParentheses('v2 = ((v1).has_value() && static_cast<bool>(*(v1)));'),
    'v2 = v1.has_value() && static_cast<bool>(*v1);'
  )
  assert.equal(unwrapRedundantParentheses('b22 = ((b20) / v46);'), 'b22 = b20 / v46;')
  // a call, a cast, decltype and an attribute are not parenthesised atoms
  assert.equal(unwrapRedundantParentheses('f(x); y = (T)x; decltype((x)) z;'), 'f(x); y = (T)x; decltype((x)) z;')
  assert.equal(unwrapRedundantParentheses('void __attribute__((weak)) f() {'), 'void __attribute__((weak)) f() {')
  // the comma operator needs its parentheses
  assert.equal(unwrapRedundantParentheses('x = (a, b);'), 'x = (a, b);')
  assert.equal(simplifyConditions('if (!(!done)) break;'), 'if (done) break;')
})

test('indentBlocks indents what is flush left and nothing else', () => {
  const before = lines('void f() {', 'if (x) {', 'g("{");', '}', 'block1:', 'h();', '}')
  assert.equal(indentBlocks(before), lines('void f() {', '  if (x) {', '    g("{");', '  }', 'block1:', '  h();', '}'))
  const struct = lines('struct S {', '  int a;', '};')
  assert.equal(indentBlocks(struct), struct)
  // a raw string literal is not followed across lines, so the text is left as it is
  const raw = lines('void f() {', 'auto s = R"(', '{', ')";', '}')
  assert.equal(indentBlocks(raw), raw)
})

test('mergeDeclarations: same block, first mention, no jump over the new initialiser', () => {
  assert.equal(
    mergeDeclarations(lines('void f() {', '  double x;', '  double y = g();', '  x = y + 1;', '}')),
    lines('void f() {', '  double y = g();', '  double x = y + 1;', '}')
  )
  // the right side names the variable
  const selfish = lines('void f() {', '  double x;', '  x = x + 1;', '}')
  assert.equal(mergeDeclarations(selfish), selfish)
  // the assignment is in another block than the declaration (the other branch would be left undeclared)
  const branches = lines('void f() {', '  double x;', '  if (c) {', '    x = 1;', '  } else {', '    x = 2;', '  }', '}')
  assert.equal(mergeDeclarations(branches), branches)
  // a goto before the assignment lands after it: the initialiser would be jumped over
  const jumps = lines('void f() {', '  double x;', '  if (c) goto block7;', '  x = 1;', 'block7:', '  g();', '}')
  assert.equal(mergeDeclarations(jumps), jumps)
  // a backward jump (a loop) crosses nothing
  assert.equal(
    mergeDeclarations(lines('void f() {', 'block1:', '  double x;', '  x = 1;', '  if (c) goto block1;', '}')),
    lines('void f() {', 'block1:', '  double x = 1;', '  if (c) goto block1;', '}')
  )
  // a switch is never touched
  const switched = lines('void f() {', '  double x;', '  switch (k) {', '  case 1:', '  x = 1;', '  }', '}')
  assert.equal(mergeDeclarations(switched), switched)
})

test('reconstructLoops: counted for, while, and the guards', () => {
  const counted = lines(
    'void f() {',
    '  long long i = 0;',
    '  for (;;) {',
    '    if (!(i < n)) break;',
    '    {',
    '      work(i);',
    '      i = i + 1;',
    '      continue;',
    '    }',
    '  }',
    '}'
  )
  assert.equal(reconstructLoops(counted), lines('void f() {', '  for (long long i = 0; i < n; ++i) {', '    work(i);', '  }', '}'))
  // the variable is read after the loop, so its declaration stays where it is
  const used = lines(
    'void f() {',
    '  long long i = 0;',
    '  for (;;) {',
    '    if (!(i < n)) break;',
    '    work(i);',
    '    i = i + 2;',
    '    continue;',
    '  }',
    '  use(i);',
    '}'
  )
  assert.match(reconstructLoops(used), /for \(; i < n; i \+= 2\)/)
  // another continue would skip the step the for adds, so it becomes a while that keeps every statement
  const stray = lines(
    'void f() {',
    '  for (;;) {',
    '    if (!(i < n)) break;',
    '    if (skip(i)) continue;',
    '    i = i + 1;',
    '    continue;',
    '  }',
    '}'
  )
  assert.match(reconstructLoops(stray), /while \(i < n\) \{/)
  assert.doesNotMatch(reconstructLoops(stray), /for \(/)
  // a loop that does not start with its test is left a for (;;)
  const open = lines('void f() {', '  for (;;) {', '    work();', '    if (done()) break;', '  }', '}')
  assert.equal(reconstructLoops(open), open)
})

test('reconstructLoops: a source continue shares one step block', () => {
  const shared = lines(
    'long long f(long long limit) {',
    '  long long steps = 0;',
    '  long long i = 0;',
    '  for (;;) {',
    '    if (!(i < limit)) break;',
    '    if (!(i == 1)) goto block8;',
    '  block2:',
    '    i = i + 1;',
    '    continue;',
    '  block8:',
    '    steps = steps + 1;',
    '    goto block2;',
    '  }',
    '  return steps;',
    '}'
  )
  const rewritten = reconstructLoops(shared)
  assert.match(rewritten, /for \(long long i = 0; i < limit; \+\+i\) \{/)
  assert.doesNotMatch(rewritten, /goto block2/)
  assert.doesNotMatch(rewritten, /^\s*block2:/m)
  // the fallthrough into the step block is still a continue
  assert.match(rewritten, /if \(i == 1\) continue;/)
})

test('cursor loops become range-for, and the variable takes the name the body gives it', () => {
  const walk = lines(
    'void f() {',
    '  for (;;) {',
    '    gString v8 = v7.arrayNext();',
    '    bool v9 = v7.done();',
    '    if (v9) break;',
    '    {',
    '      gString k = std::move(v8);',
    '      use(k);',
    '      continue;',
    '    }',
    '  }',
    '}'
  )
  assert.equal(
    foldRangeVariables(reconstructLoops(walk)),
    lines('void f() {', '  for (gString k : gItems(v7)) {', '    use(k);', '  }', '}')
  )
  // the flag is named in the body, so it is not just the loop test and stays a loop
  const flagged = lines(
    'void f() {',
    '  for (;;) {',
    '    gString v8 = v7.arrayNext();',
    '    bool v9 = v7.done();',
    '    if (v9) break;',
    '    use(v9);',
    '  }',
    '}'
  )
  assert.doesNotMatch(reconstructLoops(flagged), /gItems/)
})

test('values and cells are named after what they hold, and never over a name in use', () => {
  const unit = lines('double f() {', '  double v1 = gea_this->hugT;', '  gRef<GrPose> v2 = gea::makeRef<GrPose>();', '  return v1;', '}')
  assert.equal(
    nameValues(unit),
    lines('double f() {', '  double hugT1 = gea_this->hugT;', '  gRef<GrPose> pose2 = gea::makeRef<GrPose>();', '  return hugT1;', '}')
  )
  // a name some other statement already uses is skipped
  const taken = lines('double f() {', '  double v1 = x.hugT;', '  double hugT1 = 0;', '}')
  assert.equal(nameValues(taken), taken)
  const bindings = nameBodyBindings(['double b22;\nb22 = 1;'], new Map([['b22', 'dt']]))
  assert.equal(bindings[0], 'double dt;\ndt = 1;')
  assert.deepEqual(nameBodyBindings(['gRef<gArray<double>> b1;\nb1 = x;'], new Map([['b1', null]])), [
    'gRef<gArray<double>> arr1;\narr1 = x;'
  ])
  // a parameter keeps gea_arg_N when its name is in use, is a macro, or is not a plain name
  assert.deepEqual(nameBodyParameters(['f(gea_arg_0, gea_arg_1, near)'], ['x', 'near']), ['f(x, gea_arg_1, near)'])
  assert.deepEqual(nameBodyParameters(['f(gea_arg_0, x)'], ['x']), ['f(gea_arg_0, x)'])
})

test('type aliases are written only where they mean the same thing', () => {
  assert.equal(
    abbreviateTypeSpellings(
      'gea::Ref<gea::ArrayObject<std::string>> a; gea::Optional x{}; std::string_view v; gea::Ref<gea::NativeClassMethodState> m;'
    ),
    'gRef<gArray<gString>> a; gea::Optional x{}; std::string_view v; gMethodStateRef m;'
  )
  const unit = withTypeAliases('#include "gea_runtime.h"\ngea::Ref<int> a;\n')
  assert.match(unit, /using gRef = |template <class\.\.\. gArguments> using gRef = gea::Ref<gArguments\.\.\.>;/)
  assert.match(unit, /gRef<int> a;/)
  assert.equal(displayPathsOf(['C:\\g\\src\\a.ts', 'C:\\g\\ojs\\b.ts', 'C:\\g\\node_modules\\x\\c.ts'])('C:\\g\\src\\a.ts'), 'src/a.ts')
})

test('structured jumps: continue and break only where they bind to the loop', () => {
  assert.equal(structuredJumpsIn('if (c) goto block1;\ngoto block4;', 'block1', 'block4'), 'if (c) continue;\nbreak;')
  // inside a C++ loop, switch or lambda the text spells itself, a continue would bind to that construct
  const inner = 'for (size_t i = 0; i < n; ++i) {\n  if (c) goto block1;\n}\ngoto block1;'
  assert.equal(structuredJumpsIn(inner, 'block1', null), 'for (size_t i = 0; i < n; ++i) {\n  if (c) goto block1;\n}\ncontinue;')
  assert.equal(structuredJumpsIn('auto f = [&]() { goto block1; };', 'block1', null), 'auto f = [&]() { goto block1; };')
})

test('names: the first declaration keeps the bare name, the rest carry their identity', () => {
  const names = new Map([
    ['decl|f1|10', 'Beam'],
    ['decl|f2|20', 'Beam'],
    ['decl|f3|30', 'Update']
  ])
  const { renameAll } = createIdentifierRenamer(new Map(), names, new Map())
  const [renamed] = renameAll([
    'struct gea_class_decl_f1_10; struct gea_class_decl_f2_20; gea_body_fn_decl_f3_30_stable_borrow(); gea_global_decl_f1_10; auto gea_view_gea_class_decl_f2_20 = 1;'
  ])
  assert.equal(renamed, 'struct GcBeam; struct GcBeam_f2_20; Gf_Update_stable_borrow(); Gg_Beam; auto gea_view_GcBeam_f2_20 = 1;')
})

test('the whole pipeline on a counted loop', () => {
  const unit = lines(
    '#include "gea_runtime.h"',
    'double sum(long long n) {',
    'double total;',
    'long long i = 0;',
    'for (;;) {',
    'if (!(i < n)) break;',
    '{',
    'double v1 = static_cast<double>((i));',
    'total = total + v1;',
    'i = i + 1;',
    'continue;',
    '}',
    '}',
    'return total;',
    '}'
  )
  const readable = withTypeAliases(makeReadable(unit))
  assert.match(readable, /for \(long long i = 0; i < n; \+\+i\) \{/)
  assert.match(readable, /gToDouble\(i\)/)
  assert.doesNotMatch(readable, /\bgoto\b|\bcontinue\b/)
})

test('a string literal does not make a parameter name look taken', () => {
  const texts = ['void f(gRef<GcDeck> gea_arg_0) {', '  r->name = gString("deck"); use(gea_arg_0);', '}']
  assert.deepEqual(nameBodyParameters(texts, ['deck']), ['void f(gRef<GcDeck> deck) {', '  r->name = gString("deck"); use(deck);', '}'])
})

test('a scalar copy of a never-written parameter is dropped, one of a written one is kept', () => {
  const unit = lines(
    'void f(double color) {',
    '  double v3 = color;',
    '  double v4 = color;',
    '  use(v3, v4);',
    '}',
    'void g(double color) {',
    '  double v3 = color;',
    '  color = 5;',
    '  use(v3);',
    '}',
    'void h(gRef<GrA> a) {',
    '  gRef<GrA> v3 = a;',
    '  use(v3);',
    '}'
  )
  const result = inlineScalarCopies(unit).split(String.fromCharCode(10))
  assert.deepEqual(result.slice(0, 4), ['void f(double color) {', '  use(color, color);', '}', 'void g(double color) {'])
  assert.ok(result.includes('  double v3 = color;'))
  assert.ok(result.includes('  gRef<GrA> v3 = a;'))
})

test('a defaulted parameter is one conditional, and its diamond stays when a label is shared', () => {
  const diamond = (extra) =>
    lines(
      'double f(gOptional<double> progress) {',
      'double v0;',
      'if (!(progress.has_value())) goto block2;',
      'v0 = (*progress);',
      'goto block3;',
      'block2:',
      'v0 = 0;',
      'block3:',
      extra,
      'return v0;',
      '}'
    )
  assert.equal(
    foldDefaultedParameters(diamond('use(v0);')),
    lines(
      'double f(gOptional<double> progress) {',
      'double progress_default;',
      'progress_default = progress.has_value() ? (*progress) : 0;',
      'use(progress_default);',
      'return progress_default;',
      '}'
    )
  )
  assert.equal(foldDefaultedParameters(diamond('goto block3;')), diamond('goto block3;'))
})

test('a block that is the rest of a function loses its braces, unless it redeclares a name', () => {
  const unit = (inner) => lines('void f(double a) {', '  double b = a;', '  {', `    ${inner}`, '    use(c);', '  }', '}')
  assert.equal(
    unwrapFunctionBlock(unit('double c = b;')),
    lines('void f(double a) {', '  double b = a;', '  double c = b;', '  use(c);', '}')
  )
  assert.equal(unwrapFunctionBlock(unit('double b = 2;')), unit('double b = 2;'))
})

test('a copy of a defaulted parameter reads the parameter instead', () => {
  const unit = lines(
    'void f(gOptional<double> p) {',
    '  double p_default = p.has_value() ? (*p) : 0;',
    '  double p_0 = p_default;',
    '  use(p_0);',
    '}'
  )
  assert.equal(
    inlineScalarCopies(unit),
    lines('void f(gOptional<double> p) {', '  double p_default = p.has_value() ? (*p) : 0;', '  use(p_default);', '}')
  )
})

test('a chain of scalar copies reads the first name', () => {
  const unit = lines('void f(double p) {', '  double p_default = 1;', '  double a = p_default;', '  double v3 = a;', '  use(v3);', '}')
  assert.equal(inlineScalarCopies(unit), lines('void f(double p) {', '  double p_default = 1;', '  use(p_default);', '}'))
})

test('parentheses around a number or a string literal go; a call keeps its own', () => {
  assert.equal(unwrapRedundantParentheses('o->type = ("cylinder"); f(("a"), (0.2));'), 'o->type = "cylinder"; f("a", 0.2);')
  assert.equal(unwrapRedundantParentheses('x = g("s");'), 'x = g("s");')
})

test('an optional field is assigned its value, and only when the same line marks that field present', () => {
  assert.equal(
    dropOptionalWrappers('m->r = (gOptional<double>{(0.4)}); m->gea_present_r = true;'),
    'm->r = (0.4); m->gea_present_r = true;'
  )
  const elsewhere = 'v = (gOptional<double>{(0.4)});'
  assert.equal(dropOptionalWrappers(elsewhere), elsewhere)
  const otherField = 'm->r = (gOptional<double>{1}); m->gea_present_q = true;'
  assert.equal(dropOptionalWrappers(otherField), otherField)
})

test('a string view of a literal with its true length is the sv literal', () => {
  assert.equal(
    foldStringViews('f(std::string_view{"ball", 4}, std::string_view{"", 0}, std::string_view{"a\\n", 2});'),
    'f("ball"sv, ""sv, "a\\n"sv);'
  )
  const wrong = 'std::string_view{"ball", 5}'
  assert.equal(foldStringViews(wrong), wrong)
  const unknown = 'std::string_view{"\\x41", 1}'
  assert.equal(foldStringViews(unknown), unknown)
})

test('a store followed by its presence mark becomes one setter call, and the record gets the setter', () => {
  const unit = lines(
    'struct GrMat final {',
    '  gOptional<double> emissive;',
    '  bool gea_present_emissive = false;',
    '};',
    'void f() {',
    '  m->emissive = 16726784; m->gea_present_emissive = true;',
    '  m->emissive = (gOptional<double>{1}); n->gea_present_emissive = true;',
    '}'
  )
  const result = foldFieldSetters(unit)
  assert.match(result, /m->set_emissive\(16726784\);/)
  assert.match(
    result,
    /template <typename V> void set_emissive\(V&& gea_value\) \{ emissive = std::forward<V>\(gea_value\); gea_present_emissive = true; \}/
  )
  assert.match(result, /m->emissive = \(gOptional<double>\{1\}\); n->gea_present_emissive = true;/)
})

test('an empty optional passed to a compiled function is gEmpty; one that names its type elsewhere stays', () => {
  assert.equal(foldEmptyOptionalArguments('Gf_f(gOptional<gRef<gArray<double>>>(), 5, gOptional<double>());'), 'Gf_f(gEmpty, 5, gEmpty);')
  const kept = 'auto x = gOptional<double>(); std::move(gOptional<double>()); Gf_f(gOptional<double>{1});'
  assert.equal(foldEmptyOptionalArguments(kept), kept)
})

test('a function object is minted by thunk alone, the signature staying with the destination', () => {
  assert.equal(
    foldCallableInitialisers(
      'f = gCallable<bool(gCallable<double(double)>)>{gCallable<bool(gCallable<double(double)>)>::entryWithFacts<&Gf_a_thunk>("a"sv, 1, Gf_a_thunk_source()), nullptr};'
    ),
    'f = gCallableOf<&Gf_a_thunk>("a"sv, 1, Gf_a_thunk_source(), nullptr);'
  )
  const other = 'f = gCallable<void()>{gCallable<int()>::entryWithFacts<&t>(""sv, 0, s()), nullptr};'
  assert.equal(foldCallableInitialisers(other), other)
})

test('boolean casts are gToBool', () => {
  assert.equal(foldBoolCasts('x = static_cast<bool>(carried) && static_cast<bool>(f(a));'), 'x = gToBool(carried) && gToBool(f(a));')
})

test('a key tested against a literal is compared to a view of it', () => {
  assert.equal(
    foldKeyComparisons('if (gea_name == "kind") x; if (other == "a") y; if (gea_name != "a\\"b") z;'),
    'if (gea_name == "kind"sv) x; if (other == "a") y; if (gea_name != "a\\"b"sv) z;'
  )
})

test('size casts are gToSizeT', () => {
  assert.equal(foldSizeCasts('n = static_cast<std::size_t>(i) + static_cast<std::size_t>(f(x));'), 'n = gToSizeT(i) + gToSizeT(f(x));')
})

test('a guard around a block is an if, a guard with a jump over an alternative is an if / else, a chain is else if', () => {
  const simple = lines('void f() {', '  if (!(a > b)) goto block3;', '  {', '    x = 1;', '  }', 'block3:', '  use(x);', '}')
  assert.equal(foldIfStatements(simple), lines('void f() {', '  if (a > b) {', '    x = 1;', '  }', '  use(x);', '}'))
  const chain = lines(
    'void f() {',
    '  if (!(a)) goto block1;',
    '  {',
    '    x = 1;',
    '  }',
    '  goto block9;',
    'block1:',
    '  if (!(b)) goto block2;',
    '  {',
    '    x = 2;',
    '  }',
    '  goto block9;',
    'block2:',
    '  {',
    '    x = 3;',
    '  }',
    'block9:',
    '  use(x);',
    '}'
  )
  assert.equal(
    foldIfStatements(chain),
    lines('void f() {', '  if (a) {', '    x = 1;', '  } else if (b) {', '    x = 2;', '  } else {', '    x = 3;', '  }', '  use(x);', '}')
  )
  const shared = lines('void f() {', '  if (!(a)) goto block3;', '  {', '    x = 1;', '  }', 'block3:', '  if (c) goto block3;', '}')
  assert.equal(foldIfStatements(shared), shared)
})

test('a chain of && diamonds is one expression and its returned temporary goes away', () => {
  const unit = lines(
    'bool f(long long x, long long z) {',
    '  bool v0;',
    '  bool v4 = x >= 0;',
    '  if (!v4) goto block2;',
    '  v0 = z >= 0;',
    '  goto block3;',
    'block2:',
    '  v0 = v4;',
    'block3:',
    '  bool v1;',
    '  if (!v0) goto block5;',
    '  v1 = x < lim;',
    '  goto block6;',
    'block5:',
    '  v1 = v0;',
    'block6:',
    '  return v1;',
    '}'
  )
  const folded = foldShortCircuits(unit)
  assert.doesNotMatch(folded, /goto/)
  assert.match(folded, /v1 = x >= 0 && z >= 0 && x < lim;/)
  assert.equal(
    foldReturnedValues(mergeDeclarations(folded)),
    lines('bool f(long long x, long long z) {', '  return x >= 0 && z >= 0 && x < lim;', '}')
  )
  const orForm = unit.split('(!v4)').join('(v4)')
  assert.match(foldShortCircuits(orForm), /v1 = \(x >= 0 \|\| z >= 0\) && x < lim;/)
  const shared = unit.replace('  return v1;', '  if (c) goto block3;')
  assert.match(foldShortCircuits(shared), /v0 = z >= 0;\n {2}goto block3;\nblock2:/)
})

test('doubled parentheses, member paths and negated paths lose the pair they do not need', () => {
  assert.equal(unwrapRedundantParentheses('f((p->q), ((*p)), ((a + b)));'), 'f(p->q, *p, a + b);')
  assert.equal(
    unwrapRedundantParentheses('x = gea::integerBoundLess((gea_this->size->z));'),
    'x = gea::integerBoundLess(gea_this->size->z);'
  )
  assert.equal(unwrapRedundantParentheses('f((-(Gg_P->maxFall)), g((-1)));'), 'f(-Gg_P->maxFall, g(-1));')
  // what the parentheses still decide
  assert.equal(
    unwrapRedundantParentheses('y = (*p).x; z = a / (*p); decltype((x)) w; h((a, b));'),
    'y = (*p).x; z = a / (*p); decltype((x)) w; h((a, b));'
  )
  assert.equal(unwrapRedundantParentheses('v = a - (-b); w = a-(-b);'), 'v = a - (-b); w = a-(-b);')
})
