import type { Color, Look } from "./theme.ts";

export type TokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "function" | "type";
export interface Token {
  text: string;
  kind: TokenKind;
}
const KEYWORDS = new Set(
  "abstract as async await break case catch class const continue def default defer delete do else enum export extends false finally fn for from func function if impl import in interface let match mod mut namespace new nil null package private protected pub public raise return self static struct super switch this throw trait true try type typeof undefined use var void while with yield".split(
    " ",
  ),
);

export class CodeHighlighter {
  private block = false;
  constructor(private readonly language: string) {}

  line(source: string): Token[] {
    if (this.language === "text") return [{ text: source, kind: "plain" }];
    const tokens: Token[] = [];
    let offset = 0;
    while (offset < source.length) {
      if (this.block) {
        const end = source.indexOf("*/", offset);
        const next = end < 0 ? source.length : end + 2;
        tokens.push({ text: source.slice(offset, next), kind: "comment" });
        this.block = end < 0;
        offset = next;
        continue;
      }
      const rest = source.slice(offset);
      const token = this.next(rest);
      tokens.push(token);
      offset += token.text.length;
    }
    return tokens;
  }

  private next(rest: string): Token {
    if (rest.startsWith("/*")) {
      this.block = true;
      return { text: "/*", kind: "comment" };
    }
    if (rest.startsWith("//") || (rest.startsWith("#") && ["python", "bash", "yaml", "toml"].includes(this.language)))
      return { text: rest, kind: "comment" };
    const string = /^(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)/.exec(rest);
    if (string) return { text: string[0], kind: "string" };
    const number = /^(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?)/.exec(rest);
    if (number) return { text: number[0], kind: "number" };
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) return { text: word[0], kind: this.wordKind(word[0], rest.slice(word[0].length)) };
    const plain = /^\s+/.exec(rest)?.[0] ?? rest.slice(0, 1);
    return { text: plain, kind: "plain" };
  }

  private wordKind(word: string, after: string): TokenKind {
    if (KEYWORDS.has(word)) return "keyword";
    if (/^\s*\(/.test(after)) return "function";
    return /^[A-Z]/.test(word) ? "type" : "plain";
  }
}

const LANGUAGES: Record<string, [string, string]> = {
  ts: ["typescript", "TypeScript"],
  mts: ["typescript", "TypeScript"],
  cts: ["typescript", "TypeScript"],
  tsx: ["typescript", "TypeScriptReact"],
  js: ["javascript", "JavaScript"],
  mjs: ["javascript", "JavaScript"],
  cjs: ["javascript", "JavaScript"],
  jsx: ["javascript", "JavaScript (Babel)"],
  rs: ["rust", "Rust"],
  py: ["python", "Python"],
  go: ["go", "Go"],
  json: ["json", "JSON"],
  md: ["markdown", "Markdown"],
  css: ["css", "CSS"],
  scss: ["css", "SCSS"],
  html: ["html", "HTML"],
  sh: ["bash", "Bourne Again Shell (bash)"],
  bash: ["bash", "Bourne Again Shell (bash)"],
  zsh: ["bash", "Bourne Again Shell (bash)"],
  toml: ["toml", "TOML"],
  yaml: ["yaml", "YAML"],
  yml: ["yaml", "YAML"],
  c: ["c", "C"],
  h: ["c", "C"],
  cpp: ["cpp", "C++"],
  cc: ["cpp", "C++"],
  hpp: ["cpp", "C++"],
  java: ["java", "Java"],
  kt: ["kotlin", "Kotlin"],
  swift: ["swift", "Swift"],
  sql: ["sql", "SQL"],
  rb: ["ruby", "Ruby"],
  php: ["php", "PHP"],
  cs: ["csharp", "C#"],
  lua: ["lua", "Lua"],
  xml: ["xml", "XML"],
};

const PLAIN: [string, string] = ["text", "Plain text"];

function language(path: string): [string, string] {
  const name = path.split("/").pop() ?? path;
  if (name === "Dockerfile") return ["bash", "Dockerfile"];
  if (name === "Makefile") return ["bash", "Makefile"];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? PLAIN) : PLAIN;
}

export function languageName(path: string): string {
  return language(path)[1];
}

export function highlighter(path: string): CodeHighlighter {
  return new CodeHighlighter(language(path)[0]);
}

export function tokenColor(look: Look, kind: TokenKind): Color {
  const { t } = look;
  const colors: Record<TokenKind, Color> = {
    plain: t.text,
    keyword: t.unmerged,
    string: t.success,
    comment: t.secondary,
    number: t.reference,
    function: t.typeChange,
    type: t.warning,
  };
  return colors[kind];
}
