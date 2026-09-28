# Capture du contrat santé du tunnel Debian

Outil de diagnostic local. Il ne déploie rien et ne modifie pas les unités systemd.

Depuis Debian :

```sh
(cd / && sudo -u codexbridge /usr/bin/env HOME=/var/lib/codexbridge CODEXBRIDGE_HOME=/var/lib/codexbridge CODEXBRIDGE_MANAGED=1 /usr/bin/node --env-file=/etc/codexbridge/environment /opt/codexbridge/current/scripts/capture-tunnel-health.mjs)
```

Le script lance le runtime officiel avec le même contrat que la production, sans `cloudflared.managed`, puis lit l'URL de base écrite par `--health.url-file`.

Il capture les trois routes officielles :
- `/healthz` : liveness, 200 quand le processus est vivant ;
- `/readyz` : readiness, 200 quand le tunnel est prêt, 503 tant qu'il reste gated ;
- `/health?details=true` : diagnostic JSON des composants observés.

Stdout et stderr sont bornés et la clé runtime est expurgée avant affichage. Le script n'interprète pas un simple HTTP 200 du diagnostic détaillé comme une preuve de readiness : la décision reste celle de `/readyz`.

Le service tunnel doit être arrêté avant cette capture pour éviter deux runtimes utilisant le même tunnel ID. La production, elle, est supervisée par `codexbridge-tunnel.service`.
