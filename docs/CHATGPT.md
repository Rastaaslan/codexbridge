# Connexion ChatGPT / plugin

Deux transports mènent aux mêmes jobs. Le scheduler doit déjà tourner ; lancer un client MCP ne crée pas un second scheduler.

## Local : Secure MCP Tunnel

1. Installer le `tunnel-client` officiel depuis le lien dans les paramètres Tunnels de la plateforme. Créer un tunnel associé à votre organisation **et** au workspace ChatGPT voulu ; disposer des droits Tunnels Read + Use (Manage pour le créer).
2. Définir localement `CONTROL_PLANE_API_KEY` et `CODEXBRIDGE_HOME`. Ne pas écrire de clé dans le dépôt.
3. Configurer un profil stdio vers le proxy CodexBridge, qui ajoute l’authentification HTTP locale :

```sh
tunnel-client init --sample sample_mcp_stdio_local --profile codexbridge --tunnel-id <tunnel_id> --mcp-command "node C:/codexbridge/dist/cli.js mcp-stdio"
tunnel-client doctor --profile codexbridge --explain
tunnel-client run --profile codexbridge
```

Sous Linux adapter le chemin. Le proxy retrouve la configuration grâce à `CODEXBRIDGE_HOME` ; aucune clé dans les arguments. Vérifier les options avec `tunnel-client help quickstart` pour la version installée. Le service CodexBridge et le tunnel restent en fonctionnement.

La [documentation officielle Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) décrit les permissions et associations de workspaces. Le tunnel n’est pas créé par ce dépôt et n’est pas une exposition publique anonyme.

## Ajouter la connexion

Les scripts du dépôt automatisent la préparation locale :

```sh
node scripts/install-tunnel.mjs
node scripts/tunnel.mjs setup <tunnel_id>
# Ajouter CONTROL_PLANE_API_KEY dans .env, sans la partager.
node scripts/tunnel.mjs connect
node scripts/tunnel.mjs status
```

Le binaire officiel est téléchargé depuis la release GitHub OpenAI et vérifié par SHA-256. Profils et métadonnées locaux sont sous `.codexbridge/`, exclus de Git. `connect` emploie le runtime supervisé officiel et une référence de variable d’environnement pour la clé ; `status` doit confirmer le processus et sa disponibilité. `node scripts/tunnel.mjs stop` arrête ce runtime. Les chemins Windows sont transmis avec `/` pour éviter leur interprétation comme séquences d’échappement.

Parcours constaté dans ChatGPT le 23 septembre 2026 :

1. Activer le mode développeur dans **Paramètres → Sécurité et connexion**.
2. Ouvrir **Plugins**, puis le **+** à droite de la recherche.
3. Choisir **Create app**, puis **Créer une application MCP**. **Create plugin** ouvre l’assistant de création et ne mène pas directement au formulaire MCP.
4. Saisir **CodexBridge** comme nom, choisir **Tunnel**, puis sélectionner le tunnel autorisé.
5. Pour le proxy stdio de ce dépôt, choisir **Aucune** dans Authentification : le tunnel authentifie déjà son accès et le proxy ajoute le jeton du serveur local. Ce choix ne s’applique pas au déploiement public HTTPS/OAuth.
6. Lire et accepter l’avertissement, créer la connexion, puis cliquer sur **Connecter**.
7. Dans une nouvelle conversation, sélectionner CodexBridge et demander le rapport d’un job existant. Développer l’activité pour vérifier les appels **Get job report** et **Get job diff**.

Vérifier les onze outils découverts, puis demander la création d’un ticket dans un dépôt autorisé. Les intitulés et droits peuvent varier selon compte/workspace. Voir [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt).

Après modification des outils : redémarrer, rafraîchir la connexion puis commencer une nouvelle conversation. Tester `create_job`, attendre `get_job`, récupérer `get_job_report` et `get_job_diff`, répondre à un blocker avec `send_instruction`, puis confirmer vos tests avec `approve_job`. Ne jamais affirmer la connexion complète sans avoir obtenu un rapport depuis ChatGPT.

## HTTPS et OAuth

Configurer un fournisseur OAuth 2.1 avec PKCE, compatible avec les mécanismes de clients OpenAI, et une API/audience dédiée. Paramètres CodexBridge : `publicUrl` (URL HTTPS canonique de la ressource), `oauthIssuer`, `oauthJwksUrl`, `oauthSubject` (identifiant du seul utilisateur autorisé). Les JWT doivent inclure l’audience `publicUrl` et le scope `codexbridge`. Un proxy TLS conserve le Host public et route vers le serveur privé. Ne pas exposer directement son port HTTP.

La ressource publie `/.well-known/oauth-protected-resource`, vérifie JWT/issuer/audience/scope/subject, et renvoie un challenge Bearer. Le fournisseur externe gère login, consentement, token endpoint, refresh et découverte. ChatGPT ne remplace pas ce flux par une clé API personnalisée. Référence : [Authentication for plugins](https://developers.openai.com/plugins/build/auth). Cette intégration doit être testée avec votre fournisseur réel avant exposition.

## Package local

`plugins/codexbridge` contient manifest, configuration stdio et skill. Installer la CLI avec `npm link`, définir `CODEXBRIDGE_HOME` dans l’environnement hérité par le client, puis installer le package depuis une marketplace locale via l’interface Plugins. Ce ticket fournit le package sans modifier votre marketplace personnelle. La skill décrit les formulations naturelles et le suivi des identifiants ; elle ne peut pas maintenir une conversation ChatGPT active ni envoyer spontanément un message de fin. Les statuts restent accessibles dans le dashboard et les outils MCP.
