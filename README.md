# Athena

Surveillance des sites web TOUFATECH : statut en direct, historique des vérifications, incidents, maintenance et alertes.

- **Interface** : site statique (`index.html`, `assets/`), déployé sur Vercel.
- **Données et vérifications** : Supabase (projet `toufatech`, schéma `athena`). Une tâche `pg_cron` vérifie chaque site toutes les minutes, même quand personne n'a la page ouverte.
- **Accès** : connexion par e-mail et mot de passe (Supabase Auth). Seules les adresses listées dans `athena.allowed` ont accès (rôle `admin` ou `viewer`).

## Fonctionnalités

| Domaine | Ce qui est en place |
|---|---|
| Moniteurs | HTTP(S) GET/HEAD/POST, mot-clé (présent ou absent), DNS. Fréquence, délai, tentatives, codes attendus, seuil « lent », étiquettes, pause. |
| Statuts | En ligne, lent (dégradé), hors ligne, en pause, inconnu. Dernier contrôle et raison du dernier échec. |
| Historique | Journal horodaté (code, temps, erreur, emplacement), filtres 24 h / 7 j / 30 j, échecs uniquement. Conservation 90 jours. |
| Tableau de bord | Sites, en ligne, hors ligne, incidents ouverts, disponibilité 24 h, temps moyen, mini-historique par site. |
| Incidents | Ouverture après N échecs consécutifs, fermeture au retour, chronologie, commentaires, statut, cause racine. |
| Maintenance | Fenêtres programmées, par site ou globales, exclues du calcul de disponibilité, alertes coupées au choix. |
| Alertes | Discord, Slack, Telegram, webhook JSON. Test d'envoi, historique, rappel optionnel. Secrets jamais réaffichés. |
| Aperçus | Favicon et capture d'écran de chaque site (rafraîchies toutes les 15 min au plus). |

**Disponibilité** = contrôles réussis ÷ contrôles effectués sur la période, hors fenêtres de maintenance.

Non inclus : alertes e-mail, ping ICMP et TCP, métriques serveur (nécessitent un agent), page de statut publique, multi-régions, exports.

## Configuration Supabase

`assets/config.js` contient l'URL du projet et la clé publique `anon` (publique par conception). Toutes les données passent par la fonction `public.athena_rpc`, exécutable uniquement par un utilisateur connecté et autorisé.

À faire une fois dans Supabase → **Authentication → URL Configuration** : ajouter l'adresse du site Vercel dans **Site URL** ou **Redirect URLs**, pour que les liens de confirmation et de réinitialisation reviennent sur Athena.

### Ajouter un utilisateur

```sql
insert into athena.allowed (email, role) values ('prenom@exemple.com', 'viewer');  -- ou 'admin'
```

La personne crée ensuite son compte depuis l'écran de connexion avec cette adresse.

### Schéma

`supabase/migrations/` contient, dans l'ordre, toutes les migrations du schéma `athena` (déjà appliquées sur le projet). La liste des adresses autorisées n'est pas versionnée : elle vit uniquement en base.

## Développement local

```bash
python3 -m http.server 8080
# puis ouvrir http://localhost:8080
```
