// The module references of an ES module's source, for the test of build.mjs: every
// static import and re-export, every import() of a string and every
// new URL(<string>, import.meta.url), the way the engine worker and the capture worklet
// are found (spec/06-web-sdk.md 6.1.4). A lexer skips comments, strings, template text
// and regular expressions, so that only code is read. An import() of anything but a
// string throws, since no file can be checked for it, as does source the lexer cannot
// read to its end.

// Before these keywords' successor, `/` starts a regular expression; after `)` only
// when the parenthesis follows one of PAREN, after `}` only when the brace opened a
// block.
const EXPRESSION = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const PAREN = new Set(["if", "while", "for", "with"]);
const BLOCK = new Set([
  ";",
  "{",
  "}",
  ")",
  "=>",
  "else",
  "try",
  "finally",
  "do",
]);
const PUNCTUATORS = ["=>", "?.", "...", "++", "--"];
const ID_START = /[A-Za-z_$#]|[^\0-\x7f]/;
const ID_PART = /[\w$]|[^\0-\x7f]/;

/** A token: an identifier, a string (its text), a punctuator or another literal. */
const token = (type, value = "", open = undefined) => ({ type, value, open });
const isName = (t) => t?.type === "name";
const is = (t, value) => t?.type === "punct" && t.value === value;
const property = (t) => is(t, ".") || is(t, "?.");

/** The tokens of `source`; throws where a literal, comment or bracket is left open. */
export function lex(source) {
  const out = [];
  const open = []; // [bracket, the token before it]
  let i = 0;
  const fail = (what) => {
    throw new SyntaxError(`${what} at offset ${i}`);
  };
  const keyword = (at, set) =>
    isName(out[at]) && set.has(out[at].value) && !property(out[at - 1]);
  // Whether `/` here starts a regular expression.
  const regexHere = () => {
    const last = out.at(-1);
    if (!last) return true;
    if (last.type === "name") return keyword(out.length - 1, EXPRESSION);
    if (last.type !== "punct") return false;
    if (last.value === ")")
      return isName(last.open) && PAREN.has(last.open.value);
    if (last.value === "}") return !last.open || BLOCK.has(last.open.value);
    return !["]", "++", "--"].includes(last.value);
  };
  // Template text from here to its end or to its next `${`.
  const template = () => {
    for (;;) {
      const c = source[i++];
      if (c === undefined) fail("an unterminated template");
      if (c === "\\") i++;
      else if (c === "`") return out.push(token("literal"));
      else if (c === "$" && source[i] === "{") {
        i++;
        open.push(["${", out.at(-1)]);
        return out.push(token("punct", "${"));
      }
    }
  };
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) i++;
    else if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) fail("an unterminated comment");
      i = end + 2;
    } else if (c === '"' || c === "'") {
      const start = ++i;
      while (source[i] !== c) {
        if (source[i] === undefined || source[i] === "\n")
          fail("an unterminated string");
        i += source[i] === "\\" ? 2 : 1;
      }
      out.push(token("string", source.slice(start, i++)));
    } else if (c === "`") {
      i++;
      template();
    } else if (c === "/" && regexHere()) {
      let klass = false;
      for (i++; source[i] !== "/" || klass; i++) {
        if (source[i] === undefined || source[i] === "\n")
          fail("an unterminated regular expression");
        if (source[i] === "\\") i++;
        else if (source[i] === "[") klass = true;
        else if (source[i] === "]") klass = false;
      }
      for (i++; /[a-z]/.test(source[i] ?? ""); i++);
      out.push(token("literal"));
    } else if (ID_START.test(c)) {
      const start = i;
      for (i++; ID_PART.test(source[i] ?? ""); i++);
      out.push(token("name", source.slice(start, i)));
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1]))) {
      for (i++; /[\w.]/.test(source[i] ?? ""); i++);
      out.push(token("literal"));
    } else if ("([{".includes(c)) {
      open.push([c, out.at(-1)]);
      out.push(token("punct", c));
      i++;
    } else if (")]}".includes(c)) {
      const [bracket, before] = open.pop() ?? fail(`an unopened ${c}`);
      i++;
      if (bracket === "${" && c === "}") template();
      else if ("([{".indexOf(bracket) !== ")]}".indexOf(c))
        fail(`${bracket} closed by ${c}`);
      else out.push(token("punct", c, before));
    } else {
      const p = PUNCTUATORS.find((q) => source.startsWith(q, i)) ?? c;
      out.push(token("punct", p));
      i += p.length;
    }
  }
  if (open.length) fail(`an unclosed ${open.at(-1)[0]}`);
  return out;
}

/**
 * The references of the module `source`: `{ kind, specifier }`, where `kind` is
 * `import` for a static import, a re-export or an import(), and `url` for a
 * new URL(<string>, import.meta.url).
 */
export function references(source) {
  const t = lex(source);
  const found = [];
  const from = (at) => {
    // The first string after `from`, past any string-named binding.
    for (let j = at; j < t.length; j++)
      if (
        t[j].type === "string" &&
        isName(t[j - 1]) &&
        t[j - 1].value === "from"
      )
        return t[j].value;
    throw new SyntaxError(`no module named after token ${at}`);
  };
  for (let k = 0; k < t.length; k++) {
    const [a, b, c, d] = t.slice(k + 1, k + 5);
    if (!isName(t[k]) || property(t[k - 1]) || is(a, ":")) continue;
    const word = t[k].value;
    if (word === "import") {
      if (is(a, ".")) continue; // import.meta
      if (is(a, "(")) {
        // A method named import: its parameters are followed by its body.
        const close = t.findIndex(
          (x, j) => j > k && is(x, ")") && x.open === t[k],
        );
        if (is(t[close + 1], "{")) continue;
        if (b?.type !== "string" || !(is(c, ")") || is(c, ",")))
          throw new SyntaxError(`an import() of an expression at token ${k}`);
        found.push({ kind: "import", specifier: b.value });
      } else if (a?.type === "string")
        found.push({ kind: "import", specifier: a.value });
      else found.push({ kind: "import", specifier: from(k + 1) });
    } else if (word === "export" && is(a, "*")) {
      found.push({ kind: "import", specifier: from(k + 1) });
    } else if (word === "export" && is(a, "{")) {
      let j = k + 2;
      while (j < t.length && !is(t[j], "}")) j++;
      if (isName(t[j + 1]) && t[j + 1].value === "from")
        found.push({ kind: "import", specifier: from(j + 1) });
    } else if (
      word === "new" &&
      isName(a) &&
      a.value === "URL" &&
      is(b, "(") &&
      c?.type === "string" &&
      is(d, ",") &&
      t
        .slice(k + 5, k + 11)
        .map((x) => x.value)
        .join(" ") === "import . meta . url )"
    )
      found.push({ kind: "url", specifier: c.value });
  }
  return found;
}
