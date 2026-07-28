/**
 * Contrôle du beacon Cloudflare Web Analytics et de la CSP qui l'autorise.
 *
 * Deux choses à garantir :
 *   1. le beacon est INERTE sans jeton, posé proprement avec, et jamais
 *      dupliqué quand le build rejoue (idempotence) ;
 *   2. la CSP de `vercel.json` autorise EXACTEMENT les deux hôtes dont le beacon
 *      a besoin — sans quoi le navigateur le bloquerait, et la mesure serait
 *      silencieusement vide (le motif du chantier 07 : un vert trompeur).
 *
 *   node scripts/check-analytics.mjs
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beaconTag, withBeacon } from "../build.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

//: Forme réelle d'un jeton Cloudflare Web Analytics : 32 hexa. Fictif ici.
const JETON = "0123456789abcdef0123456789abcdef";
const PAGE = "<!doctype html><html><head><title>x</title></head><body>y</body></html>";

let failures = 0;
function check(nom, cond) {
  if (cond) return;
  failures++;
  console.error(`✗ ${nom}`);
}

// --------------------------------------------------------------------------- #
// beaconTag — inerte sans jeton, robuste aux valeurs douteuses
// --------------------------------------------------------------------------- #
check("sans jeton, aucune balise", beaconTag("") === "" && beaconTag(undefined) === "");
check("jeton d'espaces seuls, aucune balise", beaconTag("   ") === "");

const tag = beaconTag(JETON);
check("jeton valide -> balise avec le bon hôte de script",
  tag.includes("https://static.cloudflareinsights.com/beacon.min.js"));
check("jeton valide -> jeton présent dans data-cf-beacon",
  tag.includes(`"token": "${JETON}"`) && tag.includes("data-cf-beacon"));
check("balise différée (defer), pour ne pas retarder le rendu",
  /\bdefer\b/.test(tag));

// Une valeur qui n'a pas la forme d'un jeton doit être REFUSÉE, pas insérée :
// c'est la garde contre une injection dans l'attribut / le HTML. Ces cas
// déclenchent volontairement l'avertissement de beaconTag ; on le fait taire le
// temps du test pour ne pas polluer la sortie de la CI.
const warnOrig = console.warn;
console.warn = () => {};
try {
  check("jeton trop court refusé", beaconTag("abc") === "");
  check("jeton non hexadécimal refusé", beaconTag("z".repeat(32)) === "");
  check("tentative d'injection refusée",
    beaconTag(`x"}'></script><script>alert(1)</script>`) === "");
} finally {
  console.warn = warnOrig;
}

// --------------------------------------------------------------------------- #
// withBeacon — pose, idempotence, réversibilité
// --------------------------------------------------------------------------- #
const posee = withBeacon(PAGE, JETON);
check("beacon posé juste avant </head>", posee.includes(`\n${tag}</head>`));
check("une seule balise après une pose",
  (posee.match(/cloudflareinsights/g) || []).length === 1);

// Idempotence : rejouer le build ne doit pas empiler les balises.
check("idempotent : deux passes == une passe",
  withBeacon(posee, JETON) === posee);

// Réversibilité : retirer le jeton retire la balise au build suivant.
const retiree = withBeacon(posee, "");
check("jeton retiré -> plus de beacon", !retiree.includes("cloudflareinsights"));
check("page redevenue identique à l'originale", retiree === PAGE);

// Sans jeton et sans balise préexistante : la page ne bouge pas (aucun fichier
// touché dans l'arbre de travail — c'est le défaut, en dev et en CI).
check("sans jeton ni balise, page inchangée", withBeacon(PAGE, "") === PAGE);

// --------------------------------------------------------------------------- #
// La CSP autorise le beacon — et le dit là où c'est servi (vercel.json)
// --------------------------------------------------------------------------- #
const vercel = JSON.parse(await readFile(join(ROOT, "vercel.json"), "utf8"));
const csp = vercel.headers
  .flatMap((h) => h.headers)
  .find((h) => h.key === "Content-Security-Policy")?.value || "";

const scriptSrc = (csp.match(/script-src ([^;]*)/) || [])[1] || "";
const connectSrc = (csp.match(/connect-src ([^;]*)/) || [])[1] || "";
check("CSP script-src autorise le script du beacon",
  scriptSrc.includes("https://static.cloudflareinsights.com"));
check("CSP connect-src autorise l'envoi des mesures",
  connectSrc.includes("https://cloudflareinsights.com"));
// L'API doit rester joignable : on n'a pas cassé l'existant en ajoutant l'hôte.
check("CSP connect-src conserve l'API",
  connectSrc.includes("https://api.artbeyondconvenience.com"));

// --------------------------------------------------------------------------- #
if (failures > 0) {
  console.error(`\n${failures} échec(s) — beacon analytics / CSP.`);
  process.exit(1);
}
console.log("✓ beacon Cloudflare inerte par défaut, idempotent, CSP cohérente.");
