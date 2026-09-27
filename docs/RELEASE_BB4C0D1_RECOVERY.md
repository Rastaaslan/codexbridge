# Reprendre la release bb4c0d1 déjà construite

Ce bloc remplace intégralement l'ancienne procédure de reconstruction. La release `/opt/codexbridge/releases/bb4c0d1-clean-e6rISU4i` existe et son build a réussi sur Debian. Ne pas répéter `npm ci` ou le build.

L'échec précédent venait du répertoire courant hérité `/home/damien/codexbridge`, inaccessible au compte de service. Ici le shell root rejoint `/`, puis la release, **avant tout appel exécuté comme codexbridge**. Aucune commande Git n'est exécutée sous ce compte. Les empreintes SHA-256 ci-dessous proviennent des trois blobs du commit `bb4c0d12668fec0c5daf91854920f6a6213496d0`.

À exécuter manuellement sur Debian. Le bloc vérifie les fichiers, le build existant et les imports avant toute bascule. Il arrête le tunnel, remplace atomiquement `current`, redémarre l'orchestrateur puis lance la capture de 60 secondes. Le tunnel reste arrêté après la capture. Aucune release n'est supprimée. Un échec dans ce shell enfant ne ferme pas le shell interactif.

```bash
sudo bash <<'SH'
set -euo pipefail
cd /
release=/opt/codexbridge/releases/bb4c0d1-clean-e6rISU4i
cd "$release"
sha256sum -c <<'SUMS'
07afc028881a056396649ab9bb09f0745cad1767a28ce119070d57b047123a39  scripts/tunnel-linux.mjs
646cb5f99ad8e6b5233e86fe0eebaeb5218439a6e1688403512786db41eb4a16  scripts/tunnel-paths.mjs
608b0bd153decf7c24ed8ec5d32329db1c902cc00dad28ec4215e7fe9ba0e672  scripts/capture-tunnel-health.mjs
SUMS
sudo -u codexbridge test -s "$release/dist/cli.js"
sudo -u codexbridge /usr/bin/node --input-type=module -e 'await import("./scripts/capture-tunnel-health.mjs"); console.log("Imports OK; runtime not launched")'
test -L /opt/codexbridge/current
test ! -e "$release.current"
test ! -L "$release.current"
systemctl stop codexbridge-tunnel.service
ln -s -- "$release" "$release.current"
mv -Tf -- "$release.current" /opt/codexbridge/current
test "$(readlink /opt/codexbridge/current)" = "$release"
systemctl restart codexbridge.service
systemctl is-active --quiet codexbridge.service
sudo -u codexbridge /usr/bin/env HOME=/var/lib/codexbridge CODEXBRIDGE_HOME=/var/lib/codexbridge CODEXBRIDGE_MANAGED=1 /usr/bin/node --env-file=/etc/codexbridge/environment "$release/scripts/capture-tunnel-health.mjs"
SH
```

La vérification des imports ne lance pas le runtime ; seule la dernière commande lance explicitement le diagnostic. La clé est chargée depuis `/etc/codexbridge/environment`, sans valeur secrète dans les arguments. Le diagnostic masque la clé dans ses rapports.

Ce bloc n'a pas été exécuté sur Debian par l'agent. Sa syntaxe et les trois empreintes ont été vérifiées localement. La capture doit encore fournir le format réel du fichier URL et les réponses HTTP prêtes et non prêtes avant toute adaptation de `linuxStatus`. Ne pas assimiler HTTP 2xx à la disponibilité du tunnel.
