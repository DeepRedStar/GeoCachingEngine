# GeoCachingEngine

GeoCachingEngine ist eine modulare Admin- und Event-Verwaltung für Geocaching-Gruppen. Das Repository enthält ein Vite/React-Frontend, ein Express/TypeScript-Backend und eine Prisma/PostgreSQL-Datenbankdefinition.

## Voraussetzungen
- Node.js 20+
- npm
- PostgreSQL mit einer erreichbaren Instanz (lokal auf `localhost:5432` für das Standard-Setup)

## Schnellstart
1. Abhängigkeiten installieren (Root + Workspaces):
   ```bash
   npm install
   npm install --prefix backend
   npm install --prefix frontend
   ```
2. Setup-Wizard ausführen und `.env` erzeugen:
   ```bash
   npm run setup
   ```
   - DATABASE_URL wird automatisch auf `postgresql://admin:admin@localhost:5432/geocaching` gesetzt.
   - Der Wizard fragt alle konfigurierbaren Felder ab und bietet optional an, Prisma-Migrationen zu starten.
3. Entwicklung starten (Backend + Frontend parallel):
   ```bash
   npm run dev
   ```
   - Backend: http://localhost:4000
   - Frontend: http://localhost:5173 (mit Proxy auf `/api`)
4. Admin-Login: Der Wizard setzt `ADMIN_PASSWORD` (Standard: `admin`).

## Admin-Oberfläche
- Login über das im Wizard gesetzte Passwort.
- Formulare zur Pflege der Impressum/Datenschutz/Support-Daten und Default-Radien (werden in der Datenbank gespeichert, `.env` bleibt unverändert).
- Event-Management
  - Felder: Name (min. 3 Zeichen), Beschreibung, Start-/Endzeit, Sichtbarkeitsradius, Fundradius, optionale Start-/Endpunkte
  - Validierung: Start < Ende, Radien > 0
  - Aktionen: Event anlegen, bearbeiten, löschen
- Live-Statusboard pro Event
  - Zeigt Caches mit Fundstatus, Fortschritt in %, gefundene Caches/Anzahl Spieler (pseudonym, keine Positionshistorie)
  - Nur für eingeloggte Admins sichtbar
- Systemstatus-Seite für Admins
  - DB-Check, Migrationsstatus, E-Mail-Status, Version
- Cache-Management pro Event
  - Felder: Koordinaten, Hinweis, Lösung
  - Aktionen: Cache anlegen, bearbeiten, löschen

## Öffentliche Spieler-Ansicht
- `/public`: Liste aktiver Events (Endzeit in der Zukunft)
- `/public/event/:id`: Detailansicht mit allen Caches, die innerhalb des Sichtbarkeitsradius liegen
  - Entfernung über die aktuelle oder manuell eingegebene Position (Haversine)
  - Spieler registrieren sich pseudonym (automatisch generierte ID, optionaler Nickname) und werden für Statistiken gezählt
  - Fund-Status wird im Browser (localStorage) gespeichert und zusätzlich serverseitig markiert; Lösung wird nach „Gefunden“ angezeigt

## Projektstruktur
```
backend/   Express + Prisma REST-API
frontend/  Vite + React Admin-UI und Public-Views
prisma/    Prisma-Schema (PostgreSQL)
scripts/   Setup-Wizard (npm run setup)
```

## Datenmodell
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
  players -> Player[]
  emailLogs -> EmailLog[]

Cache
  id (String, cuid)
  eventId -> Event
  latitude, longitude
  clue, solution
  createdAt
  foundByAny (Bool), foundAt?
  finds -> CacheFind[]

CacheFind
  id (String, cuid)
  cacheId -> Cache
  playerId -> Player
  nickname?, foundAt

Invitation
  id (String, cuid), token (unique)
  eventId -> Event
  deliveryMethod (LINK|EMAIL)
  email?
  isActive (Bool), deactivatedAt?
  createdAt, usedAt?
  emailLogs -> EmailLog[]

Player
  id (String, cuid)
  eventId -> Event
  nickname?
  createdAt, lastActiveAt

EmailLog
  id (String, cuid)
  eventId?, invitationId?, adminId?
  recipient, subject, status (SENT/FAILED/DISABLED/RATE_LIMITED)
  errorMessage?, createdAt
```

## Prisma
- Schema: `prisma/schema.prisma`
- Standard-URL: `postgresql://admin:admin@localhost:5432/geocaching`
- Migrationen: `npx prisma migrate dev --name <name>`
- Client-Generierung: `npx prisma generate`

## Konfigurierbare Felder (.env)
- PUBLIC_URL
- INSTANCE_NAME
- DEFAULT_LOCALES
- ENABLED_LOCALES
- CACHE_VISIBILITY_RADIUS
- CACHE_FOUND_RADIUS
- IMPRESSUM_URL
- PRIVACY_URL
- SUPPORT_EMAIL
- ADMIN_PASSWORD
- DATABASE_URL (setzt der Wizard automatisch)

## Beispiel-Admin-Workflow
1. Login im Admin-Bereich mit dem gesetzten Passwort.
2. Impressum/Datenschutz/Support-Daten und Default-Radien speichern.
3. Event anlegen (Name, Start-/Endzeit, Radien, optional Beschreibung/Start-/Endpunkt).
4. Caches für das Event hinzufügen (Koordinaten + Hinweis/Lösung).
5. In der öffentlichen Ansicht das Event prüfen und Geofence-Reichweiten testen.

## Commands
- `npm run setup` – Interaktiver Wizard, erzeugt `.env`, optional Migrationen.
- `npm run dev` – Startet Backend (Port 4000) und Frontend (Port 5173) parallel.
- `npm run dev:backend` – Nur Backend starten.
- `npm run dev:frontend` – Nur Frontend starten.
- `npm run lint` – Führt Linting in Backend und Frontend aus.
- `npm run format` – Formatiert Dateien mit Prettier.
- `npm run build --prefix frontend` – Frontend-Build.
- `npm run build --prefix backend` – Backend-Transpile.

## Ressourceneinsatz-Empfehlungen
- **10 Personen (Minimalsetup)**: Eine Instanz, Standard-DB, kein Load-Balancing nötig. Lokale Entwicklungsprofile ausreichend.
- **50 Personen (Mittel)**: Eine Instanz mit aktivierter Caching-Ebene oder erhöhten Ressourcen (CPU/RAM), Überwachung der Datenbank-IO.
- **100 Personen (Mehrere Instanzen)**: Mehrere App-Instanzen hinter einem einfachen Reverse-Proxy, gemeinsame PostgreSQL-DB, Sticky-Sessions oder Token-basierte Auth.
- **200 Personen (Load-balanced / Reverse Proxy)**: Horizontales Scaling (2–4 Backend-Instanzen), Frontend als statische Assets hinter CDN/Proxy, dediziertes DB-Cluster, Health-Checks und Zero-Downtime-Rollouts.

## Hinweise für Admins
- Passwort regelmäßig ändern (`ADMIN_PASSWORD` im Wizard setzen und erneut deployen).
- Nach Schema-Änderungen Migrationen ausführen und den Prisma-Client regenerieren.
- Backup-Strategie für die PostgreSQL-Datenbank definieren (z. B. tägliche Dumps).

## Sicherheit
- Mock-Auth: Token-basierte Session nach Passwort-Login (Default: `admin`). Für Produktion sollte eine echte Authentifizierung (z. B. OIDC) ergänzt werden.
- CORS ist standardmäßig offen für lokale Entwicklung. In produktiven Umgebungen entsprechend einschränken.

## Deployment auf VPS
- Voraussetzungen: Debian/Ubuntu, >=1 GB RAM, 10 GB Disk, Internetzugang, Root-Zugriff.
- Installation: `sudo bash deploy/install.sh` auf frischer VM ausführen. Script installiert Node.js LTS, npm, PostgreSQL, nginx, richtet Benutzer `geocaching`, systemd-Services und optionale Sicherheitsupdates ein.
- Update: `sudo bash deploy/update.sh` im Installationsverzeichnis ausführen (pullt Git, installiert Dependencies, führt Migrationen/Build aus und restarts Services).
- Nach der Installation `.env` prüfen/ergänzen (Admin-Zugang, SMTP, Domains, Radien).

## Deployment-Wizard
- `npm run deploy:config` fragt lokalen/public Modus, Domain und Basis-URL ab und schreibt `BASE_URL`, `DEPLOY_MODE`, `PUBLIC_DOMAIN` in `.env` sowie `deploy/config.json`.
- `deploy/nginx.conf.template` enthält Platzhalter `{{DOMAIN}}` und `{{PORT}}` für Reverse-Proxy-Konfiguration.

## Admin-Login & Setup
- Admin-Frontend ist unter `BASE_URL + /admin` erreichbar.
- Der Setup-Wizard (`npm run setup`) fragt Admin-E-Mail und Passwort (>=12 Zeichen) ab und legt einen initialen Admin an; Passwort nach Login ändern.
- Admin kann Events mit Sichtbarkeits- und Fund-Radien anlegen, Caches zurücksetzen und Exporte pro Event abrufen.

## Live-Statusboard & Monitoring
- Admin-Endpoint `/api/admin/events/:id/dashboard` liefert Fortschritt (Caches gefunden/gesamt), Fund-Zeitpunkte und pseudonyme Spieleranzahl (aktuell/gesamt, keine Bewegungsprofile).
- Dashboard im Admin-Frontend zeigt Fortschrittsbalken, Kennzahlen und Cache-Status.

## Health / Systemstatus
- Öffentliches Lightweight-Health: `GET /healthz` → `{ "status": "ok" }` (keine Sensiblen Daten).
- Admin-Systemstatus: `GET /api/admin/system-status` (authentifiziert) mit DB-Check, Migrationsstatus, E-Mail-Flag und Version.
- Systemstatus-Seite im Admin-UI visualisiert die Werte und erlaubt Reload.

## Export & Archivierung
- Export als JSON: `GET /api/admin/events/:id/export` (Event-Metadaten, Caches inkl. Funde, Einladungen ohne Tokens, pseudonyme Spieler).
- Archivieren: `POST /api/admin/events/:id/archive` blendet Events aus der öffentlichen Liste aus (`archived`, `archivedAt`).
- Löschen: `DELETE /api/admin/events/:id` entfernt Event, Caches, Einladungen, Spieler und zugehörige Funde/Logs.
- Empfehlung: Vor Löschung Export ziehen und sicher aufbewahren/vernichten (DSGVO).

## Einladungssystem
- Pro Event können Einladungen als Link oder E-Mail erzeugt werden (`POST /api/admin/events/:id/invitations`).
- Spieler können über `/join/:token` beitreten. Bei E-Mail-Zustellung werden nur die notwendigen Adressen gespeichert; bei Link-Einladungen werden pseudonyme Spieler-IDs erzeugt.

### E-Mail-Einladungen
- Link-Einladungen funktionieren immer und erzeugen einen teilbaren Join-Link.
- E-Mail-Versand ist nur möglich, wenn im Admin-Bereich ein SMTP-Postfach hinterlegt ist (Host, Port, Benutzer, Passwort, TLS, Absender-Adresse, optional Absender-Name).
- Ohne SMTP-Konfiguration bleibt die E-Mail-Option in der Einladungserstellung deaktiviert und es wird ein Hinweis angezeigt.
- Die Zustellbarkeit wird serverseitig geprüft (`emailSendingEnabled`-Flag in `/api/admin/settings`).
- SMTP-Variablen (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`) steuern optionalen Versand.

### Einladungstemplates pro Event
- Pro Event können Betreff und Text für Einladung-E-Mails gepflegt werden; im Admin-Formular gibt es einen „Standardvorlage verwenden“-Button.
- Unterstützte Platzhalter: `{{eventName}}`, `{{eventDescription}}`, `{{eventStart}}`, `{{eventEnd}}`, `{{inviteLink}}` (sollte enthalten sein).
- Ist kein Template hinterlegt, greift eine einfache Standardvorlage mit Link.

### Rate-Limiting & Audit-Log
- Konfigurierbare Limits pro Admin über `MAX_EMAILS_PER_HOUR_PER_ADMIN` und `MAX_EMAILS_PER_DAY_PER_ADMIN` (auch im Admin-Settings-Formular veränderbar).
- Überschreitungen führen zu HTTP 429 und werden im E-Mail-Audit-Log als `RATE_LIMITED` erfasst; E-Mails werden dann nicht versendet und keine Einladung angelegt.
- Das Audit-Log pro Event ist im Admin-Bereich einsehbar und zeigt Empfänger, Betreff, Zeitstempel und Status (`SENT`, `FAILED`, `DISABLED`, `RATE_LIMITED`).

### Einladungen deaktivieren (Opt-out)
- Einladungen können nachträglich deaktiviert/reaktiviert werden; deaktivierte Tokens sind nicht mehr nutzbar und melden beim Join eine neutrale Fehlermeldung.
- Deaktivierungszeitpunkt wird gespeichert und in der Admin-Liste angezeigt.

### Absenderprofil pro Event
- Optional kann pro Event eine eigene Absenderadresse/-name für Einladung-E-Mails gesetzt werden.
- Wenn leer, werden die globalen SMTP-Absenderdaten verwendet; sind keine verfügbar, bleibt Versand deaktiviert.

## Radius-Logik
- Pro Event konfigurierbar: `visibleRadiusMeters` (Anzeige) und `foundRadiusMeters` (Fund). Kein Hardcode; Standardwerte stammen aus SystemSettings.
- Found-Status wird eventweit geteilt und kann vom Admin zurückgesetzt werden.

## Datenschutz / DSGVO
- Datenminimierung: E-Mail nur für E-Mail-Einladungen, sonst pseudonyme Spieler-IDs. Keine weiteren Profildaten.
- `DATA_RETENTION_DAYS` steuert, ab wann abgelaufene Events samt Einladungen/Funddaten gelöscht werden (`npm run cleanup`).
- Export-Endpoint `/api/admin/events/:id/export` liefert JSON für Dokumentation oder Löschung.
- Betreiber bleibt für rechtliche Texte verantwortlich; Impressum/Privacy-Links sind konfigurierbar.
- Einladungstokens können deaktiviert werden; deaktivierte Tokens lassen keinen Event-Join mehr zu.
- E-Mail-Logs speichern nur Empfänger, Betreff, Status, kurze Fehlermeldung – keine Anhänge, keine Tracking-Pixel.
- Spieler bleiben pseudonym (ID + optionaler Nickname), Positionsdaten werden nur lokal verarbeitet und nicht serverseitig historisiert.
- Keine Third-Party-Tracker oder externes Monitoring eingebunden; Health-Endpoint gibt nur `status: ok` zurück.
- Admin-Passwörter werden gehasht abgelegt (PBKDF2) und nicht im Klartext gespeichert.

## PWA
- Manifest (`frontend/public/manifest.webmanifest`) und Service Worker (`frontend/public/service-worker.js`) erlauben Installierung als App-Shell.
- Offline: statische Assets/Startseite werden gecached; API-Anfragen fallen offline mit Fehlermeldung zurück.

## Assets & Platzhalter
- Binäre Assets (PNG/JPG/ICO/Webfonts) werden nicht mitgeliefert; stattdessen existiert ein minimalistisches SVG-Icon (`frontend/public/icon.svg`) für PWA/Bookmark.
- Produktive Bilder (z. B. Logos oder Event-Motive) müssen extern gehostet oder via CDN eingebunden werden.
- Build-Artefakte, `node_modules`, Coverage-Ordner und Caches werden durch `.gitignore` ausgeschlossen, damit PRs nur textbasierte Dateien enthalten.
