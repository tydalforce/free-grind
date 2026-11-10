# Betrieb auf einem Server

Die Produktionsumgebung ist `docker-compose.prod.yml`: Caddy (TLS), API, Worker, Postgres/PostGIS, PgBouncer, Redis, SeaweedFS (S3) und optional LiveKit für Videocalls.

## 1. Voraussetzungen

- Linux-Server mit Docker und Docker Compose, mindestens 2 vCPU und 4 GB RAM
- Drei Hostnamen, die per A/AAAA-Record auf den Server zeigen:
  - `api.<domain>`: App-API, WebSocket, Admin unter `/admin`
  - `media.<domain>`: Bilder und Videos
  - `rtc.<domain>`: LiveKit (nur mit Videocalls)
- Firewall:
  - TCP 80 und 443 (Caddy, Let's Encrypt)
  - Nur mit Videocalls: TCP 7881 und UDP 50000–50200 (Medienströme von LiveKit)

**Zum Testen ohne öffentliche Domain:** lokaler Caddy mit `tls internal` und eigenem DNS, siehe [LOCAL-TLS.md](LOCAL-TLS.md).

## 2. Konfiguration

```sh
cp .env.prod.example .env.prod
openssl rand -base64 48   # für APP_SECRET, POSTGRES_PASSWORD, S3_SECRET_ACCESS_KEY, LIVEKIT_API_SECRET
```

- Domains, `ACME_EMAIL` und die Geheimnisse in `.env.prod` eintragen.
- `APP_SECRET` danach **nie ändern**: Damit sind gespeicherte Geheimnisse verschlüsselt (SMTP, Firebase, LiveKit).
- `.env.prod` ist in `.gitignore`.

## 3. Start

```sh
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
# mit Videocalls:
docker compose -f docker-compose.prod.yml --env-file .env.prod --profile calls up -d --build
# ersten Admin anlegen:
docker compose -f docker-compose.prod.yml --env-file .env.prod exec api bun src/cli/adminCreate.ts admin owner   # fragt nach dem Passwort (min. 12 Zeichen)
```

- Die API migriert die Datenbank bei jedem Start selbst.
- Mehr API-Instanzen: `--scale api=3`. Caddy verteilt Anfragen und WebSockets auf alle.

## 4. Einrichtung im Admin (`https://api.<domain>/admin`)

- **Integrationen → LiveKit:** URL `wss://rtc.<domain>`, Key und Secret wie in `.env.prod`. Danach „Verbindung testen“.
- **Integrationen → Firebase:** Dienstkonto für Push. Die App-Seite kommt über die `FG_FCM_*`-Variablen in den Build (Abschnitt 5).
- **Einstellungen → E-Mail (SMTP):** für Passwort-Reset.

## 5. App bauen

Die App kennt neben Grindr höchstens einen weiteren Server, „Free Grind“. Seine Adressen werden beim Build festgelegt, es gibt keine Eingabe in der App und keine Standardwerte im Code:

| Variable | Beispiel | Wofür |
|---|---|---|
| `FG_API_URL` | `https://api.example.org` | REST und WebSocket |
| `FG_MEDIA_URL` | `https://media.example.org` | Bilder und Videos (auch HTTP-Freigabe für den Medien-Cache) |
| `FG_RTC_URL` | `wss://rtc.example.org` | LiveKit, wird in die CSP der App eingetragen |
| `FG_FCM_PROJECT_ID` | `mein-projekt-1234` | Push: Firebase-Projekt (`project_info.project_id`) |
| `FG_FCM_SENDER_ID` | `123456789012` | Push: `project_info.project_number` |
| `FG_FCM_APP_ID` | `1:123456789012:android:abc123` | Push: `client[0].client_info.mobilesdk_app_id` |
| `FG_FCM_API_KEY` | `AIza…` | Push: `client[0].api_key[0].current_key` |

- Ohne `FG_API_URL` und `FG_MEDIA_URL` enthält der Build keinen Free-Grind-Server; „Server ändern“ erscheint dann nicht.
- Die vier `FG_FCM_*`-Werte stammen aus der `google-services.json` eures Firebase-Projekts und sind öffentlich. Fehlt einer, hat der Build keinen Push für Free Grind. Das Dienstkonto zum Senden kommt nur in den Admin (Integrationen → Firebase) und muss zum selben Projekt gehören.
- `scripts/tauri.sh` und die CI-Skripte (`ci/build/*.sh`, Variablen werden von `ci/build/run.sh` in den Container durchgereicht) übernehmen die Werte über `scripts/free-grind-config.mjs`.

```sh
FG_API_URL=https://api.example.org FG_MEDIA_URL=https://media.example.org FG_RTC_URL=wss://rtc.example.org bun run build:android:apk
```

Die Domains in `.env.prod` (`API_DOMAIN`, `MEDIA_DOMAIN`, `RTC_DOMAIN`) müssen zu diesen Adressen passen. In der App wählt man den Server über „Server ändern“ im Login.

## 6. Betrieb

- **Backups:**
  - Datenbank: `docker compose -f docker-compose.prod.yml exec db pg_dump -U freegrind -Fc freegrind > backup.dump`
  - Volume `s3-data` (oder den externen S3-Bucket) separat sichern.
- **Metriken:** `METRICS_TOKEN` setzen. Prometheus im selben Docker-Netz liest `http://api:8080/metrics` mit `Authorization: Bearer <token>`. Von außen ist `/metrics` immer gesperrt.
- **Admin absichern:** `ADMIN_ALLOW` auf eigene Netze (CIDRs) beschränken, dann antwortet `/admin` allen anderen mit 403.
- **Logs:** `docker compose -f docker-compose.prod.yml logs -f api worker`
