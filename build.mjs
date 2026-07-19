/**
 * Build de déploiement : injecte le catalogue dans index.html.
 *
 * POURQUOI
 * --------
 * Aujourd'hui la boutique fait une cascade : HTML -> JS -> fetch API -> rendu.
 * Le dernier maillon dépend de Railway, qui dort sur le plan gratuit. Un cold
 * start = « catalogue indisponible » pour le visiteur, et un Googlebot qui ne
 * voit aucun produit.
 *
 * Ce script interroge l'API AU MOMENT DU DÉPLOIEMENT et écrit le résultat dans
 * index.html. La mosaïque s'affiche alors instantanément, depuis le CDN Vercel,
 * sans dépendre de Railway.
 *
 * LE STOCK N'EST PAS DANS LE SNAPSHOT — enfin, si, mais il n'est PAS DE CONFIANCE
 * -----------------------------------------------------------------------------
 * Les pièces sont uniques : `qty` change à chaque vente, pas à chaque déploiement.
 * Un snapshat figé remontrerait donc des pièces vendues comme disponibles — le
 * problème exact qui a fait supprimer l'ancien catalogue en dur.
 *
 * D'où le partage des rôles, appliqué dans index.html :
 *   - le snapshot fournit la PRÉSENTATION (noms, images, descriptions, prix) ;
 *   - l'API fournit la VÉRITÉ du stock.
 * Tant que l'API n'a pas répondu, la boutique AFFICHE mais ne VEND PAS
 * (`state.stockTrusted` garde `canAdd()`).
 *
 * DÉGRADATION
 * -----------
 * Si l'API est injoignable au build, on n'échoue PAS le déploiement : on émet un
 * catalogue vide et on prévient bruyamment. Le site retombe alors sur son
 * comportement actuel (fetch au runtime). Bloquer une mise en ligne parce que
 * Railway dort serait pire que le mal.
 *
 * USAGE
 *   node build.mjs                 # utilise l'URL d'API de index.html
 *   ABC_API_BASE=... node build.mjs
 *   node build.mjs --check         # n'écrit rien, affiche ce qui serait injecté
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, "index.html");
const TIMEOUT_MS = 20_000;

// Balise cible dans index.html. Le contenu est remplacé à chaque build.
const MARKER = /(<script id="abc-catalog" type="application\/json">)([\s\S]*?)(<\/script>)/;

// Balise ItemList JSON-LD (données structurées du catalogue), même mécanique.
const ITEMLIST_MARKER = /(<script id="abc-itemlist" type="application\/ld\+json">)([\s\S]*?)(<\/script>)/;

// Balise du catalogue prérendu (contenu HTML crawlable), même mécanique.
const PRERENDER_MARKER = /(<noscript id="abc-prerender">)([\s\S]*?)(<\/noscript>)/;

// Domaine canonique du site : @id / URL / images relatives des données structurées.
const SITE = "https://www.artbeyondconvenience.fr";

// Libellés catégorie pour les données structurées (codes internes -> FR lisible).
const CAT_LABEL = { tshirt: "T-shirt upcyclé", sweater: "Sweat upcyclé", jacket: "Veste upcyclée" };

const CHECK_ONLY = process.argv.includes("--check");

/** URL de l'API : variable d'env, sinon celle codée dans index.html. */
function resolveApiBase(html) {
  const fromEnv = (process.env.ABC_API_BASE || "").trim();
  const base = fromEnv || (html.match(/window\.ABC_API_BASE\s*=\s*"([^"]*)"/) || [])[1] || "";
  if (!base) return "";
  return base.endsWith("/") ? base : base + "/";
}

async function fetchCatalog(apiBase) {
  const url = apiBase + "api/products";
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("réponse inattendue (pas un tableau)");
  return list;
}

/**
 * Sérialise pour une insertion dans <script>.
 * `</script>` à l'intérieur d'une chaîne fermerait la balise : on l'échappe.
 */
function toEmbeddedJson(list) {
  return JSON.stringify(list).replace(/<\//g, "<\\/");
}

function summarize(list) {
  const inStock = list.filter((p) => (p.qty || 0) > 0).length;
  return `${list.length} pièces (${inStock} en stock au moment du build)`;
}

/** URL absolue d'une image produit (R2 déjà absolu ; nom relatif -> /img/). */
function absImage(img) {
  const v = (img || "").trim();
  if (!v) return "";
  return /^https?:\/\//.test(v) ? v : `${SITE}/img/${v}`;
}

/**
 * Données structurées ItemList (Product + Offer) du catalogue, sérialisées pour
 * <script>. `availability` reflète le stock du build (règle Google Merchant :
 * ne pas déclarer InStock une pièce à qty:0). Prix en chaîne "xx.xx".
 */
function toItemListJson(list) {
  const items = list.map((p, i) => {
    const id = `${SITE}/#piece-${p.id}`;
    const product = {
      "@type": "Product",
      "@id": id,
      name: p.name,
      brand: { "@type": "Brand", name: "ART BEYOND CONVENIENCE" },
      offers: {
        "@type": "Offer",
        url: id,
        price: Number(p.price || 0).toFixed(2),
        priceCurrency: "EUR",
        availability: Number(p.qty) > 0
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
        itemCondition: "https://schema.org/NewCondition",
        seller: { "@id": `${SITE}/#organization` },
      },
    };
    const desc = (p.descFr || "").trim();
    if (desc) product.description = desc.slice(0, 320);
    const img = absImage(p.img);
    if (img) product.image = img;
    if (p.ref) product.sku = p.ref;
    if (p.color) product.color = p.color;
    if (p.size) product.size = p.size;
    if (p.cat && CAT_LABEL[p.cat]) product.category = CAT_LABEL[p.cat];
    return { "@type": "ListItem", position: i + 1, item: product };
  });
  const data = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Pièces uniques — ART BEYOND CONVENIENCE",
    numberOfItems: items.length,
    itemListElement: items,
  };
  return JSON.stringify(data).replace(/<\//g, "<\\/");
}

/** Échappe une valeur pour insertion dans du HTML (texte ou attribut). */
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Fragment HTML crawlable du catalogue (nom, image + alt descriptif, desc, prix,
 * dispo). Placé dans un <noscript> : lu par tous les crawlers (dont ceux sans
 * rendu JS), invisible pour l'utilisateur JS. Contenu identique à la mosaïque.
 */
function toPrerenderHtml(list) {
  const cards = list.map((p) => {
    const cat = (CAT_LABEL[p.cat] || "vêtement upcyclé").toLowerCase();
    const img = absImage(p.img);
    const price = Number(p.price || 0).toFixed(2);
    const dispo = Number(p.qty) > 0 ? "Disponible" : "Épuisé";
    const alt = `${p.name} — ${cat} pièce unique`
      + (p.color ? `, ${p.color}` : "") + (p.size ? `, taille ${p.size}` : "");
    const specs = [
      p.color ? `Couleur : ${escHtml(p.color)}` : "",
      p.size ? `Taille : ${escHtml(p.size)}` : "",
      p.ref ? `Réf. ${escHtml(p.ref)}` : "",
    ].filter(Boolean).join(" · ");
    return `<article id="piece-${escHtml(p.id)}">`
      + `<h3>${escHtml(p.name)} — ${escHtml(cat)}, pièce unique</h3>`
      + (img ? `<img src="${escHtml(img)}" alt="${escHtml(alt)}" width="600" height="600" loading="lazy">` : "")
      + (p.descFr ? `<p>${escHtml(p.descFr)}</p>` : "")
      + (specs ? `<p>${specs}</p>` : "")
      + `<p>${price} € — ${dispo}</p>`
      + `</article>`;
  }).join("");
  return `<section aria-label="Catalogue des pièces uniques">`
    + `<h2>Pièces uniques upcyclées — le catalogue</h2>${cards}</section>`;
}

async function main() {
  let html = await readFile(INDEX, "utf8");

  if (!MARKER.test(html)) {
    console.error('✗ balise <script id="abc-catalog"> introuvable dans index.html');
    process.exit(1); // erreur de code, pas d'environnement : on échoue franchement
  }

  const apiBase = resolveApiBase(html);
  if (!apiBase) {
    console.warn("⚠ aucune URL d'API : catalogue laissé vide (fetch au runtime)");
    return;
  }

  let list;
  try {
    list = await fetchCatalog(apiBase);
  } catch (e) {
    // Railway endormi, réseau, 5xx... : on dégrade, on ne bloque pas la mise en ligne.
    console.warn(`⚠ API injoignable (${e.message}) — catalogue laissé vide.`);
    console.warn("  Le site retombe sur le fetch au runtime : la mosaïque restera");
    console.warn("  vide tant que l'API dort. Redéployez quand elle répond.");
    return;
  }

  console.log(`  API   : ${apiBase}api/products`);
  console.log(`  Injecté : ${summarize(list)}`);
  const hasItemList = ITEMLIST_MARKER.test(html);
  const hasPrerender = PRERENDER_MARKER.test(html);
  console.log(`  ItemList : ${hasItemList ? `${list.length} produit(s) en JSON-LD` : "balise absente — ignorée"}`);
  console.log(`  Prerender : ${hasPrerender ? `${list.length} pièce(s) en HTML crawlable` : "balise absente — ignorée"}`);
  if (CHECK_ONLY) {
    console.log("  --check : rien n'a été écrit.");
    return;
  }

  html = html.replace(MARKER, (_m, open, _old, close) => open + toEmbeddedJson(list) + close);
  if (hasItemList) {
    html = html.replace(ITEMLIST_MARKER, (_m, open, _old, close) => open + toItemListJson(list) + close);
  }
  if (hasPrerender) {
    html = html.replace(PRERENDER_MARKER, (_m, open, _old, close) => open + toPrerenderHtml(list) + close);
  }
  await writeFile(INDEX, html, "utf8");
  console.log(`  → index.html mis à jour (${(html.length / 1024).toFixed(1)} Ko)`);
}

main().catch((e) => {
  console.error("✗ build:", e);
  process.exit(1);
});
