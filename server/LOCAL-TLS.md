# Lokal testen mit HTTPS und eigenem DNS

Die App spricht den Free-Grind-Server nur über HTTPS an, mit festen Adressen aus dem Build. Für Tests ohne öffentliche Domain gibt es das Compose-Profil `local-tls`:

- **caddy-local:** HTTPS für `api.`, `media.` und `rtc.freegrind.test` mit Caddys eigener CA (`tls internal`), weitergeleitet an den Server auf diesem Rechner.
- **dns:** dnsmasq, löst `*.freegrind.test` auf die LAN-IP dieses Rechners auf und leitet alles andere an 1.1.1.1 / 9.9.9.9 weiter.

`.test` ist eine reservierte Top-Level-Domain und kollidiert mit nichts im Internet.

## 1. Server und Proxy starten

LAN-IP dieses Rechners herausfinden (`ipconfig`), dann in `server/`:

```sh
docker compose up -d db pgbouncer redis s3 mailpit
FG_LOCAL_IP=10.10.0.20 docker compose --profile local-tls up -d caddy-local dns
```

PowerShell:

```powershell
$env:FG_LOCAL_IP = "10.10.0.20"
docker compose --profile local-tls up -d caddy-local dns
```

In `server/.env`:

```env
PUBLIC_API_URL=https://api.freegrind.test
PUBLIC_MEDIA_URL=https://media.freegrind.test
```

`PUBLIC_MEDIA_URL` muss gesetzt sein, sonst zeigen Medien-Links auf `api.` und die App lehnt sie ab. Dann `bun run dev` (API auf Port 8080).

Für Videocalls zusätzlich LiveKit mit `LIVEKIT_NODE_IP=<LAN-IP>` starten (`docker compose --profile calls up -d livekit`) und im Admin unter Integrationen → LiveKit die URL `wss://rtc.freegrind.test` mit Key `devkey` und Secret `secret` eintragen.

## 2. Root-Zertifikat exportieren

```sh
docker compose cp caddy-local:/data/caddy/pki/authorities/local/root.crt docker/local-root.crt
```

Die Datei bleibt gleich, solange das Volume `caddy-local-data` existiert (gültig 10 Jahre). Sie ist in `.gitignore`.

## 3. App bauen

Die App bringt für ihren Rust-Client eine eigene Root-Liste mit und ignoriert den Zertifikatsspeicher des Systems. Caddys CA kommt deshalb beim Build über `FG_CA_CERT` hinein, als **absoluter Pfad**. Ohne `FG_CA_CERT` ändert sich nichts, Release-Builds setzen es nie.

Git Bash / Linux / macOS:

```sh
export FG_API_URL=https://api.freegrind.test
export FG_MEDIA_URL=https://media.freegrind.test
export FG_RTC_URL=wss://rtc.freegrind.test
export FG_CA_CERT="$PWD/server/docker/local-root.crt"
bun run dev            # bzw. bun run dev:android
```

PowerShell (ohne `sh`, direkt `bunx tauri`):

```powershell
$env:FG_API_URL = "https://api.freegrind.test"
$env:FG_MEDIA_URL = "https://media.freegrind.test"
$env:FG_RTC_URL = "wss://rtc.freegrind.test"
$env:FG_CA_CERT = "D:\Projekte\free-grind\server\docker\local-root.crt"
$env:TAURI_CONFIG = bun scripts/free-grind-config.mjs
bunx tauri dev
```

`scripts/tauri.sh` setzt `TAURI_CONFIG` selbst; beim direkten `bunx tauri` muss es wie oben gesetzt werden. Die Variablen gelten nur in diesem Terminal.

## 4. Geräte einrichten

- **Dieser Rechner (Desktop-App):**
  - DNS: In den Netzwerkeinstellungen den DNS-Server auf die eigene LAN-IP stellen, oder in `C:\Windows\System32\drivers\etc\hosts` drei Zeilen `10.10.0.20 api.freegrind.test` (und `media.`, `rtc.`) eintragen.
  - Zertifikat: Für die WebView (LiveKit-Verbindung) `local-root.crt` als vertrauenswürdige Stammzertifizierungsstelle installieren (`certutil -addstore -user Root server\docker\local-root.crt`).
- **Android-Handy oder Emulator im selben Netz:**
  - DNS: Im WLAN unter „Erweitert → IP-Einstellungen: Statisch“ als DNS 1 die LAN-IP des Rechners eintragen. Privates DNS (DoT) dabei ausschalten.
  - Zertifikat: `local-root.crt` aufs Gerät kopieren und unter „Sicherheit → Verschlüsselung & Anmeldedaten → Zertifikat installieren → CA-Zertifikat“ installieren. Debug-Builds der App vertrauen Nutzer-CAs (für die WebView), Release-Builds nicht.

## 5. Prüfen

```sh
nslookup api.freegrind.test <LAN-IP>        # → LAN-IP
curl --cacert server/docker/local-root.crt https://api.freegrind.test/healthz   # → {"ok":true}
```

Unter Windows braucht curl zusätzlich `--ssl-no-revoke`, weil Caddys lokale CA keine Sperrliste hat.

In der App: Login → „Server ändern“ → „Free Grind“.

Bekannte Einschränkung: Der Offline-Cache für Chat-Medien (HTTP-Plugin) nutzt die eingebaute Root-Liste und greift bei der lokalen CA nicht. Medien werden trotzdem angezeigt.
