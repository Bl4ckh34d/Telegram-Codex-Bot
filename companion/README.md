# AIDOLON Companion

Lightweight Windows/Linux endpoint in the same repository. Requires Node.js 22.19+
and the existing OS desktop tools, but no Telegram credentials, speech models,
or npm dependencies. Main AIDOLON handles Telegram and speech. Codex uses the
companion through a native stdio MCP adapter; no second Telegram poller runs.

For automatic Telegram forum topics and direct messages to existing desktop
and laptop Codex app chats, see [App topic synchronization](../docs/app-topic-sync.md).

## Start

Run `companion/start.cmd` on Windows or `bash companion/start.sh` on Linux from
the logged-in desktop session. The HTTP service binds only to IPv4 loopback.
The launcher generates `runtime/companion.json` with a random token on first use.
Keep this file private; an optional `port` defaults to 47831. On Windows store
the checkout under your private user profile, not a shared writable folder.
Windows desktop actions require an interactive session, not an SSH service
session. `companion/start-desktop.ps1` creates an on-demand scheduled task with
Interactive logon and limited privileges, then launches it. It does not enable
automatic startup at boot or logon. Close its terminal to stop; run the script
again to restart. Normal foreground launchers do not require a scheduled task.
Locked desktops and elevated applications may restrict available UI actions.
Linux reuses `tools/ui.sh`; install its dependencies from the tools README.
Wayland restrictions still apply; this does not bypass OS desktop permissions.

## Connect Through SSH

### Multiple computers

The controller and endpoints use the same Node/SSH transport on Windows and
Linux. Speech stays on the controller. Each endpoint runs its own desktop
session and installed tools with that user's privileges; this does not grant
administrator/root privileges or install every main-host tool automatically.

Use a private host registry as the MCP adapter's configuration and as
`APP_COMPANION_CONFIG`. Existing single-host JSON files still work:

```json
{
  "default_host": "windows",
  "hosts": {
    "windows": {"label": "Windows laptop", "config_path": "windows.json"},
    "linux": {"label": "Linux workstation", "config_path": "linux.json"},
    "testpc": {"label": "Test PC", "config_path": "testpc.json"}
  }
}
```

Paths are relative to the registry file. Each referenced file uses the SSH
configuration below. Add further entries as needed; there is no two-host limit.
`companion_hosts` lists IDs and labels. Pass `host_id` to all other MCP tools,
including job polling/cancellation: job IDs belong to their originating host.
With several hosts and no configured default, an omitted host is rejected.

Telegram: `/app hosts`, `/app list` (all hosts), `/app list windows` (one host),
then `/app use <number>`. Bindings retain both the companion ID and the app's
internal host/thread IDs. A failed computer is reported without hiding healthy
computers' chats. Existing bindings without a companion ID use the configured
default; keep that default stable or rebind them before changing it.

New intermediate replies include a screenshot from the bound companion by
default. `/app screenshots off` disables it; `/app screenshots on` enables it.
This is independent of text/voice mode. The interactive desktop client must be
running; the app chat bridge alone does not provide screen capture. Capture
shows the currently visible primary screen without focusing or manipulating
windows. It is taken when forwarding the update, not at its historical creation
time. Final replies and previously seen updates do not trigger screenshots.
Capture failures are reported without replaying the already delivered message.
Temporary screenshot files are removed after sending.
In text/both mode, the update is the photo caption rather than a separate
duplicate message. Captions use up to 1000 UTF-16 code units; longer updates
continue in a text reply to that photo. Forwarded updates omit repeated host and
chat titles. Voice-only mode uses a short generic screenshot caption.

Windows capture initializes per-monitor DPI awareness before reading WinForms
screen bounds or using GDI. This avoids mixing DPI-virtualized dimensions with
physical pixels. Live verification on the Windows laptop corrected a cropped
1536×960 capture to the complete 3840×2400 screen. The capture still targets the
primary monitor; it does not concatenate all displays.

The Codex-app IPC client supports named pipes and Unix sockets. On Windows it
can discover the pipe. Elsewhere set `pipePath` in `runtime/app-bridge.json` or
`CODEX_APP_TOOLS_PIPE_PATH` to the compatible running app's socket. This does
not provide a Codex desktop app where one is unavailable. Terminal/Codex CLI
and desktop control are independent of the app bridge.

Validation limits: Windows desktop operations and the app bridge were exercised
live. Linux core/transport tests pass, but desktop capture/input still require
a successful live session test (the current GNOME Wayland capture timed out).
Running the full speech stack on a Windows controller has not been tested.
Do not interpret a capability listing as proof that desktop permissions,
dependencies, authentication, or a particular executable are ready.

Install OpenSSH and configure key authentication and verified host keys. On the
main machine create a private JSON configuration, for example:

```json
{
  "destination": "user@companion-host",
  "ssh_args": ["-i", "/absolute/key", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5"],
  "remote_command": "node /absolute/repo/companion/request.js"
}
```

Register `node /absolute/repo/companion/mcp.js /absolute/private-config.json`
as a stdio MCP server in native Codex configuration. Give each machine a distinct
MCP server name. `remote_command` is trusted administrator configuration, not
user input. Quote Windows executable paths with spaces for the remote shell.
The SSH helper reads the token locally; it is never sent to the model.

Tools: `companion_status`, `companion_ui`, `companion_exec`, `companion_job`,
and `companion_cancel`. Execution returns immediately with a job ID. Poll that
ID until terminal; missing jobs after a service restart are unknown, not success.
File access and installed Codex execution use the executable/argument API.
For example run PowerShell with an argument array for Windows files, or the
installed Codex binary with its normal CLI arguments and local working directory.
Codex needs its own valid login on that machine; speech still runs on the main host.

UI calls serialize access (busy requests fail instead of racing). Screenshots
return PNG image content to Codex and delete the temporary capture afterwards.
Windows UI args use PowerShell names, Linux uses the existing script CLI names.
Screenshots currently capture the primary monitor. Shell jobs retain the last
100,000 characters per stream and up to 100 jobs in memory. At most eight jobs
run concurrently. Jobs are not persisted across companion restarts.

This endpoint grants the paired controller the privileges of its desktop user,
including file writes and executable launch. Protect the SSH key, local token,
and service directory. Do not expose the HTTP port to the LAN or Internet.
UI request timeouts do not prove an action failed; inspect before retrying.

## Verify

Run `node --test companion/server.test.js`, then exercise status, a harmless
command, window listing, screenshot, one reversible UI action and a second
screenshot on the actual target OS. Stop the companion with Ctrl+C; managed
child processes are terminated. No main bot restart is needed to start a
companion, but new Codex sessions may be needed to load newly registered MCP tools.

For existing sessions use `node companion/call.js CONFIG status` or
`node companion/call.js CONFIG ui '{"action":"screenshot"}'`. The fallback
saves received images under the main checkout's `runtime/out` for inspection
or Telegram attachments. It uses the same MCP adapter, not a second transport.

## Telegram mit demselben Windows-App-Chat verbinden

Die neue App-Brücke verwendet die lokale Named-Pipe-Schnittstelle der laufenden
Codex-App (`codex_app`: `list_threads`, `read_thread`, `send_message_to_thread`).
Sie startet keinen zweiten Codex-Prozess auf demselben Thread und bedient nicht
Maus oder Tastatur. Die App bleibt geöffnet und ihre Aufgaben laufen weiter.

Auf dem Hauptrechner `APP_COMPANION_CONFIG` auf die bestehende private
SSH-Konfiguration setzen und den Telegram-Bot mit `/restart` neu laden. Auf dem
Windows-Rechner müssen `companion/request.js` und `companion/app-bridge.js` aus
diesem Stand liegen. Der bestehende Companion-Server muss dafür nicht neu starten.
`runtime/app-bridge.json` benötigt `contextThreadId`: die ID eines vorhandenen
lokalen Codex-Chats als Aufrufkontext. Optional kann `pipePath` gesetzt werden;
sonst wird die Pipe aus dem laufenden App-Prozess ermittelt. Keine Tokens in
versionierte Dateien schreiben. Die private Konfiguration dieses Arbeitsplatzes
wurde eingerichtet; der vorhandene Companion-Testchat dient als Aufrufkontext.

Bedienung im Telegram-Chat:

1. `/app list` gruppiert die Codex-Chats nach Projekt/Repository in der von der App gelieferten Projektreihenfolge. Angeheftete Chats sind markiert, Chats ohne Projekt stehen separat. Die Auswahl bleibt durchgehend nummeriert.
2. `/app use 1` verbindet den ersten Eintrag. Die Auswahl übernimmt zunächst den
   aktuellen Stand; alte Antworten werden nicht nachträglich vorgelesen.
3. Normale Text- und Sprachnachrichten gehen danach an diesen App-Chat. STT und
   TTS laufen auf dem Hauptlaptop. Slash-Befehle bleiben lokale Bot-Befehle.
4. Neue sichtbare Antworten werden als Text gespiegelt. Zwischenmeldungen nutzen
   standardmäßig das Stimmprofil `starship-comms`; das ausgewählte Profil gilt
   auch für finale Antworten und alle Teile einer mehrteiligen Sprachausgabe. Die Profile verändern die vorhandene TTS-Stimme; es wurde kein
   zusätzliches Sprechermodell installiert.
5. `/app voice` öffnet Auswahlbuttons für die verfügbaren Stimmprofile und „Stumm“. Die Auswahl wird für die aktuelle Verbindung gespeichert; alte Buttons gelten nicht für neu verbundene Chats. `/app voice hologram-ai` wechselt das Zwischenstandsprofil auch direkt;
   `/app voice mute` deaktiviert Sprache. `/app status` zeigt die Verbindung.
6. `/app off` beendet Spiegelung und Weiterleitung. Die Windows-Aufgabe läuft weiter.

Die Auswahl wird pro Telegram-Chat gespeichert. Neue Audionachrichten stoppen
wie bisher ältere automatische TTS-Ausgaben. Ein Wechsel der App-Verbindung
während STT verhindert das Senden des Transkripts an den falschen Chat.

Der Abruf erfolgt ungefähr alle fünf Sekunden, nicht tokenweise. Es werden nur
fertig gespeicherte sichtbare Assistant-Nachrichten übernommen; keine internen
Reasoning-Inhalte oder Werkzeugausgaben. In der getesteten App-Version fehlten
neue Antworten teilweise in `read_thread`. Für lokale Windows-Codex-Chats liest
die Brücke deshalb zusätzlich ausschließlich die abgeschlossenen sichtbaren
Nachrichten aus dem vorhandenen lokalen Rollout (maximal 4 MiB Dateiende / 200
Nachrichten). Diese Dateien werden nie verändert. Bei längerer Offlinezeit kann
dieses Fenster überschritten werden; die Brücke ist kein vollständiges Chatarchiv.
Die App-Pipe und das Rolloutformat sind versionsabhängig. ChatGPT-Chats werden
in dieser ersten Umsetzung nicht zur Auswahl angeboten.

Unbestätigte Sendungen werden nicht automatisch wiederholt: Nach Verbindungs-
oder Timeoutfehler zuerst den App-Chat prüfen. Ein Absturz unmittelbar nach dem
Telegram-Versand kann eine doppelte Anzeige verursachen. TTS-Warteschlangen sind
begrenzt; der vollständige Text bleibt auch dann die maßgebliche Ausgabe.

Prüfung: `node --test tests/app-bridge.test.cjs`. Zusätzlich wurde im vorhandenen
Windows-Companion-Testchat eine echte Folgeeingabe über die App gesendet und
`APP_BRIDGE_OK` aus demselben Verlauf zurückgelesen. Die wichtige parallel laufende
Aufgabe blieb aktiv. Der komplette Telegram-Mikrofon-/Lautsprecherweg muss nach
Bot-Neustart mit einer Nachricht vom Handy geprüft werden.

### Desktop-Start auf dem eingerichteten Windows-Laptop

Die Desktop-Verknüpfung **AIDOLON Companion** startet
`%USERPROFILE%\aidolon-companion\companion\start.cmd`. Alternativ in PowerShell:
`& "$env:USERPROFILE\aidolon-companion\companion\start.cmd"`.
Das Terminal offen lassen; Ctrl+C beendet den Companion. Eine bereits laufende
Instanz nicht zusätzlich starten. Die Chat-Brücke benötigt die geöffnete Codex-App
und SSH; sie ist unabhängig vom HTTP-Companion für Desktopaktionen.

Die Rollout-Auswahl berücksichtigt inzwischen mehrere Fortsetzungsdateien eines
Chats: Sie nimmt die zuletzt geänderte Datei mit übereinstimmender Session-Metadaten-ID,
nicht den ersten Dateinamentreffer. Die Korrektur wurde auf Windows eingespielt
und die Zustellung der nachgeholten Nachrichten im laufenden Telegram-Bot bestätigt.

### Text, Stimme oder beides

`/app output` öffnet drei Buttons: **Nur Text**, **Nur Stimme**, **Text und Stimme**.
Alternativ: `/app output text`, `/app output voice`, `/app output both`.
Die Auswahl gilt für Zwischenantworten und finale Antworten der aktuellen
Verbindung und wird gespeichert. Sie steht auch unter `/app voice` zur Verfügung.
Ein Wechsel stoppt noch wartende/laufende automatische Sprachausgaben.
Kontroll- und Fehlermeldungen bleiben als Text sichtbar. Kann Sprache nicht
bereitgestellt werden, dient Text als Fallback; Text über dem konfigurierten
Sprachlimit wird ebenfalls als Text nachgereicht. Bestehende Verbindungen behalten
beim Upgrade ihr Verhalten (Stumm → Text; Sprache aktiv → beides).

Die Stimmprofile sind Effekte desselben TTS-Modells, keine zusätzlichen Sprachen.
Das [MiraTTS-Basismodell](https://huggingface.co/YatharthS/MiraTTS) ist für Englisch
und Chinesisch ausgewiesen. Für Deutsch ist [Piper](https://github.com/OHF-Voice/piper1-gpl)
mit [Thorsten medium](https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/thorsten/medium)
ein lokaler Testkandidat. [MiraToffel](https://huggingface.co/SebastianBodza/MiraToffel_miraTTS_german)
ist eine deutsche MiraTTS-Anpassung; der Download ist zugangsbeschränkt und setzt
die Annahme der Modellbedingungen voraus. Keines dieser Alternativmodelle wurde
bei dieser Änderung installiert oder als neuer Standard gesetzt.

### Telegram-Gruppe mit Themen

Die Gruppe muss Themen aktiviert haben. Der Bot braucht Adminrechte einschließlich
„Themen verwalten“. Die Gruppen-ID gehört in `TELEGRAM_ALLOWED_CHAT_IDS`, außerdem
`ALLOW_GROUP_CHAT=1`; `TELEGRAM_ALLOWED_USER_IDS` begrenzt weiterhin, wer ihn steuern darf.
Nach Konfigurationsänderungen den Bot mit `/restart` neu laden.

In „Allgemein“ bleibt der normale Hauptbot. `/app topics` legt für die vom Companion
aufgelisteten Codex-Chats jeweils ein Thema an und verbindet es. `/app topics <Host-ID>`
begrenzt dies auf einen Rechner. Bereits verbundene Chats dieser Gruppe werden
übersprungen; spätere Aufrufe ergänzen neu gelistete Chats. Alternativ `/app list`,
danach `/app topic <Nummer>` für einen einzelnen Chat. Themen heißen „Repository · Chat“;
Telegram unterstützt keine zusätzliche Ebene für Repository-Untergruppen.

Jedes Thema hat getrennte App-Zuordnung, Spracheingaben, Stimmen-/Ausgabeeinstellungen,
Menüs, lokale Sitzungen und Wiederherstellungsdaten. Screenshots und Sprachnachrichten
gehen in dasselbe Thema wie der Text. `/app voice`, `/app output` und `/app screenshots`
gelten dort jeweils nur für diesen Chat. Alte Antworten werden beim Verbinden nicht
nachgesendet. Die Codex-App arbeitet während der Einrichtung weiter.

Die private Bot-Unterhaltung bleibt verfügbar. Eine dort noch aktive App-Verbindung
kann mit `/app off` getrennt werden, wenn ihre Antworten jetzt ausschließlich im
Gruppenthema erscheinen sollen. `/app off` im Thema entfernt dessen Zuordnung; ein
späterer `/app topics`-Aufruf kann dafür ein neues Thema erstellen. Manuell gelöschte
Telegram-Themen werden derzeit nicht automatisch erkannt oder repariert. Bei einem
Timeout während der Themenerstellung zuerst in Telegram prüfen, ob das Thema bereits
angelegt wurde; die Erstellung wird nicht automatisch wiederholt.

Für einen vollständigen Umzug kann `TELEGRAM_CHAT_ID` auf die Gruppe gesetzt und die
alte private ID aus `TELEGRAM_ALLOWED_CHAT_IDS` entfernt werden. Dabei unbedingt die
persönliche User-ID in `TELEGRAM_ALLOWED_USER_IDS` beibehalten. Explizit gesetzte Ziele
für Wetter und andere Benachrichtigungen ebenfalls umstellen.
`APP_TOPIC_GROUP_ID` richtet die App-Themen beim Start ein;
`APP_TOPIC_MIGRATE_FROM_CHAT_ID` unterbindet das private App-Forwarding bereits vor
Abschluss der Einrichtung. Beim Verbinden des entsprechenden Themas werden dessen
Stimmen-/Ausgabeeinstellungen übernommen und die alte private Zuordnung entfernt.
Vorhandene private Chatverläufe in Telegram werden dadurch nicht gelöscht.

Companion-Abfragen sind pro SSH-Ziel auf zwei gleichzeitige Verbindungen begrenzt.
Folgeeingaben werden vor wartenden Hintergrundabfragen bearbeitet und untereinander
in Reihenfolge gehalten; unbestätigte Eingaben werden nicht automatisch wiederholt.
Einzelne Lesefehler werden beim nächsten Poll erneut geprüft. Erst nach drei
aufeinanderfolgenden Fehlern erscheint eine Meldung, höchstens alle fünf Minuten
pro Thema. `/app status` zeigt den aktuellen Verbindungsfehler auch vorher an.

Windows screenshots that sample as nearly black now request a display wake through
`SetThreadExecutionState(ES_DISPLAY_REQUIRED)` and retry twice after short waits.
This can physically illuminate an idle monitor; it does not inject keyboard/mouse
input, change the power plan, or unlock the session. Persistently black captures
are rejected instead of sent as usable screenshots. A genuinely almost-black
screen may also trigger this conservative check. Disconnected/locked sessions or
hardware without an active display can still require user intervention.
