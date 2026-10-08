// Splitting, slicing and comparing a long text: every `split` and `substring` is a new string in JavaScript.
function build(lines: number): string {
  const parts: string[] = []
  for (let i = 0; i < lines; i++) parts.push('item' + (i % 97) + '=' + ((i * 31) % 1000) + ';name=entry' + (i % 13) + ';flag=on')
  return parts.join('\n')
}
function parse(text: string): number {
  let sum = 0
  for (const line of text.split('\n')) {
    for (const field of line.split(';')) {
      const eq = field.indexOf('=')
      if (eq < 0) continue
      const key = field.substring(0, eq)
      const value = field.substring(eq + 1)
      if (key === 'name') sum += value.length
      else if (key === 'flag') sum += value === 'on' ? 1 : 0
      else if (key.startsWith('item')) sum += Number(value)
    }
  }
  return sum
}
const text = build(200000)
const t0 = Date.now()
let total = 0
for (let round = 0; round < 10; round++) total += parse(text)
console.log('strings ' + (Date.now() - t0) + ' ' + total)
