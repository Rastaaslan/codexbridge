# Historique : blocage Cloudflare managé

## Résolution

Le 28 septembre 2026, le runtime OpenAI officiel répondait `404 Managed Cloudflare tunnel runtime material not found` lorsque CodexBridge lançait explicitement `--cloudflared.managed`.

Ce mode n'est pas requis pour Secure MCP Tunnel. Le chemin standard du client officiel utilise directement le control plane OpenAI : long-poll `GET /v1/tunnels/{tunnel_id}/poll`, exécution MCP locale, puis `POST /v1/tunnels/{tunnel_id}/response`. Le compagnon Cloudflare est optionnel et son endpoint `/cloudflare/runtime` ne concerne que les tunnels explicitement provisionnés pour ce mode.

CodexBridge n'active donc plus `cloudflared.managed` sur Debian.

## Comportement retenu

- le runtime Linux est lancé avec `run`, la clé runtime via `env:CONTROL_PLANE_API_KEY`, `CONTROL_PLANE_TUNNEL_ID` et `MCP_COMMAND` ;
- les nouvelles installations Linux sélectionnent l'artefact officiel étroit `tunnel-client-runtime` ;
- une installation existante `tunnel-client-runtime-cloudflared` reste acceptée : sans l'option managée, elle utilise le même control plane natif ;
- le fichier `--health.url-file` est traité comme une URL de base loopback ;
- `/healthz` décide de la liveness et `/readyz` de la readiness ;
- un 404 sur `/cloudflare/runtime` n'est plus consulté et n'a plus d'effet sur CodexBridge.

## Sécurité

La clé runtime reste absente des arguments, logs et fichiers de configuration suivis. Le runtime reste sortant uniquement vers OpenAI et l'endpoint MCP local n'est pas exposé publiquement.

Le mode Cloudflare managé pourra être réintroduit uniquement si un besoin explicite l'exige et si le tunnel concerné dispose réellement du matériel distant associé.
