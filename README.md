# ART BEYOND CONVENIENCE — Frontend (boutique)

Boutique statique (thème sombre éditorial, grille de pièces, panier, FR/EN),
sans dépendances ni framework. **Repo public → Vercel.** Le backend/admin est
dans un **repo séparé (privé)**.

## Contenu

- `index.html` — la boutique complète (HTML/CSS/JS, sans dépendances).
- `cgv.html`, `conditions.html`, `confidentialite.html` — pages légales (droit
  français, **font foi**).
- `cgv-en.html`, `conditions-en.html`, `confidentialite-en.html` — traductions de
  courtoisie en anglais (bandeau précisant que la version FR prévaut).
- `success.html`, `cancel.html` — pages de retour Stripe (lisent `abc_lang`,
  titre et textes selon la langue).
- `fonts/` — polices auto-hébergées (Bricolage Grotesque, Space Grotesk, Space
  Mono) : **aucune requête vers Google Fonts** (RGPD).
- `img/` — photos produits servies par la boutique.
- `favicon.ico`, `logo.png` — identité visuelle.
- `build.mjs` — script de build Vercel (voir ci-dessous).
- `sitemap.xml`, `feed.xml`, `feed-en.xml` — **générés au build** par `build.mjs`
  (à partir du catalogue de l'API) : plan de site, et flux produits Google
  Merchant Center FR + EN (voir plus bas). Ne pas éditer à la main.
- `robots.txt` — déclare le sitemap ; interdit les pages de tunnel Stripe.
- `vercel.json` — config Vercel (cleanUrls, redirection `/fr*`, en-têtes de
  sécurité + CSP, cache des polices).
- `dev-server.py` — serveur local de dev (non déployé, voir `.vercelignore`).

## Catalogue : snapshot au build + stock en direct

La boutique **n'embarque pas** de catalogue de secours : sur une base vide, elle
affiche « catalogue indisponible » plutôt qu'un faux catalogue.

L'API de prod est déjà déclarée en haut d'`index.html` :

```html
<script>window.ABC_API_BASE = "https://ton-api.up.railway.app/";</script>
```

Au **déploiement**, `build.mjs` interroge `GET /api/products` et injecte le
catalogue (noms, images, descriptions, prix) dans `index.html`. La grille
s'affiche donc instantanément depuis le CDN Vercel, sans attendre le réveil de
Railway. Répartition des rôles :

- le **snapshot** fournit la *présentation* (figée au build) ;
- l'**API**, au runtime, fournit la *vérité du stock* (`qty` change à chaque vente).

Tant que l'API n'a pas répondu, la boutique **affiche mais ne vend pas**
(`state.stockTrusted`). Si l'API est injoignable au build, le déploiement n'échoue
pas : catalogue laissé vide, repli sur le fetch au runtime.

Images produits :
- fichiers relatifs (`cobain-27.jpg`…) → servis par cette boutique (`img/`) ;
- URLs absolues (Cloudflare R2) renvoyées par l'admin → utilisées telles quelles.

## Contenu éditable de la vitrine

Réseaux sociaux, section « À propos » (texte FR/EN + photo) et lien de la playlist
SoundCloud sont **pilotés depuis l'admin** (backend, module `site_content`), plus
codés en dur. Même mécanique que le catalogue :

- au build, `build.mjs` lit `GET /api/site-content` et injecte le résultat dans
  l'îlot `<script id="abc-site-content">` d'`index.html` (échec **non fatal** :
  les valeurs par défaut intégrées à la page sont conservées) ;
- au runtime, `applySiteContent()` applique ces valeurs **par-dessus** les défauts
  — hrefs des réseaux, lecteur SoundCloud, textes « À propos », photo du portrait.
  Un champ laissé vide garde le contenu intégré.

## Mesure d'audience (Cloudflare Web Analytics)

**Inerte par défaut.** Sans la variable `CF_ANALYTICS_TOKEN`, aucun script de
mesure n'est posé et la boutique ne charge rien de tiers — c'est l'état du
développement, de la CI, et de la production tant que la variable n'est pas
posée dans Vercel.

Choix assumé : Cloudflare Web Analytics **ne pose aucun cookie** et ne piste pas
d'un site à l'autre. Pas de bandeau de consentement à ajouter, ce qui cadre avec
la posture de confidentialité du reste du projet (polices auto-hébergées, RGPD).
La boutique étant sur Vercel et non derrière le proxy Cloudflare, on pose le
« beacon » à la main, au build.

**Activer** : créer un site dans Cloudflare (*Web Analytics → Add a site*, hôte
`www.artbeyondconvenience.fr`), copier le **jeton** (la valeur entre guillemets de `data-cf-beacon='{"token":"…"}'`) du snippet proposé
— *sans coller le snippet lui-même* —, puis poser `CF_ANALYTICS_TOKEN` dans les
variables du projet Vercel et redéployer. `build.mjs` injecte alors le beacon sur
**toutes** les pages (accueil, produits, légales, succès/annulation). Le jeton
n'est pas un secret (il est visible dans le HTML servi) ; on le passe par
l'environnement pour garder l'inertie par défaut et ne rien coder de spécifique
au site dans ce dépôt public. Les deux hôtes Cloudflare sont déjà autorisés dans
la CSP de `vercel.json`. Garde-fou en CI : `scripts/check-analytics.mjs`.

## Flux produits Google Merchant Center

`build.mjs` génère **deux flux** au même moment que les pages produit, depuis le
**même catalogue** (`GET /api/products`) :

- `feed.xml` — marché **FR** (liens `/piece/<slug>`, titres/descriptions FR) ;
- `feed-en.xml` — marché **EN** (liens `/en/piece/<slug>`, titres/couleurs EN).

Format **RSS 2.0 + namespace `g:`**, servi en `application/xml`. Dans Merchant
Center, on les branche en **récupération planifiée** (l'URL est relue chaque
jour) — méthode « Ajouter des produits à partir d'un fichier », **pas** import
ponctuel : le flux étant régénéré à chaque build, une pièce vendue en disparaît
au déploiement suivant.

Choix imposés par le modèle **pièces uniques faites main** (sinon refus Merchant
classiques) :

- `identifier_exists=no` — pas de GTIN ni MPN (sans quoi Google réclame un GTIN) ;
- `brand` — obligatoire dès qu'il n'y a pas de GTIN ;
- `condition=new` — produit fini vendu neuf, même si la matière est upcyclée ;
- `gender=unisex` / `age_group=adult` — requis pour la catégorie Vêtements,
  valeurs sûres faute de donnée par pièce ;
- `availability` — suit `qty` du build (jamais `in_stock` pour une pièce à
  `qty:0`) ; Merchant réconcilie ensuite via le JSON-LD des pages.

Cohérence de langue : le flux EN retombe sur un **repli EN générique** quand
`descEn` manque — jamais sur le texte FR (un flux EN contenant du FR se fait
refuser). Une pièce sans image ou sans prix valide est **écartée** (et comptée
dans le log de build), pas glissée en silence.

⚠️ **Devise** : les prix sont en **EUR** (ce que la boutique facture). Merchant
exige que la devise corresponde au pays cible du flux — cibler l'**Irlande**
(zone euro) pour l'EN, ou activer la **conversion automatique de devise** pour
viser UK/US.

## Langues et pages légales

Le sélecteur FR/EN mémorise le choix dans `abc_lang` (localStorage). Les liens
légaux du pied de page suivent la langue : en EN ils pointent vers les pages
`-en`, en FR vers les pages FR. Les pages FR restent la version qui **fait foi**
(documents de droit français) ; les `-en` sont des traductions de courtoisie.

## Déploiement

Voir `DEPLOY.md`. En bref : repo GitHub connecté à Vercel (déploiement auto au
push, `build.mjs` exécuté comme buildCommand), ou en local `vercel --prod`.

**Redirection `/fr`** : une ancienne version du site utilisait un préfixe de
langue `/fr` dans ses URLs ; Google avait indexé `…/fr`, qui renvoie désormais
un 404 (le contenu est à la racine). `vercel.json` redirige donc `/fr` et
`/fr/*` en **308 permanent** vers `/`, ce qui supprime le 404 et transfère le
référencement vers la homepage.
