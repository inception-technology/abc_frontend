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

## Mesure d'audience (facultatif)

Cloudflare Web Analytics, **inerte tant que `CF_ANALYTICS_TOKEN` n'est pas
posée**. Pour l'activer :

1. Cloudflare → **Web Analytics** → *Add a site* → hôte
   `www.artbeyondconvenience.fr`.
2. Dans le snippet affiché — `<script ... data-cf-beacon='{"token":"XXXX"}'>` —
   copier **uniquement la valeur `XXXX` entre les guillemets** (le jeton nu) :
   **ni le `<script>` complet, ni les guillemets, ni le `{"token":…}`**.
   `build.mjs` construit la balise avec les bons réglages de CSP.
3. Vercel → projet → *Settings → Environment Variables* → `CF_ANALYTICS_TOKEN` =
   le jeton nu, sur *Production*. Puis redéployer.
   *(Le build rejette une valeur contenant guillemets, espaces ou chevrons — une
   garde anti-injection — et le log de build le signale : « CF_ANALYTICS_TOKEN
   posé mais REJETÉ ».)*
4. Redéployer (push ou `vercel --prod`).

Le beacon est alors posé sur toutes les pages. Cookieless, sans bandeau de
consentement. Pour désactiver : retirer la variable et redéployer.

## Séparation front / back

- **Ce repo (public)** : uniquement la boutique. Aucun secret, aucun code serveur.
- **Repo backend (privé)** : API + admin + config Railway (dossier `backend/`).
