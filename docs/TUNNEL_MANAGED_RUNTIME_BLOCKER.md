# CB-42 : blocage du runtime Cloudflare managé

## Observations fournies par l'opérateur Debian le 28 septembre 2026

- Une nouvelle `CONTROL_PLANE_API_KEY`, avec les permissions corrigées, a fait disparaître l'ancien `401 tunnel_use_forbidden`.
- Le GET direct `https://api.openai.com/v1/tunnels/<tunnel_id>/cloudflare/runtime` renvoie HTTP 404 : `Managed Cloudflare tunnel runtime material not found`.
- Le même résultat a été observé après création d'un nouveau tunnel et attente de 30 secondes. Cela ne prouve pas qu'un délai de provisioning plus long serait impossible.
- Le runtime officiel Linux v0.0.15 démarre MCP stdio, le serveur de santé, le poller et son PID, puis quitte avec `cloudflared: fetch managed runtime credentials failed`.
- Windows est à nouveau stable lorsque `npm start` fonctionne : son proxy MCP stdio dépend du serveur MCP localhost. Ce constat est distinct du 404 Debian.

Ces observations ont été communiquées par l'opérateur ; l'agent n'a pas rejoué les requêtes. Aucune clé ni réponse contenant des identifiants Cloudflare n'est conservée ici. L'ID Debian reste dans la configuration locale ; aucun remplacement de configuration Windows n'est nécessaire.

## Diagnostic et limites

Le téléchargement, le nom du binaire et son lancement ne sont plus l'échec immédiat observé. La récupération des credentials managés échoue auprès de l'API OpenAI, également lorsqu'elle est appelée directement hors CodexBridge. Modifier `ready`, les chemins locaux ou le checksum ne peut pas créer ce matériel distant.

Le 404 ne suffit pas à identifier la cause interne : provisioning absent/incomplet, contexte organisation/projet/tunnel, éligibilité ou défaut du service doivent être examinés côté OpenAI. La disparition du 401 ne prouve pas que tout contexte de compte est correct. Aucun endpoint de création/réparation ni SLA de provisioning n'est établi par les sources disponibles. Les outils autorisés ici ne permettent pas de consulter la documentation officielle en ligne ; ne pas présenter une procédure supposée comme supportée.

La voie à faire confirmer est le provisioning **OpenAI managé** par l'opérateur du service/support OpenAI du compte. Aucun compte Cloudflare, tunnel statique, credential inventé, endpoint POST/PUT supposé ou désactivation de contrôle n'est proposé. Ne pas répéter la création de tunnels ou la rotation des clés comme réparation sans instruction documentée du service.

## Dossier pour l'opérateur/support OpenAI

Demande : « Pour le tunnel Debian indiqué dans ce dossier, quelle est la procédure supportée pour provisionner ou réparer le managed Cloudflare runtime material utilisé par le client officiel v0.0.15 ? Pouvez-vous vérifier son état côté service et le contexte organisation/projet attendu ? »

Joindre par le canal de support privé existant :

- l'ID du tunnel Debian actuel et le contexte organisation/projet pertinent, sans clé API ;
- version v0.0.15, plateforme Debian amd64, endpoint et méthode GET ci-dessus ;
- HTTP 404 et texte exact `Managed Cloudflare tunnel runtime material not found` ;
- horodatages UTC et éventuel `x-request-id` **déjà disponibles**, sans inventer de valeur ni refaire l'appel pour ce dossier ;
- message expurgé `cloudflared: fetch managed runtime credentials failed`, et résultat identique sur un nouveau tunnel après 30 secondes ;
- correction des permissions ayant supprimé le 401, distincte du tunnel Windows stable.

Ce document prépare le dossier ; aucun message n'a été envoyé au support par l'agent.

## Validation restante

Les changements locaux conservent la vérification SHA-256 officielle, la branche Windows, le lancement `run`, la surveillance bornée et les captures expurgées. Le correctif du garde `realpath` et son test via lien `current` sont conservés.

Le format réel du fichier URL et des réponses santé prêt/non prêt n'est toujours pas fourni. Les fixtures santé restent synthétiques : elles ne prouvent pas la compatibilité v0.0.15. Ne pas déclarer ce volet validé ou le tunnel prêt. Après résolution du blocage service, utiliser la capture existante pour établir ces fixtures et terminer la revue de `linuxStatus`, sans remplacer la disponibilité par un simple HTTP 2xx.
