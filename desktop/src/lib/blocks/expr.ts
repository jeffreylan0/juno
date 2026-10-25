/**
 * A function of x as a model writes one ("x^2 - 3x + 2", "sin(2x)/x",
 * "2e^(-x)"), read without eval: numbers, x, + - * / ^, brackets, implicit
 * multiplication, pi and e, and the usual functions. Anything else is
 * refused, so an answer can only ever draw a curve.
 */
const FNS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sec: (v) => 1 / Math.cos(v),
  csc: (v) => 1 / Math.sin(v),
  cot: (v) => 1 / Math.tan(v),
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  sign: Math.sign,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
/** Every name, longest first, to split run-together ones ("xsin" is x·sin). */
const NAMES = [...Object.keys(FNS), ...Object.keys(CONSTANTS), 'x'].sort((a, b) => b.length - a.length);

type Token = { num: number } | { name: string } | { op: string };
type Fn = (x: number) => number;

/** The function `src` writes, or null if it isn't one this reads. */
export function compile(src: string): Fn | null {
  if (typeof src !== 'string' || src.length > 200) return null;
  const tokens = tokenize(src.replace(/^\s*(?:y|f\s*\(\s*x\s*\))\s*=/i, ''));
  if (!tokens?.length) return null;
  let i = 0;
  const at = (op: string) => {
    const t = tokens[i];
    return !!t && 'op' in t && t.op === op;
  };
  const startsAtom = () => {
    const t = tokens[i];
    return !!t && ('num' in t || 'name' in t || t.op === '(');
  };

  const expr = (): Fn => {
    let left = term();
    while (at('+') || at('-')) {
      const minus = at('-');
      i++;
      const a = left;
      const b = term();
      left = minus ? (x) => a(x) - b(x) : (x) => a(x) + b(x);
    }
    return left;
  };
  const term = (): Fn => {
    let left = unary();
    while (at('*') || at('/') || startsAtom()) {
      const divide = at('/');
      if (at('*') || divide) i++;
      const a = left;
      const b = unary();
      left = divide ? (x) => a(x) / b(x) : (x) => a(x) * b(x);
    }
    return left;
  };
  // -x^2 is -(x^2), as written.
  const unary = (): Fn => {
    if (at('-')) {
      i++;
      const a = unary();
      return (x) => -a(x);
    }
    if (at('+')) i++;
    return power();
  };
  const power = (): Fn => {
    const base = atom();
    if (!at('^')) return base;
    i++;
    const exponent = unary();
    return (x) => base(x) ** exponent(x);
  };
  const atom = (): Fn => {
    const t = tokens[i++];
    if (!t) throw new Error('end');
    if ('num' in t) return () => t.num;
    if ('name' in t) {
      if (t.name === 'x') return (x) => x;
      if (t.name in CONSTANTS) return () => CONSTANTS[t.name]!;
      const f = FNS[t.name]!;
      // sin(x)^2 squares the sine (power() above takes the ^); sin x^2 is the sine of x².
      const arg = at('(') ? atom() : power();
      return (x) => f(arg(x));
    }
    if (t.op === '(') {
      const inner = expr();
      if (!at(')')) throw new Error('bracket');
      i++;
      return inner;
    }
    throw new Error('unexpected');
  };

  try {
    const fn = expr();
    return i === tokens.length ? fn : null;
  } catch {
    return null;
  }
}

function tokenize(src: string): Token[] | null {
  const text = src
    .toLowerCase()
    .replace(/[−–]/g, '-')
    .replace(/[×·]/g, '*')
    .replace(/÷/g, '/')
    .replace(/π/g, 'pi')
    .replace(/\*\*/g, '^')
    .replace(/[[{]/g, '(')
    .replace(/[\]}]/g, ')');
  const out: Token[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([a-z]+)|([-+*/^()]))/y;
  let pos = 0;
  while (pos < text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) return /^\s*$/.test(text.slice(pos)) ? out : null;
    pos = re.lastIndex;
    if (m[1]) out.push({ num: Number(m[1]) });
    else if (m[2]) {
      const names = m[2].length <= 24 ? split(m[2]) : null;
      if (!names) return null;
      out.push(...names.map((name) => ({ name })));
    } else if (m[3]) out.push({ op: m[3] });
  }
  return out;
}

/** A run of letters as the names it is made of ("xsin" is x and sin), or null. */
function split(word: string): string[] | null {
  if (!word) return [];
  for (const name of NAMES) {
    if (!word.startsWith(name)) continue;
    const rest = split(word.slice(name.length));
    if (rest) return [name, ...rest];
  }
  return null;
}
