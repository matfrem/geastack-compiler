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
  foldDoubleCasts,
  foldRangeVariables,
  foldThrowHelpers,
  indentBlocks,
  makeReadable,
  mergeDeclarations,
  nameBodyBindings,
  nameBodyParameters,
  nameValues,
  reconstructLoops,
  simplifyConditions,
  unwrapRedundantParentheses
} from '../dist/targets/cpp/readable-text.js'
import { abbreviateTypeSpellings, withTypeAliases } from '../dist/targets/cpp/type-aliases.js'

const lines = (...text) => text.join('\n')

test('static_cast<double> of a number is the double literal, of anything else gDouble()', () => {
  assert.equal(foldDoubleCasts('x = static_cast<double>((0)) + static_cast<double>((b1));'), 'x = 0.0 + gDouble((b1));')
  assert.equal(foldDoubleCasts('static_cast<double>((-2))'), '(-2.0)')
  // octal: 010 is eight as an integer and ten as 010.0, so the cast of it is not rewritten as a literal
  assert.equal(foldDoubleCasts('static_cast<double>((010))'), 'gDouble((010))')
  assert.equal(foldDoubleCasts('static_cast<double>((f(static_cast<double>((1)))))'), 'gDouble((f(1.0)))')
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
  assert.match(readable, /gDouble\(i\)/)
  assert.doesNotMatch(readable, /\bgoto\b|\bcontinue\b/)
})
