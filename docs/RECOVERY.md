# Vérifier la reprise

Au démarrage, la récupération inspecte les jobs actifs interrompus, conserve un diagnostic dans `blocker` et émet un événement `RECOVERY`. Le job passe d’abord à `FAILED`, mais cet état ne signifie pas toujours qu’une intervention humaine est nécessaire : un worker interrompu en `CODEX_RUNNING` **sans résultat enregistré** utilise la politique de retry runtime automatique. Les autres états actifs interrompus, ainsi que `CODEX_RUNNING` avec un résultat déjà enregistré, deviennent `FAILED` sans nouveau retry automatique. La récupération ne valide pas arbitrairement le travail.

## Retry automatique, backoff et épuisement

Pour un worker éligible, si `retry.count < maxRuntimeRetries`, la récupération incrémente `retry.count`, enregistre `retry.lastError` et `retry.nextRetryAt`, puis émet `RUNTIME_RETRY_SCHEDULED`. Le délai est `min(retryMaxBackoffMs, retryBackoffMs × 2^n)`, où `n` est le compteur avant incrément. Les valeurs par défaut sont trois retries, un délai initial de 5 secondes et un plafond de 300 secondes : les trois délais sont donc 5, 10 et 20 secondes.

À l’échéance, le scheduler remet le job `FAILED` en `QUEUED` si aucun passage ni enfant précédent n’est encore actif, puis efface `nextRetryAt`. Le lancement reste soumis aux contrôles habituels de maintenance, pause, dépendances et capacité. La récupération elle-même ne lance pas le worker. Le compteur et l’échéance sont persistés ; un nouveau redémarrage ne réinitialise pas le backoff d’un job déjà `FAILED`.

Si le compteur a déjà atteint `maxRuntimeRetries`, l’échec suivant laisse le job `FAILED` avec `retry.exhausted: true`, `nextRetryAt: null` et un événement `RUNTIME_RETRY_EXHAUSTED`. Aucun autre retry automatique n’est prévu. Avec `maxRuntimeRetries: 0`, le premier échec épuise immédiatement ce budget. Après inspection du diagnostic, un retry explicite depuis le dashboard ou MCP réinitialise le budget runtime et remet le job en queue, sous réserve qu’aucun enfant précédent ne soit vivant. Les résultats métier bloqués, tests échoués et rejets de review ne déclenchent pas cette politique de retry runtime.

## État conservé et enfant survivant

La reprise conserve la branche, le worktree, l’historique et le `codexThreadId` enregistré, s’il existe. Le prompt de recovery demande d’inspecter les changements et tests existants et de ne pas répéter les actions externes déjà réalisées.

L’itération réservée par un worker interrompu sans résultat est remboursée atomiquement avec l’état du retry (`iteration = max(0, iteration - 1)`), même si le budget runtime est épuisé. Ce passage n’a pas atteint la review : il ne doit pas consommer le budget de corrections. Les itérations antérieures et leurs reviews sont conservées ; le prochain passage réserve de nouveau une itération. Une seconde récupération du job déjà `FAILED` ne rembourse pas une autre itération.

Si le PID enfant enregistré est encore vivant, le diagnostic le signale et le verrou est conservé. Un retry peut être planifié, mais le scheduler ne le remet pas en queue, même après son échéance ; le retry explicite est également refusé. Vérifier l’identité et la ligne de commande du processus avant toute intervention. Attendre sa sortie ou l’arrêter explicitement dans le cadre autorisé ; ne pas tuer un PID réutilisé par une autre application et ne pas effacer un verrou à l’aveugle. Une fois l’enfant absent, le scheduler peut libérer le verrou et reprendre un retry arrivé à échéance, sans action manuelle supplémentaire.

## Vérification sur un environnement de test isolé

1. Démarrer le service, créer un job dans un dépôt fixture et attendre `CODEX_RUNNING` sans résultat enregistré.
2. Noter job, thread, branche, worktree, itération, compteur de retry, PID enfant et PID du serveur (`.codexbridge/server.lock`).
3. Arrêter brutalement **uniquement ce PID serveur vérifié**. Sous Windows : `Stop-Process -Id <pid-du-serveur> -Force`. Sous Linux : `kill -KILL <pid-du-serveur>`.
4. Redémarrer `codexbridge start`, puis consulter `codexbridge status` et `get_job_events`. Vérifier `RECOVERY`, le diagnostic et `RUNTIME_RETRY_SCHEDULED` ou `RUNTIME_RETRY_EXHAUSTED`. Le `FAILED` initial peut déjà avoir évolué si le délai est écoulé.
5. Si l’enfant survit, vérifier que la reprise reste bloquée même à l’échéance. Après sa sortie, laisser le scheduler reprendre automatiquement si un retry est prévu. En cas d’épuisement ou de passage non éligible, inspecter le diagnostic avant un retry explicite.
6. Vérifier même thread enregistré, même branche/worktree, historique conservé et remboursement de l’itération interrompue sans résultat. Vérifier ensuite la progression des itérations de correction.

Les tests hors ligne `tests/recovery.test.ts`, `tests/scheduler.test.ts` et `tests/core.test.ts` couvrent l’arrêt réel d’un processus fixture, la persistance SQLite, la reprise du thread/worktree, le backoff, l’épuisement, l’enfant survivant, les résultats déjà enregistrés et le budget d’itérations. Ils n’appellent pas de modèle.

`npm run test:live-recovery` utilise un vrai serveur et un vrai passage Codex, puis un retry explicite et une correction supplémentaire via MCP. Il suppose que le `FAILED` initial est encore observable avant le retry manuel ; ce script ne constitue pas une vérification déterministe du backoff automatique. Le succès rapporté le 23 septembre 2026 (même thread/worktree, cinq tests fixture réussis) est historique, pas une validation du candidat courant. Son rapport est conservé sous `.codexbridge/live-recovery/<timestamp>/report.json`.

Conserver le dossier de données et les dépôts pendant l’exploitation. Une erreur d’inspection du dépôt/worktree figure dans le diagnostic ; elle ne remplace pas les critères de retry ci-dessus. Une reprise peut donc être planifiée malgré cette erreur et échouer ensuite lors de la préparation. Inspecter et restaurer les données nécessaires avant de poursuivre.
