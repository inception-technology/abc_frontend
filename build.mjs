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

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, "index.html");
const SITEMAP = join(HERE, "sitemap.xml");
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

//: Échappatoire explicite pour publier SANS le catalogue (voir `main`). Doit
//: rester un geste conscient : c'est un site sans contenu indexable.
const ALLOW_EMPTY = process.env.ABC_ALLOW_EMPTY_CATALOG === "1";

//: L'API est réveillée par le build lui-même et peut être en cours de
//: redéploiement (Railway redéploie sur push, comme Vercel). Une seule
//: tentative transforme une fenêtre de quelques secondes en site vide : on
//: réessaie avant de conclure quoi que ce soit.
const FETCH_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [3_000, 8_000];

/** URL de l'API : variable d'env, sinon celle codée dans index.html. */
function resolveApiBase(html) {
  const fromEnv = (process.env.ABC_API_BASE || "").trim();
  const base = fromEnv || (html.match(/window\.ABC_API_BASE\s*=\s*"([^"]*)"/) || [])[1] || "";
  if (!base) return "";
  return base.endsWith("/") ? base : base + "/";
}

async function fetchCatalogOnce(apiBase) {
  const url = apiBase + "api/products";
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("réponse inattendue (pas un tableau)");
  return list;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Récupère le catalogue, avec quelques tentatives espacées.
 *
 * Le cas visé n'est pas une API morte mais une API qui redémarre : pousser le
 * backend et le front à quelques minutes d'intervalle suffit à faire tomber le
 * build dans la fenêtre de redéploiement. C'est ce qui s'est produit le
 * 2026-07-20 — le site est resté en ligne, mais sans une seule URL indexable.
 */
async function fetchCatalog(apiBase) {
  let derniere;
  for (let essai = 1; essai <= FETCH_ATTEMPTS; essai++) {
    try {
      return await fetchCatalogOnce(apiBase);
    } catch (e) {
      derniere = e;
      const delai = RETRY_DELAYS_MS[essai - 1];
      if (delai === undefined) break;
      console.warn(`  ⚠ tentative ${essai}/${FETCH_ATTEMPTS} échouée (${e.message})`
                   + ` — nouvel essai dans ${delai / 1000}s`);
      await sleep(delai);
    }
  }
  throw derniere;
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

// Libellés localisés des pages produit (FR / EN). Les couleurs/catégories libres
// restent en FR tant que le chantier #06 (traduction) n'est pas fait.
const I18N = {
  fr: {
    htmlLang: "fr", suffix: "pièce unique upcyclée",
    color: "Couleur", size: "Taille", ref: "Réf.",
    available: "Disponible", soldout: "Épuisé", freeShip: "Livraison offerte",
    unique: "Pièce unique", handmade: "Faite main en France",
    buy: "Voir la pièce sur la boutique", back: "← Retour à la boutique",
    metaTail: "Faite main en France — art wearable, détournement, culture urbaine.",
    cat: { tshirt: "T-shirt upcyclé", sweater: "Sweat upcyclé", jacket: "Veste upcyclée" },
    fallbackCat: "Vêtement upcyclé",
  },
  en: {
    htmlLang: "en", suffix: "one-of-a-kind upcycled piece",
    color: "Color", size: "Size", ref: "Ref.",
    available: "Available", soldout: "Sold out", freeShip: "Free shipping",
    unique: "One-of-a-kind", handmade: "Handmade in France",
    buy: "View this piece on the shop", back: "← Back to the shop",
    metaTail: "Handmade in France — wearable art, reappropriation, urban culture.",
    cat: { tshirt: "Upcycled t-shirt", sweater: "Upcycled sweater", jacket: "Upcycled jacket" },
    fallbackCat: "Upcycled garment",
  },
};

// Couleurs saisies en FRANÇAIS dans l'admin : traduites à l'affichage sur les
// pages EN. Couleur inconnue -> valeur FR conservée (jamais vide).
// ⚠ Garder synchronisé avec la table homonyme d'index.html (boutique).
const COLOR_EN = {
  "beige": "Beige", "blanc": "White", "bleu": "Blue", "bordeaux": "Burgundy",
  "camouflage": "Camouflage", "cuivré": "Copper", "écru": "Off-white",
  "gris": "Grey", "gris chiné": "Heather grey", "gris chiné clair": "Light heather grey",
  "javellisé": "Bleached", "jaune": "Yellow", "jean": "Denim", "kaki": "Khaki",
  "marron": "Brown", "multicolor": "Multicolor", "multicolore": "Multicolor",
  "noir": "Black", "orange": "Orange", "rose": "Pink", "rouge": "Red",
  "tie dye noir": "Black tie-dye", "tie dye rouge": "Red tie-dye",
  "vert": "Green", "violet": "Purple",
};

/** Libellé couleur localisé (FR tel quel ; EN via la table, repli FR). */
function colorLabel(color, lang) {
  if (!color) return "";
  if (lang !== "en") return color;
  return COLOR_EN[String(color).trim().toLowerCase()] || color;
}

// Pages légales versionnées (URLs propres via cleanUrls) pour le sitemap.
const LEGAL = [
  ["cgv", "0.3"], ["conditions", "0.3"], ["confidentialite", "0.3"],
  ["cgv-en", "0.2"], ["conditions-en", "0.2"], ["confidentialite-en", "0.2"],
];

/** Slug URL depuis un nom : minuscules, sans accents, tirets. */
function slug(s) {
  return String(s).toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "piece";
}

/** Map id -> slug UNIQUE (collision de noms -> suffixe id). */
function buildSlugs(list) {
  const used = new Set(), map = new Map();
  for (const p of list) {
    const base = slug(p.name);
    let s = base, n = 2;
    if (used.has(s)) s = `${base}-${p.id}`;
    while (used.has(s)) s = `${base}-${p.id}-${n++}`;
    used.add(s);
    map.set(p.id, s);
  }
  return map;
}

/** JSON-LD Product (Offer) d'une page produit. */
function productLdJson(p, canonical, lang) {
  const L = I18N[lang];
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": canonical + "#product",
    name: p.name,
    category: L.cat[p.cat] || L.fallbackCat,
    brand: { "@type": "Brand", name: "ART BEYOND CONVENIENCE" },
    offers: {
      "@type": "Offer",
      url: canonical,
      price: Number(p.price || 0).toFixed(2),
      priceCurrency: "EUR",
      availability: Number(p.qty) > 0
        ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
      seller: { "@id": `${SITE}/#organization` },
    },
  };
  const desc = ((lang === "en" ? p.descEn : p.descFr) || p.descFr || "").trim();
  if (desc) data.description = desc.slice(0, 400);
  const img = absImage(p.img);
  if (img) data.image = img;
  if (p.ref) data.sku = p.ref;
  const color = colorLabel(p.color, lang);
  if (color) data.color = color;
  if (p.size) data.size = p.size;
  return JSON.stringify(data).replace(/<\//g, "<\\/");
}

/** Page produit statique complète (SEO : head, canonical, hreflang, JSON-LD). */
function productPageHtml(p, lang, slugStr) {
  const L = I18N[lang];
  const frUrl = `${SITE}/piece/${slugStr}`, enUrl = `${SITE}/en/piece/${slugStr}`;
  const canonical = lang === "en" ? enUrl : frUrl;
  const img = absImage(p.img);
  const catLabel = L.cat[p.cat] || L.fallbackCat;
  const desc = ((lang === "en" ? p.descEn : p.descFr) || p.descFr || "").trim();
  const metaDesc = (desc || `${p.name} — ${L.suffix}. ${L.metaTail}`).replace(/\s+/g, " ").slice(0, 160);
  const price = Number(p.price || 0).toFixed(2);
  const inStock = Number(p.qty) > 0;
  const color = colorLabel(p.color, lang);
  const specs = [
    color ? `${L.color} · ${escHtml(color)}` : "",
    p.size ? `${L.size} · ${escHtml(p.size)}` : "",
    p.ref ? `${L.ref} ${escHtml(p.ref)}` : "",
  ].filter(Boolean);
  const alt = `${escHtml(p.name)} — ${escHtml(catLabel.toLowerCase())}, ${L.suffix}`
    + (color ? `, ${escHtml(color)}` : "");
  return `<!doctype html>
<html lang="${L.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(p.name)} — ${L.suffix} | ART BEYOND CONVENIENCE</title>
<meta name="description" content="${escHtml(metaDesc)}">
<link rel="canonical" href="${canonical}">
<link rel="alternate" hreflang="fr" href="${frUrl}">
<link rel="alternate" hreflang="en" href="${enUrl}">
<link rel="alternate" hreflang="x-default" href="${frUrl}">
<meta name="theme-color" content="#12100f">
<link rel="icon" href="/favicon.ico" sizes="any">
<meta property="og:type" content="website">
<meta property="og:site_name" content="ART BEYOND CONVENIENCE">
<meta property="og:locale" content="${lang === "en" ? "en_GB" : "fr_FR"}">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${escHtml(p.name)} — ${L.suffix}">
<meta property="og:description" content="${escHtml(metaDesc)}">${img ? `\n<meta property="og:image" content="${escHtml(img)}">` : ""}
<meta name="twitter:card" content="summary_large_image">${img ? `\n<meta name="twitter:image" content="${escHtml(img)}">` : ""}
<script type="application/ld+json">${productLdJson(p, canonical, lang)}</script>
<style>
  @font-face{font-family:'Syne';font-weight:800;font-display:swap;src:url('/fonts/syne-latin-800-normal.woff2') format('woff2')}
  @font-face{font-family:'Space Mono';font-weight:400;font-display:swap;src:url('/fonts/space-mono-latin-400-normal.woff2') format('woff2')}
  @font-face{font-family:'Space Mono';font-weight:700;font-display:swap;src:url('/fonts/space-mono-latin-700-normal.woff2') format('woff2')}
  *{box-sizing:border-box}
  body{margin:0;background:oklch(0.19 0.012 60);color:oklch(0.93 0.008 70);font-family:'Space Mono',ui-monospace,monospace;line-height:1.7;-webkit-font-smoothing:antialiased}
  a{color:oklch(0.72 0.13 55)}
  .wrap{max-width:1000px;margin:0 auto;padding:28px 20px 80px}
  .back{display:inline-block;font-size:12px;letter-spacing:0.06em;margin-bottom:26px}
  .grid{display:grid;grid-template-columns:1.1fr 1fr;gap:38px;align-items:start}
  @media(max-width:720px){.grid{grid-template-columns:1fr;gap:24px}}
  .ph{background:oklch(0.16 0.01 60);border-radius:10px;overflow:hidden;aspect-ratio:1/1}
  .ph img{width:100%;height:100%;object-fit:cover;display:block}
  .eyebrow{font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:oklch(0.72 0.13 55);margin:0 0 12px}
  h1{font-family:'Syne',sans-serif;font-weight:800;font-size:clamp(26px,5vw,42px);line-height:1.03;letter-spacing:-0.01em;margin:0 0 8px;text-wrap:balance}
  .unique{font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:oklch(0.7 0.012 70);margin:0 0 22px}
  .desc{font-size:14px;color:oklch(0.87 0.01 70);max-width:54ch}
  .specs{list-style:none;padding:0;margin:22px 0;display:flex;flex-direction:column;gap:6px;font-size:12px;letter-spacing:0.04em;color:oklch(0.75 0.012 70)}
  .price{font-family:'Syne',sans-serif;font-weight:800;font-size:26px;margin:8px 0 2px}
  .avail{font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:oklch(0.7 0.14 150);margin:0}
  .avail.out{color:oklch(0.62 0.17 28)}
  .buy{display:inline-block;margin-top:20px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;font-weight:700;padding:13px 22px;background:oklch(0.74 0.13 55);color:oklch(0.19 0.012 60);border-radius:4px}
</style>
</head>
<body>
<main class="wrap">
  <a class="back" href="/">${L.back}</a>
  <div class="grid">
    <div class="ph">${img ? `<img src="${escHtml(img)}" alt="${alt}" width="900" height="900">` : ""}</div>
    <div>
      <p class="eyebrow">${escHtml(catLabel)}</p>
      <h1>${escHtml(p.name)}</h1>
      <p class="unique">${L.unique} · ${L.handmade}</p>
      ${desc ? `<p class="desc">${escHtml(desc)}</p>` : ""}
      <ul class="specs">${specs.map((s) => `<li>${s}</li>`).join("")}</ul>
      <p class="price">${price} €</p>
      <p class="avail ${inStock ? "in" : "out"}">${inStock ? L.available : L.soldout} · ${L.freeShip}</p>
      <p><a class="buy" href="/#piece-${escHtml(p.id)}">${L.buy} →</a></p>
    </div>
  </div>
</main>
</body>
</html>`;
}

/** Sitemap : accueil + pages légales + pages produit FR & EN (avec hreflang). */
function sitemapXml(list, slugs) {
  const urls = [`  <url><loc>${SITE}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`];
  for (const [path, pr] of LEGAL) urls.push(`  <url><loc>${SITE}/${path}</loc><priority>${pr}</priority></url>`);
  for (const p of list) {
    const s = slugs.get(p.id);
    const fr = `${SITE}/piece/${s}`, en = `${SITE}/en/piece/${s}`;
    const alt = `<xhtml:link rel="alternate" hreflang="fr" href="${fr}"/>`
      + `<xhtml:link rel="alternate" hreflang="en" href="${en}"/>`
      + `<xhtml:link rel="alternate" hreflang="x-default" href="${fr}"/>`;
    urls.push(`  <url><loc>${fr}</loc>${alt}<priority>0.8</priority></url>`);
    urls.push(`  <url><loc>${en}</loc>${alt}<priority>0.7</priority></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`
    + `${urls.join("\n")}\n</urlset>\n`;
}

/** Écrit les pages produit statiques (FR + EN) et régénère le sitemap. */
async function writeProductPages(list) {
  const slugs = buildSlugs(list);
  await mkdir(join(HERE, "piece"), { recursive: true });
  await mkdir(join(HERE, "en", "piece"), { recursive: true });
  for (const p of list) {
    const s = slugs.get(p.id);
    await writeFile(join(HERE, "piece", `${s}.html`), productPageHtml(p, "fr", s), "utf8");
    await writeFile(join(HERE, "en", "piece", `${s}.html`), productPageHtml(p, "en", s), "utf8");
  }
  await writeFile(SITEMAP, sitemapXml(list, slugs), "utf8");
}

/**
 * Catalogue inaccessible : on ÉCHOUE, sauf autorisation explicite.
 *
 * Ce build dégradait en silence — avertissement dans les logs, déploiement
 * vert, et un site sans catalogue prérendu, sans page produit et avec un
 * sitemap réduit aux pages légales. Le 2026-07-20, un déploiement du front
 * lancé pendant un redéploiement du backend a ainsi retiré **34 URLs
 * indexables** sans que rien ne le signale : la boutique restait fonctionnelle
 * pour un visiteur (le catalogue est récupéré au runtime), donc invisible à
 * l'œil, mais vide pour un moteur de recherche.
 *
 * Un déploiement bloqué se voit et se relance en un clic ; une éclipse SEO ne
 * se voit pas et dure jusqu'au prochain build. L'échec est le moindre mal.
 *
 * `ABC_ALLOW_EMPTY_CATALOG=1` reste la sortie de secours pour livrer un
 * correctif front pendant que l'API est indisponible — geste conscient, tracé
 * dans les logs.
 */
function abandonner(raison) {
  if (CHECK_ONLY) {
    // `--check` tourne en CI pour vérifier le CODE (balises présentes, script
    // exécutable), pas la production. Le faire dépendre de la disponibilité de
    // Railway ferait échouer des PR sans rapport — y compris celles qui ne
    // touchent pas au catalogue. On tolère donc ici, et seulement ici : ce
    // chemin n'écrit rien et ne publie rien.
    console.warn(`⚠ ${raison}`);
    console.warn("  --check : toléré, ce mode ne publie pas. Un vrai build");
    console.warn("  échouerait ici.");
    return;
  }
  if (ALLOW_EMPTY) {
    console.warn(`⚠ ${raison}`);
    console.warn("  ABC_ALLOW_EMPTY_CATALOG=1 : on publie SANS catalogue.");
    console.warn("  Le site n'aura ni page produit, ni sitemap complet, ni");
    console.warn("  contenu crawlable. Redéployez dès que l'API répond.");
    return;
  }
  console.error(`✗ ${raison}`);
  console.error("  Build interrompu : publier maintenant retirerait le catalogue");
  console.error("  prérendu, les pages produit et le sitemap complet — sans que");
  console.error("  le site paraisse cassé, puisque le catalogue est aussi");
  console.error("  récupéré au runtime. Le déploiement précédent reste en ligne.");
  console.error("  Vérifiez l'API, puis relancez le déploiement.");
  console.error("  Pour publier malgré tout : ABC_ALLOW_EMPTY_CATALOG=1");
  process.exit(1);
}

async function main() {
  let html = await readFile(INDEX, "utf8");

  if (!MARKER.test(html)) {
    console.error('✗ balise <script id="abc-catalog"> introuvable dans index.html');
    process.exit(1); // erreur de code, pas d'environnement : on échoue franchement
  }

  const apiBase = resolveApiBase(html);
  if (!apiBase) {
    abandonner("aucune URL d'API résolue (ABC_API_BASE ou window.ABC_API_BASE)");
    return;
  }

  let list;
  try {
    list = await fetchCatalog(apiBase);
  } catch (e) {
    abandonner(`API injoignable après ${FETCH_ATTEMPTS} tentatives (${e.message})`);
    return;
  }

  console.log(`  API   : ${apiBase}api/products`);
  console.log(`  Injecté : ${summarize(list)}`);
  if (list.length === 0) {
    // À distinguer d'une API injoignable : ici elle a répondu, et sa réponse
    // est un catalogue vide. Depuis que tout article naît brouillon, c'est un
    // état légitime — mais qui produit un site sans contenu indexable, donc on
    // le dit franchement au lieu de le glisser dans le résumé.
    console.warn("  ⚠ l'API répond, mais AUCUNE pièce n'est publiée.");
    console.warn("    Le site sera en ligne sans catalogue ni page produit.");
    console.warn("    Publiez au moins une pièce depuis /admin, puis redéployez.");
  }
  const hasItemList = ITEMLIST_MARKER.test(html);
  const hasPrerender = PRERENDER_MARKER.test(html);
  console.log(`  ItemList : ${hasItemList ? `${list.length} produit(s) en JSON-LD` : "balise absente — ignorée"}`);
  console.log(`  Prerender : ${hasPrerender ? `${list.length} pièce(s) en HTML crawlable` : "balise absente — ignorée"}`);
  console.log(`  Pages produit : ${list.length} FR + ${list.length} EN + sitemap.xml`);
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
  await writeProductPages(list);
  console.log(`  → index.html + ${list.length} pages produit FR + ${list.length} EN + sitemap.xml`);
}

main().catch((e) => {
  console.error("✗ build:", e);
  process.exit(1);
});
