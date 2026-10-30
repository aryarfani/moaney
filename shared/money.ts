// Money is integer minor units. No floating point anywhere (spec 8.1).
export const CURRENCY_EXPONENT: Record<string, number> = { IDR: 2, USD: 2, SGD: 2, EUR: 2, JPY: 0 };

export function exponentOf(currency: string): number {
  const e = CURRENCY_EXPONENT[currency];
  if (e === undefined) throw new Error(`Unknown currency ${currency}`);
  return e;
}

const SUFFIX: Record<string, number> = { k: 3, rb: 3, ribu: 3, jt: 6, juta: 6, m: 6 };

/** Parse a decimal string ("16000", "16000.5") into minor units using string maths only. */
export function decimalToMinor(text: string, exponent = 2, extraZeros = 0): number | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const whole = m[1]!;
  let frac = m[2] ?? '';
  // Shift the decimal point right by extraZeros (k = 3, jt = 6) before scaling to minor units.
  const shift = exponent + extraZeros;
  if (frac.length > shift && /[1-9]/.test(frac.slice(shift))) return null; // would lose precision
  frac = frac.slice(0, shift).padEnd(shift, '0');
  const digits = (whole + frac).replace(/^0+(?=\d)/, '');
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse a human amount as typed in chat: "28k", "2,5jt", "Rp 38.500", "16000".
 * Separators followed by exactly three digits are thousands separators unless a
 * k/jt suffix makes them decimals ("2,5jt", "1.5k").
 */
export function parseHumanAmount(raw: string, exponent = 2): number | null {
  const m = /^(?:rp\.?\s*)?(\d[\d.,]*)\s*(k|rb|ribu|jt|juta)?$/i.exec(raw.trim());
  if (!m) return null;
  const num = m[1]!;
  const suffix = m[2]?.toLowerCase();
  const zeros = suffix ? SUFFIX[suffix]! : 0;
  let normalised: string;
  const seps = num.match(/[.,]/g) ?? [];
  if (seps.length === 0) normalised = num;
  else {
    const last = Math.max(num.lastIndexOf('.'), num.lastIndexOf(','));
    const tail = num.slice(last + 1);
    const looksThousands = tail.length === 3 && !suffix;
    const mixed = seps.length > 1;
    if (looksThousands || (mixed && tail.length === 3)) normalised = num.replace(/[.,]/g, '');
    else if (mixed && tail.length !== 3) normalised = num.slice(0, last).replace(/[.,]/g, '') + '.' + tail;
    else if (suffix) normalised = num.slice(0, last) + '.' + tail;
    else return null; // "12,5" without a suffix is ambiguous; ask the user
  }
  return decimalToMinor(normalised, exponent, zeros);
}

/** Group digits with a separator without touching floats. */
function group(n: string, sep: string): string {
  return n.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

export type Locale = 'id' | 'en';

/** "Rp 38.500" (id) or "Rp 38,500" (en); zero decimals hidden. */
export function formatMoney(minor: number, locale: Locale = 'en', exponent = 2): string {
  const neg = minor < 0;
  const abs = String(Math.abs(minor)).padStart(exponent + 1, '0');
  const whole = abs.slice(0, abs.length - exponent);
  const frac = abs.slice(abs.length - exponent).replace(/0+$/, '');
  const [gs, ds] = locale === 'id' ? ['.', ','] : [',', '.'];
  return `${neg ? '-' : ''}Rp${locale === 'id' ? ' ' : ''}${group(whole, gs)}${frac ? ds + frac : ''}`;
}

/** Compact form: Rp32k, Rp2.5m. */
export function formatCompact(minor: number, locale: Locale = 'en', exponent = 2): string {
  const neg = minor < 0 ? '-' : '';
  const units = Math.abs(Math.trunc(minor / 10 ** exponent));
  const dec = locale === 'id' ? ',' : '.';
  const fmt = (v: number, s: string) => {
    const t = (Math.floor(v * 10) / 10).toFixed(1).replace(/\.0$/, '').replace('.', dec);
    return `${neg}Rp${t}${s}`;
  };
  if (units >= 1_000_000_000) return fmt(units / 1_000_000_000, locale === 'id' ? 'M' : 'b');
  if (units >= 1_000_000) return fmt(units / 1_000_000, locale === 'id' ? 'jt' : 'm');
  if (units >= 1_000) return fmt(units / 1_000, locale === 'id' ? 'rb' : 'k');
  return `${neg}Rp${units}`;
}
