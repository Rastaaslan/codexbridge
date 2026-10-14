# Délégation v2 : verticale opérateur, non activée

CB-194 a été créé par Sentinel le 14 octobre à 08:30:40Z, selon le retour
opérateur. Ce travail ne lit ni ne modifie son état. La v1 et ses signatures,
configurations et ledgers restent inchangés.

`sentinel-delegation-v2.ts` fournit un composant d'autorité indépendant, sans
socket, commande système, clé privée, loader de secrets ni hook de démarrage.
Il n'est pas encore raccordé à un service installé. Construction = création
exclusive des tables v2 dans la DB fournie ; admission désactivée sans opt-in
externe. Ne jamais lui fournir la DB de production depuis le worker.

## Contrat exécutable

- Mandat Ed25519 hors ligne sans expiration : dépôt canonique et origin hash
  exacts, branches autorisées, opération code-fix, tickets statiques/hashés et
  dépendances explicites. Aucun générateur de tickets arbitraires. Au plus
  8 itérations/job, 1 job actif/projet, 32 itérations et 4 jobs/7 jours,
  128 itérations et 16 jobs/30 jours ; le mandat peut réduire ces plafonds.
- Trois rôles séparés : mandat, observation source/preuves, issuer de lease.
  Domaines `CODEXBRIDGE_DELEGATION_{MANDATE,EVIDENCE,LEASE}_V2` distincts de v1.
  Le contrôle externe décide à chaque admission quels hashes de mandats et
  clés restent autorisés. Aucun réglage worker ne peut remplacer ce contrôle.
- Le fournisseur de preuves indépendant émet un cycleId stable pour la même
  observation utile, vérifie source/origin/branche/SHA et faits, puis signe.
  L'issuer recontrôle la source via son port protégé. Preuve fraîche ≤60 s ;
  lease ≤5 min. La policy normalisée complète est signée dans la lease.
- `issue` réserve et synchronise SQLite avant de demander la signature au
  signataire externe. Crash ambigu = quota conservé et lane bloquée, sans
  nouvelle signature automatique. Même cycleId = même requestKey, jamais
  une nouvelle tâche par simple retry. Le mandat ne signe pas chaque campagne.
- `dispatch` réutilise `coreCreatePort` et son contrôle canonique juste avant
  insertion. Les ports d'admission doivent vérifier les dépendances dans Store,
  la source actuelle et tous les jobs concurrents (dont CB-194), pas seulement
  le ledger v2. Perte de réponse après insertion : lookup par clé et identité
  exacte, pas de nouveau create. Aucun changement de budget d'un ancien job.
- Quotas glissants indexés par dépôt, non par clé/mandat : la rotation ne remet
  rien à zéro. Les réservations et échecs comptent intégralement. Horloge
  reculée refusée. Seul un job réellement COMPLETED libère la lane ; les
  états FAILED/CANCELLED/WAITING_FOR_HUMAN nécessitent une revue extérieure.
  `reconcile` retrouve aussi un job inséré avec réponse perdue (launching,
  job_id absent), par clé durable après expiration/révocation, en contrôlant
  toute l'identité attendue. Job absent ou différent : réservation conservée.
- Cooldown de 60 secondes par dépôt, contrôlé à la réservation et juste avant
  insertion, avec horodatages d'admission durables. Redémarrage et rotation ne
  le réinitialisent pas ; une insertion retardée décale la prochaine admission.
- L'expiration/révocation empêche une nouvelle admission ; elle ne tue ni ne
  renouvelle un job déjà inséré. `status` est une projection sans secret.

## Raccordement opérateur restant — sans toucher CB-194

1. Revoir puis installer les octets v2 validés dans un préfixe root-owned non
   modifiable par le worker. Le code fourni n'est pas un installateur.
2. Provisionner séparément mandat hors ligne, clés publiques épinglées,
   contrôle de révocation, signataire de leases et attesteur de preuves.
   Les clés privées restent hors worker/DB ; aucun endpoint de signature libre.
3. Raccorder ce composant à un service opérateur indépendant, default-off,
   avec DB/parents protégés et ports réels source/ressources/Store. Aucun
   shell arbitraire ou privilège worker. Il manque ce host concret et le canal
   authentifié vers l'admission canonique : ne pas brancher des ports fake.
4. Observer CB-194 et attendre la disponibilité autorisée du projet via le
   scheduler. Aucune migration, annulation, resoumission ni extension de son
   grant. L'essai d'intégration privilégiée est un jalon séparé.
5. Rotation : retirer l'ancien hash de mandat et/ou clé dans le contrôle
   protégé, signer un nouveau mandat et conserver **la même DB** de quotas.
   Révocation immédiate avant insertion ; jobs existants inchangés.
   Rollback : désactiver seulement v2, conserver ledger et preuves, ne pas
   supprimer de réservations et ne pas modifier les services v1.

## Preuves de ce passage

Tests synthétiques : vraies signatures éphémères en mémoire, SQLite jetables,
création Orchestrator avec Git/ressources simulés. Revue 20 : **61 PASS, 0 FAIL,
2 SKIP** (tests Git opt-in existants, opérations refusées non retentées), dont
7 tests v2. TypeScript noEmit, Prettier check et git diff --check : exit 0.
Les corrections couvrent le reboot après expiration/révocation, les identités
incomplètes/altérées et le cooldown après insertion retardée/rotation/reboot.
Aucun travail WorldPrep, processus root ni monde exécuté. Aucun host v2 installé.
Commandes, empreintes et logs : `.test-tmp/delegation-review20-manifest.json`.
