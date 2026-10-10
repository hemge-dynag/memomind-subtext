# MemoMind Subtext (Sous-entendus)

App **pairée** MemoMind (lunettes + téléphone) qui écoute activement une
conversation via les **micros des lunettes** et affiche sur les lunettes une
**alerte** quand un sous-entendu, un point important, un engagement implicite,
un ton notable ou une question sous-jacente est détecté.

L'analyse (speech-to-text + LLM) tourne **sur le téléphone**.

## Architecture

```
Lunettes (mics) --Opus 16kHz--> Téléphone (web plugin)
                                      |  gm.audio.openCapture (audio.capture)
                                      v
                          fenêtres glissantes (4 s)
                                      |
                        STT (endpoint configurable)
                                      |
                        analyse LLM (JSON)
                                      |
                   gm.plugin.sendMessage(channel 0x5355)
                                      v
                       Lunettes : bandeau d'alerte à l'écran
```

- **Consentement / voyant** : géré nativement par l'app hôte — le voyant
  d'enregistrement des lunettes s'allume automatiquement pendant toute capture
  audio. L'app ne peut ni le dessiner ni le masquer (voir
  `PhoneSDK/docs/web-plugin/api-reference.md`, section *Native glasses audio*).
- **Un seul propriétaire audio** : le plugin téléphone détient le canal de
  capture natif pendant l'écoute.

## Composants

### Lunettes — `glass/subtext/subtext.c`

Plugin natif LVGL (`.gmp`), id `com.dynag.subtext.glass`, protocole `gm.subtext`.

- Affiche un bandeau coloré selon le type d'alerte (sous-entendu, important,
  engagement, ton, question), une note courte et une barre de confiance.
- L'usager ferme l'alerte par **appui bouton** (PRIMARY SINGLE) ou **geste de
  tête** (lever la tête) ; le téléphone en est informé.
- Bilingue… (6 langues : FR/EN/ES/IT/DE/ZH-CN), détection via `host->locale_get`.

### Téléphone — `phone/subtext/`

Plugin Web (`.mmpkg`), id `com.dynag.subtext.phone`.

- `plugin.js` — orchestration : `gm.audio.openCapture({profile:'interactive',
  pickupMode:'frontBalanced', noiseReduction:true})`, accumulation par fenêtres
  de 4 s, envoi des alertes aux lunettes, persistance (`gm.storage`).
- `ai.js` — pipeline STT + LLM, **deux modes** :
  - `simulated` (défaut) : aucune clé, aucun réseau. Rejoue un petit scénario
    de transcripts/alertes pour dérouler toute la chaîne hors ligne.
  - `live` : appels HTTP compatibles OpenAI via la permission `network`
    (`/audio/transcriptions` puis `/chat/completions` avec réponse JSON).
- `protocol.js` — trame binaire partagée avec le plugin lunettes.
- `translations.js` — 6 langues (FR/EN/ES/IT/DE/ZH-CN).

## Protocole binaire (`gm.subtext` v1)

Canaux : `SETTINGS_CHANNEL = 0x5355` ('SU', téléphone→lunettes),
`EVENT_CHANNEL = 0x5356` ('SV', lunettes→téléphone).

| Message | Layout |
| --- | --- |
| `COMMAND_ALERT` | `[version, cmd, kind, confidence, note_len, ...note utf8]` |
| `COMMAND_CLEAR` | `[version, cmd, 0, 0]` |
| `COMMAND_STATUS` | `[version, cmd, listening?1:0]` |
| `EVENT_DISMISS` | `[version, event, 0]` |

`kind` : 0 = sous-entendu, 1 = important, 2 = engagement, 3 = ton, 4 = question.

## Permissions

- Téléphone : `audio.capture` (obligatoire), `network` (obligatoire, mode live),
  `storage`, `device.info`, `device.events` (connection), `device.messaging`
  (canaux 21333/21334).
- Lunettes : `BLUETOOTH`, `BUTTON`, `IMU_EVENTS`.

## Configuration LLM (mode live)

Renseignés dans l'UI du téléphone, persistés via `gm.storage` :

- **Endpoint** compatible OpenAI (ex. `https://api.openai.com/v1`)
- **Clé API**
- **Modèle STT** (ex. `whisper-1`)
- **Modèle LLM** (ex. `gpt-4o-mini`)
- **Langue** de la conversation
- **Seuil de sensibilité** (confiance minimale avant alerte)

> Les appels `network` sont limités aux domaines HTTPS requis par la politique
> du Bridge. Aucune clé n'est codée en dur.

## Build

Depuis la racine du SDK `plugin-open-platform` :

```sh
./build.py glass --force   # -> GlassSDK/build-host/.build/subtext/subtext.gmp
./build.py web --force     # -> PhoneSDK/dist/subtext-1.0.0.mmpkg
```

Taille : Glass Flash=4192/512000 B, RAM statique=120 B ;
Web `.mmpkg` 8 fichiers.

## Avertissement

Cette app traite de l'**audio capté en continu** : elle est destinée à un usage
consenti (note de réunion, assistance à la conversation). Le voyant
d'enregistrement des lunettes doit rester visible et le consentement des
personnes présentes relève de la responsabilité de l'utilisateur.

## Licence

Le SDK MemoMind Open Platform n'est pas inclus ; voir le dépôt officiel
`memomind-open/plugin-open-platform`.
