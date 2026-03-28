import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  SemanticTokensBuilder,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// ─── Token types: solo "namespace" con modificador "definition" ──────────────
// Usamos tipos ESTÁNDAR de VS Code para que el tema los reconozca sin config extra
const TOKEN_TYPES   = ["namespace"];   // index 0
const TOKEN_MODIFIERS = ["definition"]; // index 0  (bit 0 = 1)

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      semanticTokensProvider: {
        legend: {
          tokenTypes: TOKEN_TYPES,
          tokenModifiers: TOKEN_MODIFIERS,
        },
        full: true,
      },
    },
  };
});

// ─── Parsea imports y devuelve SOLO el identificador que debe resaltar ────────
// library math          → "math"
// library math as m     → "m"   (solo el alias, math queda inválido)
function parseImportedNames(text: string): Set<string> {
  const names = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();

    // library math        → "math"
    // library math as m   → "m"
    const lib = t.match(
      /^library\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*))?/
    );
    if (lib) {
      names.add(lib[2] ?? lib[1]);
      continue;
    }

    // from math use PI          → "math"  (sin alias)
    // from math use PI as m     → "m"     (alias del símbolo)
    // from math use PI al pi as m → "m"   (alias al final)
    const from = t.match(
      /^from\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+use\s+.+?\bas\s+([a-zA-Z_][a-zA-Z0-9_]*)/
    );
    if (from) {
      names.add(from[2]); // hay "as alias" → solo el alias
      continue;
    }

    // from math use PI  (sin ningún "as")
    const fromNoAlias = t.match(
      /^from\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+use\s+/
    );
    if (fromNoAlias) {
      names.add(fromNoAlias[1]); // sin alias → la librería
      continue;
    }
  }

  return names;
}
// ─── Genera los semantic tokens para el documento ────────────────────────────
function getSemanticTokens(doc: TextDocument) {
  const builder = new SemanticTokensBuilder();
  const text    = doc.getText();
  const lines   = text.split(/\r?\n/);
  const imported = parseImportedNames(text);

  if (imported.size === 0) return builder.build();

  // Busca "identificador." en cada línea
  const re = /\b([a-zA-Z_][a-zA-Z0-9_]*)\./g;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // Saltar comentarios y líneas de import
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    if (/^\s*(library|from)\b/.test(line)) continue;

    re.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = re.exec(line)) !== null) {
      const name = match[1];
      if (!imported.has(name)) continue;

      // Saltar si está dentro de string
      const before = line.slice(0, match.index);
      const dq = (before.match(/"/g) ?? []).length;
      const sq = (before.match(/'/g) ?? []).length;
      if (dq % 2 !== 0 || sq % 2 !== 0) continue;

      // line, char, length, tokenTypeIndex, tokenModifiersBitmask
      builder.push(li, match.index, name.length, 0, 0);
    }
  }

  return builder.build();
}

// ─── Handler ─────────────────────────────────────────────────────────────────
connection.languages.semanticTokens.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  return getSemanticTokens(doc);
});
documents.onDidChangeContent(() => {
  connection.languages.semanticTokens.refresh();
});

documents.listen(connection);
connection.listen();
