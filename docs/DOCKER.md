# Docker

Le service `codexbridge` conserve la DB/worktrees dans `/data` et l’auth Codex dans un volume séparé. Les dépôts accessibles se trouvent sous `/repos`. Le serveur s’exécute comme utilisateur non root `node`.

```sh
docker compose build
docker compose run --rm codexbridge setup
docker compose run --rm --entrypoint codex codexbridge login --device-auth
```

Avant `up`, modifier `/data/config.json` dans le volume : `host: "0.0.0.0"`, `repositoryRoots: ["/repos"]`, conserver le token. Copier vos clones sous `./repositories` et vérifier leurs permissions pour l’UID 1000. Puis :

```sh
docker compose up -d
docker compose exec codexbridge node dist/cli.js doctor
docker compose logs -f codexbridge
```

Le port hôte reste lié à 127.0.0.1. Pour un accès distant, ajouter un reverse proxy HTTPS et le fournisseur OAuth décrit dans CHATGPT.md. Ne pas ouvrir le port brut au public. Les credentials ne sont jamais intégrés à l’image. Pour le reviewer API, injecter la clé à l’exécution via votre gestionnaire de secrets, pas via un build arg.

Un worktree contient des liens absolus vers son dépôt Git : garder les chemins et volumes stables, sauvegarder `/data` et les dépôts ensemble. SQLite/WAL doit rester sur volume local. Ne pas déplacer seulement un worktree ou utiliser un partage réseau pour la DB.

Le build fige une version de CLI via `CODEX_VERSION`. Après changement de version, exécuter le test réel sur l’hôte cible. Le fonctionnement de la sandbox Codex dans Docker dépend des fonctionnalités noyau du runtime ; ce packaging n’a pas valeur de validation sur votre hôte. Ne pas désactiver la sandbox ni lancer privileged pour contourner un échec. Le développement local n’exige pas Docker.
