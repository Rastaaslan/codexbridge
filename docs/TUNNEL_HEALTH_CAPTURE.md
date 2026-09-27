# Capture du contrat santé v0.0.15 sur Debian

Outil de diagnostic local, sans modification du comportement de production. À exécuter manuellement seulement, lorsque le service tunnel est arrêté et que le script est disponible dans la release gérée. Il ne déploie rien, ne modifie pas les unités et ne démarre/arrête pas le service systemd.

Depuis Debian, lancer cette commande unique (Node 24 lit la clé depuis le fichier local ; aucune clé dans la ligne de commande) :

```sh
sudo -u codexbridge /usr/bin/env HOME=/var/lib/codexbridge CODEXBRIDGE_HOME=/var/lib/codexbridge CODEXBRIDGE_MANAGED=1 /usr/bin/node --env-file=/etc/codexbridge/environment /opt/codexbridge/current/scripts/capture-tunnel-health.mjs
```

Le script lit l'installation v0.0.15 et l'ID existants, puis lance le binaire réel `run` avec les variables et flags déjà établis. Le fichier `--health.url-file` et le PID de diagnostic sont placés dans un répertoire unique `/var/lib/codexbridge/health-capture-*`, sans écraser les fichiers du service. La cible MCP reste `/opt/codexbridge/current/dist/cli.js`.

Pendant 60 secondes, il affiche le contenu exact du fichier URL, le code HTTP, le type de contenu et le corps de chaque réponse. Aucun état `ready` n'est inféré. Un format de fichier inconnu est affiché sans tenter d'en deviner les champs. Seules les URL HTTP loopback sans identifiants sont interrogées, sans redirection. Les logs du runtime sont masqués et la clé API est expurgée du rapport. Le processus de diagnostic et ses enfants sont arrêtés à la fin ou sur Ctrl-C.

Transmettre les lignes représentatives au démarrage et après disponibilité du tunnel, ainsi que toute réponse non prête réellement observée. Ne pas fabriquer de panne ni de réponse pour compléter la capture. Si aucun état non prêt n'est observé, le préciser : une source officielle ou une capture complémentaire restera nécessaire. Relire le rapport avant partage pour retirer d'éventuelles informations privées autres que la clé API. Cette capture doit permettre d'établir les fixtures réelles avant toute correction de `linuxStatus`.
