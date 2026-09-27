# Vérifier la reprise

Le choix V1 est conservateur : un passage interrompu est inspecté puis exposé comme `FAILED` avec un diagnostic et le thread original. L’opérateur déclenche retry ; il n’y a aucune validation arbitraire ni nouvelle exécution silencieuse.

1. Démarrer le service, créer un job dans un dépôt fixture et attendre `CODEX_RUNNING`.
2. Noter job, thread, branche, worktree et PID du serveur (`.codexbridge/server.lock`).
3. Arrêter brutalement **uniquement ce PID vérifié**. Sous Windows : `Stop-Process -Id <pid-du-serveur> -Force`. Sous Linux : `kill -KILL <pid-du-serveur>`.
4. Redémarrer `codexbridge start`, puis `codexbridge status`. Le job porte un diagnostic d’interruption. `get_job_events` contient `RECOVERY`.
5. Si le processus Codex enfant vit encore, retry reste bloqué. Vérifier sa ligne de commande et attendre sa sortie ou l’arrêter explicitement. Ne pas tuer un PID réutilisé par une autre application.
6. Retry depuis le dashboard ou MCP. Vérifier même `codexThreadId`, même branche/worktree ; le prompt de recovery exige l’inspection des changements existants. Le compteur continue. L’historique précédent reste consultable.

`npm run test:live-recovery` réalise également ce scénario avec un vrai serveur et un vrai passage Codex, puis demande une correction supplémentaire via MCP. Le 23 septembre 2026, ce test a réussi : même thread, même worktree, compteur continu, cinq tests fixture réussis. Le rapport est conservé sous `.codexbridge/live-recovery/<timestamp>/report.json`. Les tests hors ligne complètent cette preuve avec une reprise contrôlée et un arrêt réel de processus fixture sans appel de modèle.

Une suppression du dépôt/worktree produit une erreur explicite, pas un worktree reconstruit silencieusement à partir de prose. Conserver le dossier de données et les dépôts pendant l’exploitation. Un verrou restant avec PID vivant est traité de manière conservatrice ; il ne doit pas être effacé à l’aveugle.
