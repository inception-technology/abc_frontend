# Déployer la boutique sur Vercel

Ce dossier est la **boutique statique** (`index.html` + `img/`). Repo public → Vercel.

## Option A — Repo GitHub connecté (recommandé)

Vercel est connecté à ce repo public : chaque `git push` déclenche un déploiement.

```bash
git add -A && git commit -m "maj boutique" && git push
```

## Option B — Ligne de commande

```bash
npm i -g vercel      # une fois
cd "D:\02.Pro\06.Projets\Rachid\04.ABC\artbeyondconvenience\frontend"
vercel --prod
```

## Relier la boutique à l'API (Railway)

Pour charger le catalogue en direct, ajoute dans `index.html`, juste avant le
`<script>` principal :

```html
<script>window.ABC_API_BASE = "https://ton-api.up.railway.app/";</script>
```

Puis redéploie (push ou `vercel --prod`). Sans cette ligne, la boutique utilise son
catalogue embarqué — elle ne casse jamais. Côté Railway, `ALLOWED_ORIGINS` doit
contenir l'URL de cette boutique (CORS).

## Séparation front / back

- **Ce repo (public)** : uniquement la boutique. Aucun secret, aucun code serveur.
- **Repo backend (privé)** : API + admin + config Railway (dossier `backend/`).
