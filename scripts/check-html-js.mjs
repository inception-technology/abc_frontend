/**
 * Contrôle de syntaxe du JavaScript INLINE des pages HTML.
 *
 * La boutique est en vanilla sans build : un simple typo dans un <script> part
 * en production tel quel et casse la page en silence. Ce script compile (sans
 * l'exécuter) le JS inline de chaque page et échoue si une syntaxe est invalide.
 *
 * Compile via `node:vm` : `new vm.Script` lève sur une erreur de syntaxe mais
 * n'exécute rien (on n'appelle jamais runInContext).
 *
 *   node scripts/check-html-js.mjs
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["index.html", "success.html", "cancel.html"];

// <script ...>…</script> SANS attribut src (donc du JS inline, pas un import).
const SCRIPT_RE = /<script\b(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
// Balises de données (ex. <script id="abc-catalog" type="application/json">) :
// ce n'est pas du JS, on ne les compile pas.
const NON_JS_TYPE = /type\s*=\s*["'](?!text\/javascript|module|application\/javascript)[^"']+["']/i;

let failures = 0;

for (const file of FILES) {
  const html = await readFile(join(ROOT, file), "utf8");
  let match;
  let index = 0;
  SCRIPT_RE.lastIndex = 0;
  while ((match = SCRIPT_RE.exec(html)) !== null) {
    index += 1;
    const [, attrs, code] = match;
    if (NON_JS_TYPE.test(attrs)) continue; // JSON embarqué, etc.
    if (!code.trim()) continue;
    try {
      new vm.Script(code, { filename: `${file}#script${index}` });
    } catch (err) {
      failures += 1;
      console.error(`✗ ${file} (script #${index}) : ${err.message}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} erreur(s) de syntaxe JS inline.`);
  process.exit(1);
}
console.log("✓ JS inline valide (index.html, success.html, cancel.html)");
