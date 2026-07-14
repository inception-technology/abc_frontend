# ART BEYOND CONVENIENCE — Frontend (boutique)

Boutique statique (mosaïque à recomposition, panier, FR/EN). **Repo public → Vercel.**

## Contenu

- `index.html` — la boutique complète (HTML/CSS/JS, sans dépendances).
- `img/` — photos produits.
- `vercel.json` — config Vercel (cleanUrls, cache des images).

## Catalogue en direct (API backend)

La boutique embarque un catalogue de secours et fonctionne seule. Pour charger le
catalogue **en direct** depuis le backend (Railway), ajoute cette ligne dans
`index.html`, juste avant le `<script>` principal, avec l'URL de ton API :

```html
<script>window.ABC_API_BASE = "https://ton-api.up.railway.app/";</script>
```

Les images produits :
- fichiers relatifs (`cobain-27.jpg`…) → servis par cette boutique (`img/`) ;
- URLs absolues (Cloudflare R2) renvoyées par l'admin → utilisées telles quelles.

## Déploiement

Voir `DEPLOY.md`. En bref : repo GitHub connecté à Vercel (déploiement auto au push),
ou en local `vercel --prod`.

> Le code du backend/admin est dans un **repo séparé (privé)**.
