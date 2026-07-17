#!/usr/bin/env python3
"""Serveur de dev local pour la boutique ABC — stdlib uniquement, zéro dépendance.

Sert `frontend/` en statique ET expose `/api/products` sur la MÊME origine.
C'est tout l'intérêt : le navigateur ne fait plus d'appel cross-origin, donc
**pas de CORS à configurer** sur Railway pour tester en local.

    ┌─────────┐  http://localhost:8000        ┌──────────────┐
    │ browser │ ────────────────────────────► │ dev-server   │
    └─────────┘   index.html + /api/products  │  (ce script) │
                                              └──────┬───────┘
                                       --source live │ (côté serveur : pas de CORS)
                                                     ▼
                                            API Railway (prod)

Le script réécrit `window.ABC_API_BASE` à la volée (vers "" = même origine).
`index.html` n'est jamais modifié sur le disque.

USAGE
-----
    python dev-server.py                     # données PROD (proxy Railway)  ← défaut
    python dev-server.py --source seed       # données locales seed_products.json
    python dev-server.py --scenario error    # l'API renvoie 500
    python dev-server.py --scenario empty    # l'API renvoie []
    python dev-server.py --scenario slow     # cold start Railway simulé (5 s)
    python dev-server.py --scenario slow --delay 12
    python dev-server.py --port 3000

CE QU'IL FAUT VÉRIFIER (depuis la suppression du fallback, la boutique ne rend
plus QUE depuis l'API — il n'y a plus de filet) :

  1. --source live      → la mosaïque se construit, images R2 nettes, compteur
                          « N pièces » cohérent avec l'admin. LE test qui compte.
  2. --scenario slow    → « Chargement… » visible, puis la mosaïque apparaît.
                          Reproduit le cold start du plan gratuit Railway.
  3. --scenario error   → « Catalogue momentanément indisponible. » + compteur vide.
  4. --scenario empty   → même message (API up mais catalogue vide).
  5. Bouton FR/EN en état d'erreur → le message doit basculer de langue.
  6. --source seed      → 5 pièces s'affichent en placeholder numéroté : NORMAL,
                          le seed a des extensions périmées (voir note en bas).

⚠ Ce serveur sert index.html tel quel : la balise <script id="abc-catalog"> y est
  VIDE (le catalogue n'est injecté qu'au déploiement, par build.mjs). En local on
  teste donc le chemin « pas de snapshot » : mosaïque vide -> « Chargement… » ->
  l'API répond -> rendu + vente ouverte.

  Pour tester le chemin AVEC snapshot (celui de la prod) :

      node build.mjs            # injecte le catalogue depuis l'API prod
      python dev-server.py --scenario error   # puis coupe l'API

  Attendu : la mosaïque s'affiche quand même (snapshot), et le bandeau
  « Disponibilités non vérifiables » apparaît avec les boutons « Ajouter »
  inactifs. C'est LE scénario qui justifie tout ce dispositif.
  Pensez à `git checkout index.html` après, pour ne pas committer le snapshot.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(HERE, "..", "backend", "seed_products.json")
DEFAULT_UPSTREAM = "https://web-production-62bbe.up.railway.app/"

# Réécrit la ligne 9 d'index.html : window.ABC_API_BASE = "https://…" -> ""
API_BASE_RE = re.compile(rb'(window\.ABC_API_BASE\s*=\s*)"[^"]*"')


class Handler(SimpleHTTPRequestHandler):
    cfg = None  # injecté depuis main()

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    # -- logs lisibles : on masque le bruit des assets ----------------------
    def log_message(self, fmt, *args):
        msg = fmt % args
        if any(x in msg for x in (".jpg", ".png", ".ico", ".webp")):
            return
        sys.stderr.write("  %s\n" % msg)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # -- /api/products : scénarios + source --------------------------------
    def _api_products(self):
        cfg = self.cfg
        sc = cfg.scenario

        if sc == "slow":
            print("  … cold start simulé : %s s" % cfg.delay)
            time.sleep(cfg.delay)
        if sc == "error":
            print("  → 500 (scénario error)")
            return self._send_json({"detail": "Scénario error"}, status=500)
        if sc == "empty":
            print("  → [] (scénario empty)")
            return self._send_json([])

        if cfg.source == "seed":
            with open(SEED, encoding="utf-8") as f:
                data = json.load(f)
            print("  → %d produits (seed local)" % len(data))
            return self._send_json(data)

        # source = live : proxy serveur→serveur (pas de CORS)
        url = cfg.upstream.rstrip("/") + "/api/products"
        try:
            with urllib.request.urlopen(url, timeout=cfg.timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            print("  ✗ upstream HTTP %s" % e.code)
            return self._send_json({"detail": "upstream %s" % e.code}, status=502)
        except Exception as e:
            print("  ✗ upstream injoignable : %s" % e)
            print("    (Railway endormi ? réessaie, ou --source seed)")
            return self._send_json({"detail": str(e)}, status=502)
        print("  → %d produits (PROD via %s)" % (len(data), cfg.upstream))
        return self._send_json(data)

    # -- index.html : injection de l'API base ------------------------------
    def _serve_index(self):
        with open(os.path.join(HERE, "index.html"), "rb") as f:
            html = f.read()
        html, n = API_BASE_RE.subn(rb'\1""', html)
        if not n:
            print("  ! window.ABC_API_BASE introuvable — index.html a changé ?")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.send_header("Cache-Control", "no-store")  # pas de cache en dev
        self.end_headers()
        self.wfile.write(html)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.rstrip("/") == "/api/products":
            return self._api_products()
        if path in ("/", "/index.html"):
            return self._serve_index()
        return super().do_GET()


def main():
    p = argparse.ArgumentParser(
        description="Serveur de dev ABC (statique + /api/products même origine).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--source", choices=["live", "seed"], default="live",
                   help="live = proxy vers l'API prod (défaut) ; seed = JSON local")
    p.add_argument("--scenario", choices=["ok", "empty", "error", "slow"], default="ok")
    p.add_argument("--delay", type=float, default=5.0, help="secondes pour --scenario slow")
    p.add_argument("--upstream", default=os.environ.get("ABC_UPSTREAM", DEFAULT_UPSTREAM))
    p.add_argument("--timeout", type=float, default=30.0)
    cfg = p.parse_args()

    if cfg.source == "seed" and not os.path.exists(SEED):
        sys.exit("seed introuvable : %s" % SEED)

    Handler.cfg = cfg
    src = "PROD (%s)" % cfg.upstream if cfg.source == "live" else "seed local"
    print("\n  ABC dev  →  http://localhost:%d" % cfg.port)
    print("  source   :  %s" % src)
    print("  scénario :  %s%s" % (cfg.scenario, " (%.0fs)" % cfg.delay if cfg.scenario == "slow" else ""))
    print("  Ctrl+C pour arrêter\n")

    srv = ThreadingHTTPServer(("127.0.0.1", cfg.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  arrêt.\n")


if __name__ == "__main__":
    main()

# -----------------------------------------------------------------------------
# NOTE — `--source seed` : 5 pièces s'affichent en placeholder numéroté
# (Cobain 27, Emo Lisabeth T, Tyler Champ, Marylin Off, Army Walk). Ce n'est pas
# un bug du serveur : seed_products.json référence des .jpg alors que les
# fichiers sur disque sont des .png. Le seed ne sert qu'à initialiser la base ;
# la prod pointe sur R2. À corriger seulement si un re-seed est prévu un jour.
# -----------------------------------------------------------------------------
