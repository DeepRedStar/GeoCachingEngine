# GeoCachingEngine

GeoCachingEngine ist eine modulare Admin- und Event-Verwaltung für Geocaching-Gruppen mit Vite/React-Frontend, Express/TypeScript-Backend und Prisma/PostgreSQL.

## A. Quickstart (Clean VPS, ein Befehl)
Zielgruppe: Non-Tech-User mit einer frischen Debian/Ubuntu-VPS.

Unterstützte OS: Debian 11/12, Ubuntu 20.04/22.04. Hardware: 1 vCPU, 1 GB RAM, 10 GB Disk (kleine Gruppen); mehr Ressourcen für größere Events.

Befehl (als root):
```bash
curl -sSL https://raw.githubusercontent.com/DeepRedStar/GeoCachingEngine/main/deploy/quickstart.sh | bash
```

Was das Skript erledigt:
- Prüft das OS und bricht mit Hinweis auf das Expert-Setup ab, wenn nicht unterstützt.
- Installiert notwendige Pakete (git, Node.js LTS, npm, PostgreSQL, nginx).
- Legt den Systemnutzer `geocaching` an und klont das Repository nach `/opt/geocachingengine` (überschreibbar via `APP_DIR`).
- Erstellt `.env` mit generierter `DATABASE_URL`, Admin-E-Mail und einem zufälligen starken Passwort.
- Führt Prisma-Migrationen aus und baut Backend/Frontend.
- Richtet systemd-Services und eine einfache nginx-Site (HTTP, Reverse Proxy auf Ports 4000/4173) ein.
- Speichert die Zugangsdaten in `/root/geocachingengine-credentials.txt` (nur root-lesbar).

Nachlaufende Schritte:
- Datei `/root/geocachingengine-credentials.txt` sicher herunterladen, extern ablegen und **vom Server löschen**.
- Beim ersten Login das Admin-Passwort im Admin-Bereich ändern.
- Für HTTPS ein Zertifikat (z. B. Certbot) im nginx einrichten.

## B. Expert-Setup (bestehende Umgebung)
Zielgruppe: Admins/DevOps, die in eine vorhandene Infrastruktur integrieren.

Voraussetzungen:
- Node.js 20+, npm
- PostgreSQL mit erreichbarer Instanz und eigener `DATABASE_URL`
- Reverse Proxy (nginx/Traefik/HAProxy) oder alternative Exposition
- Git

Schritte:
1. Repository klonen und `.env` auf Basis von `.env.example` erstellen (inkl. `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `DATABASE_URL`, `BASE_URL`).
2. Abhängigkeiten installieren:
   ```bash
   npm install
   ```
3. Migrationen und Build ausführen:
   ```bash
   APP_DIR=/pfad/zur/app bash deploy/install.sh
   ```
   - Das Skript prüft benötigte Tools, erwartet eine vorhandene `.env` und führt `npm run migrate` sowie `npm run build` aus.
4. Starten:
   - Direkt: `npm run start:backend` und `npm run start:frontend`
   - Oder systemd/nginx manuell konfigurieren:
     - Beispiel: `deploy/systemd.example.service`
     - nginx-Vorlage: `deploy/nginx.conf.template`

## Admin-Oberfläche
- Login: `/admin` mit den in `.env` oder der Credential-Datei hinterlegten Daten.
- Settings: Impressum/Datenschutz/Support, Standardradien, SMTP/Rate-Limit, Deployment-Status.
- Events: Anlegen, Bearbeiten, Archivieren/Löschen; Start-/Endzeiten und Radien; Absenderprofil und Einladungstemplates.
- Caches: Koordinaten, Hinweis, Lösung, Fund-Reset.
- Einladungen: Link- oder E-Mail-Variante (E-Mail nur bei konfiguriertem SMTP), Aktivieren/Deaktivieren, Audit-Log.
- Live-Statusboard: Fortschritt, gefundene Caches, pseudonyme Spieleranzahl.
- Systemstatus: Health-Checks (DB, Migrationen, E-Mail, Version).

## Öffentliche Spieler-Ansicht
- `/public`: Liste aktiver Events (nicht archiviert, im Zeitfenster).
- `/public/event/:id`: Caches nach Entfernung (Haversine); Fundstatus lokal (localStorage) und serverseitig; optionaler Nickname bei pseudonymer Registrierung.

## Datenmodell (Auszug)
```
SystemSetting (Singleton)
  impressumUrl, privacyUrl, supportEmail
  cacheVisibilityRadiusDefault, cacheFoundRadiusDefault
  dataRetentionDays, maxEmailsPerHourPerAdmin, maxEmailsPerDayPerAdmin
  smtpHost/Port/User/Password, smtpUseTls, smtpFromAddress/Name
  createdAt, updatedAt

Event
  id (String, cuid)
  name, description?, startsAt, endsAt
  visibleRadiusMeters, foundRadiusMeters
  startPoint?, endPoint?
  invitationEmailSubject?, invitationEmailBody?
  senderEmail?, senderName?
  archived (Bool), archivedAt?
  createdAt, updatedAt
  caches -> Cache[]
  invitations -> Invitation[]

Invitation
  id (cuid), eventId, token, deliveryMethod (LINK|EMAIL), email?, isActive, deactivatedAt?, createdAt, usedAt?

EmailLog
  id, eventId?, invitationId?, recipient, subject, status (SENT|FAILED|DISABLED|RATE_LIMITED), errorMessage?, createdAt

Cache
  id, eventId, latitude, longitude, clue, solution, foundByAnyPlayer (Bool), foundAt, createdAt

Player / CacheFind (pseudonym)
  Player: id, eventId, createdAt
  CacheFind: cacheId, playerId, foundAt
```

## Einladungen, Templates und Versand
- Link-Einladungen funktionieren immer; `/join/:token` prüft Aktivität und Event-Fenster.
- SMTP erforderlich für E-Mail-Einladungen; fehlende Konfiguration deaktiviert die Option im Admin-UI.
- Pro Event können Betreff/Text mit Platzhaltern (`{{eventName}}`, `{{eventDescription}}`, `{{eventStart}}`, `{{eventEnd}}`, `{{inviteLink}}`) hinterlegt werden; `{{inviteLink}}` wird beim Versand ersetzt.
- Rate-Limits pro Admin (Stunde/Tag) verhindern Massenversand; Verstöße werden abgelehnt und im Audit-Log erfasst.
- Audit-Log: `/admin`-Bereich zeigt Versandstatus (SENT/FAILED/DISABLED/RATE_LIMITED) pro Event.
- Einladungen können deaktiviert/reaktiviert werden; deaktivierte Tokens führen zu einer neutralen Fehlermeldung beim Join.
- Absenderprofil pro Event (Name/Adresse) überschreibt globale SMTP-Defaults.

## Health-/Status-Endpunkte
- Öffentlich: `GET /healthz` → `{ "status": "ok" }` (ohne Secrets).
- Admin: `GET /api/admin/system-status` → DB-Check, Migrationsstatus, `emailSendingEnabled`, Version.

## Export/Archivierung
- `GET /api/admin/events/:id/export`: JSON mit Event, Caches, Fundstatus, Einladungen (ohne unnötige personenbezogene Daten).
- Archivieren: Events können als `archived` markiert werden (kein Listing für Spieler).
- Löschen: vollständiges Entfernen inkl. Caches/Einladungen/Spielerdaten nach Export möglich.

## Updates
- Quickstart-Installationen: `sudo APP_DIR=/opt/geocachingengine bash deploy/update.sh`
- Expert-Installationen: `git pull && npm install && npm run migrate && npm run build` oder eigenes Automations-Setup.

## Sicherheit & DSGVO
- Admin-Passwort aus Quickstart nur in `/root/geocachingengine-credentials.txt` gespeichert; nicht in Logs. Passwort nach erstem Login ändern.
- Credential-Datei ist root-lesbar (`chmod 600`); externe Sicherung und anschließendes Löschen dringend empfohlen.
- Datenminimierung: Pseudonyme Spieler-IDs, optionale E-Mail-Adressen nur für E-Mail-Einladungen.
- `.env` und Secrets gehören nicht ins Repository; `.gitignore` schließt diese aus.
- Reverse-Proxy-Konfiguration sollte HTTPS erzwingen; Cookies sind HttpOnly/SameSite konfiguriert.
- Cleanup: `npm run cleanup` kann nach `DATA_RETENTION_DAYS` alte Events/Spielerdaten entfernen.

## Assets
- Repository enthält nur textbasierte Platzhalter-Assets (SVG). Produktive Grafiken/Icons sollten extern oder via CDN eingebunden werden.

