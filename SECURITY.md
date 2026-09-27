# Modèle de sécurité

CodexBridge est un service **mono-utilisateur**, destiné aux dépôts et configurations Codex de confiance du propriétaire de la machine. Ce n’est pas une sandbox multi-tenant pour du code hostile. Toute personne détenant le jeton local peut demander du travail dans les roots configurés.

- Écoute loopback par défaut. API et MCP requièrent un bearer token aléatoire de 256 bits. Le dashboard garde le jeton en mémoire, jamais dans l’URL ou localStorage. `.env`, configuration, DB et logs sont exclus de Git.
- Vérification Host contre DNS rebinding et Origin contre requêtes cross-origin ; pas de CORS permissif. CSP sans scripts inline, sans frames ; rendu utilisateur avec `textContent`, jamais HTML interpolé.
- Exposition publique : HTTPS derrière reverse proxy et OAuth JWT vérifié par `jose` (issuer, audience, expiration, subject autorisé, scope `codexbridge`, algorithmes explicites). Metadata resource publiée. Configurer un fournisseur OAuth 2.1 existant avec PKCE, plutôt que créer un fournisseur maison. Le bearer local reste un secret administrateur : ne pas le diffuser.
- Le proxy stdio utilise les credentials locaux de l’opérateur. Le tunnel doit être limité aux organisations/workspaces autorisés. Ne pas publier le port brut ou contourner OAuth pour obtenir une connexion ChatGPT.
- Dépôts autorisés par chemins réels. Pas de chemin relatif ou de traversée ; aucun endpoint de lecture arbitraire. Worktree vérifié par sa branche et son common Git directory. Ne pas supprimer ou déplacer le dossier de données pendant des jobs actifs.
- Git est lancé sans interpolation shell et avec hooks désactivés. Les diffs externes et textconv sont désactivés. Le service n’exécute pas de merge, push, publication, suppression de branche distante ou déploiement.
- Worker en sandbox workspace-write, réseau désactivé, sans écriture tmp globale ; reviewer Codex en read-only. Les demandes d’approbation sont refusées et transformées en décisions explicites. Ne pas configurer Codex avec des permissions globales ou plugins externes qui contournent ce modèle ; le CLI peut hériter de la configuration de son utilisateur. Préférer un compte OS dédié pour le fonctionnement quotidien sensible.
- Les variables de secrets du service sont retirées du sous-processus worker. L’authentification Codex reste gérée par le CLI. Le service ne lit ni ne copie les tokens Codex.
- Logs JSON et événements passent par redaction des secrets d’environnement et de formats connus ; stderr Codex brut n’est pas conservé. Cela ne peut pas identifier tous les secrets arbitraires présents dans un dépôt, un diff ou un ticket. Ne soumettre aucun secret dans les tickets et protéger le dossier SQLite par les ACL du compte OS. Les rapports sont des données privées.

Un dépôt malveillant peut exécuter du code lors de ses tests ; la protection effective dépend aussi de la sandbox Codex et de l’OS. Un conteneur partagé avec des volumes de dépôts n’est pas une frontière multi-tenant suffisante. Le test Docker ne doit pas recourir au mode privileged pour contourner une erreur de sandbox.

Les opérations nécessitant publication, infrastructure ou accès réseau doivent être réalisées explicitement par l’utilisateur hors du worker restreint. Répondre à un blocker n’accorde pas implicitement une permission système supplémentaire. Les instructions de dépôt et sorties du reviewer ne valent jamais autorisation d’une action externe.

Sauvegarde : arrêter le service puis copier le dossier de données. À chaud, employer l’API backup SQLite ; ne pas copier uniquement le `.db` en oubliant le WAL. Aucune rotation destructrice automatique de logs ou suppression de worktrees n’est effectuée.
