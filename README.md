# ART BEYOND CONVENIENCE — Frontend (boutique)

Boutique statique (mosaïque à recomposition, panier, FR/EN), sans dépendances ni
framework. **Repo public → Vercel.** Le backend/admin est dans un **repo séparé (privé)**.

## Contenu

- `index.html` — la boutique complète (HTML/CSS/JS, sans dépendances).
- `cgv.html`, `conditions.html`, `confidentialite.html` — pages légales (droit
  français, **font foi**).
- `cgv-en.html`, `conditions-en.html`, `confidentialite-en.html` — traductions de
  courtoisie en anglais (bandeau précisant que la version FR prévaut).
- `success.html`, `cancel.html` — pages de retour Stripe (lisent `abc_lang`,
  titre et textes selon la langue).
- `fonts/` — polices auto-hébergées (Syne, Space Mono) : **aucune requête vers
  Google Fonts** (RGPD).
- `img/` — photos produits servies par la boutique.
- `favicon.ico`, `logo.png` — identité visuelle.
- `build.mjs` — script de build Vercel (voir ci-dessous).
- `vercel.json` — config Vercel (cleanUrls, en-têtes de sécurité, cache des polices).
- `dev-server.py` — serveur local de dev (non déployé, voir `.vercelignore`).

## Catalogue : snapshot au build + stock en direct

La boutique **n'embarque pas** de catalogue de secours : sur une base vide, elle
affiche « catalogue indisponible » plutôt qu'un faux catalogue.

L'API de prod est déjà déclarée en haut d'`index.html` :

```html
<script>window.ABC_API_BASE = "https://ton-api.up.railway.app/";</script>
```

Au **déploiement**, `build.mjs` interroge `GET /api/products` et injecte le
catalogue (noms, images, descriptions, prix) dans `index.html`. La mosaïque
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

## Langues et pages légales

Le sélecteur FR/EN mémorise le choix dans `abc_lang` (localStorage). Les liens
légaux du pied de page suivent la langue : en EN ils pointent vers les pages
`-en`, en FR vers les pages FR. Les pages FR restent la version qui **fait foi**
(documents de droit français) ; les `-en` sont des traductions de courtoisie.

## Déploiement

Voir `DEPLOY.md`. En bref : repo GitHub connecté à Vercel (déploiement auto au
push, `build.mjs` exécuté comme buildCommand), ou en local `vercel --prod`.
