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

## Langues et pages légales

Le sélecteur FR/EN mémorise le choix dans `abc_lang` (localStorage). Les liens
légaux du pied de page suivent la langue : en EN ils pointent vers les pages
`-en`, en FR vers les pages FR. Les pages FR restent la version qui **fait foi**
(documents de droit français) ; les `-en` sont des traductions de courtoisie.

## Déploiement

Voir `DEPLOY.md`. En bref : repo GitHub connecté à Vercel (déploiement auto au
push, `build.mjs` exécuté comme buildCommand), ou en local `vercel --prod`.
