// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical JSON for Team Sync events (RFC 8785, JSON Canonicalization Scheme).
 *
 * A signed event must have exactly one valid encoding (review finding S-M2), so
 * a relay can never re-encode it into different bytes with the same meaning.
 * On top of JCS, Team Sync also requires:
 *   - every string (keys included) is Unicode NFC and well-formed UTF-16;
 *   - no duplicate keys when parsing — `JSON.parse` silently keeps the last one,
 *     which would let two devices read two different bodies from one line;
 *   - finite numbers only.
 *
 * `canonicalize` serialises a value; `parseStrict` parses text with those rules
 * plus a nesting-depth cap (§8.3: depth ≤ 16). Zero dependencies.
 */

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}

export const MAX_JSON_DEPTH = 16;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkString(s: string): void {
  if (LONE_SURROGATE.test(s)) throw new CanonicalError('string contains a lone surrogate');
  if (s.normalize('NFC') !== s) throw new CanonicalError('string is not Unicode NFC');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function write(v: unknown, out: string[]): void {
  if (v === null) { out.push('null'); return; }
  switch (typeof v) {
    case 'boolean': out.push(v ? 'true' : 'false'); return;
    case 'number':
      if (!Number.isFinite(v)) throw new CanonicalError('non-finite number');
      // ECMAScript Number→String is exactly the JCS number serialisation;
      // JSON.stringify also maps -0 to "0" as JCS requires.
      out.push(JSON.stringify(v));
      return;
    case 'string':
      checkString(v);
      out.push(JSON.stringify(v));
      return;
    case 'object': {
      if (Array.isArray(v)) {
        out.push('[');
        v.forEach((item, i) => {
          if (i) out.push(',');
          write(item, out);
        });
        out.push(']');
        return;
      }
      if (!isPlainObject(v)) throw new CanonicalError('only plain objects can be canonicalised');
      // Default sort compares UTF-16 code units, which is what JCS specifies.
      const keys = Object.keys(v).sort();
      out.push('{');
      keys.forEach((k, i) => {
        const val = v[k];
        if (val === undefined) throw new CanonicalError(`undefined value at key ${JSON.stringify(k)}`);
        checkString(k);
        if (i) out.push(',');
        out.push(JSON.stringify(k), ':');
        write(val, out);
      });
      out.push('}');
      return;
    }
    default:
      throw new CanonicalError(`cannot canonicalise a ${typeof v}`);
  }
}

/** RFC 8785 canonical JSON text of `value`. Throws `CanonicalError` on anything non-canonicalisable. */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join('');
}

/** Canonical UTF-8 bytes of `value`. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}

// ── strict parser ────────────────────────────────────────────────────────────

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Parser {
  private i = 0;
  constructor(private readonly s: string, private readonly maxDepth: number) {}

  parse(): unknown {
    const v = this.value(0);
    this.ws();
    if (this.i !== this.s.length) this.fail('trailing characters');
    return v;
  }

  private fail(msg: string): never {
    throw new CanonicalError(`${msg} at offset ${this.i}`);
  }

  private ws(): void {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }

  private value(depth: number): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === '{' || c === '[') {
      if (depth + 1 > this.maxDepth) this.fail(`nesting depth exceeds ${this.maxDepth}`);
      return c === '{' ? this.object(depth + 1) : this.array(depth + 1);
    }
    if (c === '"') return this.string();
    if (this.s.startsWith('true', this.i)) { this.i += 4; return true; }
    if (this.s.startsWith('false', this.i)) { this.i += 5; return false; }
    if (this.s.startsWith('null', this.i)) { this.i += 4; return null; }
    NUMBER.lastIndex = this.i;
    const m = NUMBER.exec(this.s);
    if (!m) this.fail('unexpected token');
    this.i += m[0].length;
    // A number followed directly by a digit is a leading-zero form like "01".
    const next = this.s.charCodeAt(this.i);
    if (next >= 0x30 && next <= 0x39) this.fail('invalid number');
    const n = Number(m[0]);
    if (!Number.isFinite(n)) this.fail('number out of range');
    return n;
  }

  private object(depth: number): Record<string, unknown> {
    this.i++; // {
    // defineProperty (not assignment) so a "__proto__" key is plain data.
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.ws();
    if (this.s[this.i] === '}') { this.i++; return out; }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail('expected a key');
      const k = this.string();
      if (seen.has(k)) this.fail(`duplicate key ${JSON.stringify(k)}`);
      seen.add(k);
      this.ws();
      if (this.s[this.i] !== ':') this.fail('expected ":"');
      this.i++;
      Object.defineProperty(out, k, { value: this.value(depth), enumerable: true, writable: true, configurable: true });
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') break;
      if (c !== ',') this.fail('expected "," or "}"');
    }
    return out;
  }

  private array(depth: number): unknown[] {
    this.i++; // [
    const out: unknown[] = [];
    this.ws();
    if (this.s[this.i] === ']') { this.i++; return out; }
    for (;;) {
      out.push(this.value(depth));
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') break;
      if (c !== ',') this.fail('expected "," or "]"');
    }
    return out;
  }

  private string(): string {
    this.i++; // opening quote
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) this.fail('unterminated string');
      const c = this.s.charCodeAt(this.i);
      if (c === 0x22) { this.i++; break; }
      if (c < 0x20) this.fail('control character in string');
      if (c !== 0x5c) { out += this.s[this.i++]; continue; }
      const e = this.s[this.i + 1];
      this.i += 2;
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
          break;
        }
        default: this.fail('invalid escape');
      }
    }
    try {
      checkString(out);
    } catch (err) {
      this.fail((err as Error).message);
    }
    return out;
  }
}

/**
 * Parse JSON text, rejecting duplicate keys, non-NFC or malformed strings,
 * out-of-range numbers and nesting deeper than `maxDepth`.
 */
export function parseStrict(text: string, maxDepth = MAX_JSON_DEPTH): unknown {
  return new Parser(text, maxDepth).parse();
}
