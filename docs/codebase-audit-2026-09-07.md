# AIDOLON Codebase-Audit – 7. September 2026

Die größten Verbesserungen liegen in verlässlichen Prozess- und Sitzungszuständen, einer entkoppelten Telegram-Eingangsschleife und einer separaten Audio-Pipeline. Ein leistungsfähigeres Modell allein behebt die derzeitigen Engpässe nicht. Die vorhandenen Skills, das MCP-Plugin, die modularisierten Command-Handler und die warmgehaltenen Audioprozesse sind eine brauchbare Grundlage für eine schrittweise Modernisierung.

## Refaktor nach dem Audit

Die Befunde unten dokumentieren den **Ausgangszustand vor dem Refaktor**; Zeilennummern sind historische Orientierung. Die isolierten Proben unter `runtime/out/audit-2026-09-07` reproduzieren alte Fehler und sind keine Regressionstests für den geänderten Code.

| Befunde | Umsetzung / verbleibende Grenze |
|---|---|
| Astra | `/model` liest den nativen Codex-Modellkatalog mit Cache und statischem Fallback. Astra: low, medium, high, xhigh, max, ultra. Lokaler `model/list`-Abruf erfolgreich; bestehender Standard bleibt erhalten. |
| F01 | Capture-Dienst liefert Bildbytes aus einem privaten temporären Ordner; der unprivilegierte Client schreibt die Zieldatei. Protokolltests mit synthetischen Bildern. Dienst hier inaktiv; Systeminstallation noch nicht aktualisiert, siehe unten. |
| F02 | Reale Pfade, offenes Dateihandle, Größenlimit und Versand desselben Byte-Snapshots. Linux-Symlink-Regressionen bestanden; Windows nicht praktisch geprüft. |
| F03 | Gruppen verlangen zusätzlich freigegebene Sender über `TELEGRAM_ALLOWED_USER_IDS` (Fallback: Hauptchat-ID). Callback-Sender wird mitgeprüft. Vollständige Mandantentrennung globaler Workspaces bleibt offen. |
| F04 | Persistenter Eingang, Verarbeitung pro Chat im Hintergrund, lokale Kontrollbefehle unabhängig vom Router, begrenzte Downloads und Router-Timeout 20 Sekunden. `/cancel` verwaltet weiterhin Lane-Jobs; Router ist zeitbegrenzt, aber noch kein vollständig integrierter abbrechbarer Lane-Job. |
| F05–F06 | Signalexit ist Fehler. Prozessgruppen mit Kill-Eskalation; Shutdown wartet auf Cleanup, ebenso MCP-Timeout. Linux-Enkelprozess praktisch geprüft; Windows nicht. |
| F07 | Exakte JS-Abhängigkeiten, Lockfile, Node >=22.19 und Launcher-Bootstrap. TTS wiederverwendet installierte Umgebung; vollständiges Python-/Modell-Pinning bleibt offen. |
| F08, F13 | Private Journale für Eingang und Jobs, Ergebnis vor Versand gespeichert, Versandfehler als `awaiting_delivery`. `/recover` zeigt unerledigte Arbeit/gespeicherte Antworten. Kein automatisches Wiederholen potenziell bereits ausgeführter Aktionen, keine Exactly-once-Garantie. |
| F09–F11 | Fehlende Projektverzeichnisse führen zu Fehlern; Startup-Cursor überspringt keine davor behaltenen Updates; Session beim Dispatch auflösen, alte Läufe nach `/new` dürfen aktive Session nicht zurücksetzen. |
| F12 | Einmaliger Retry ohne Output-Schema nur beim exakt erkannten Fehler vor Turnannahme; kein Retry nach begonnenem, abgebrochenem oder zeitüberschrittenem Turn. Mock-Regressionen; konkreter betroffener Live-Thread nicht verändert. |
| F14–F17 | Abort nach Audio-Warmup berücksichtigt, Bildsuffix korrigiert, Wetter-JavaScript durch Literalparser ersetzt, Env-Reihenfolge korrigiert. |
| F18 | `/compress` verwendet `thread/compact/start` über App Server. Noch kein Live-Test auf einer Benutzersitzung; die normale Ausführung bleibt Codex CLI. |

Neue Module trennen Prozessverwaltung, Dateizugriff, begrenzte Downloads, Datenparser, RPC, Gesprächsversionen und Journale aus `bot.js`. Audio entwertet alte automatische Antworten bei neuer Eingabe und liefert Mehrteiler abschnittsweise. Ein kompletter Ersatz der bestehenden Workerarchitektur und ein WebRTC-Gesprächsmodus sind nicht Bestandteil dieses Refaktors. Details: [Sprachmodernisierung](voice-modernization-2026-09-07.md).

**Betrieb:** Änderungen werden vom bestehenden Bot erst bei `/restart` geladen; keine zweite Instanz wurde gestartet. Der Capture-Dienst war bei Prüfung inaktiv. `sudo -n` scheiterte an erforderlicher interaktiver Authentifizierung; deshalb wurde nichts unter `/usr/local` oder `/etc` installiert. Vor Nutzung des neuen Capture-Clients den Dienst mit `./setup-linux-capture-backend.sh install` im Terminal aktualisieren. Altes und neues Socket-Protokoll sind nicht kompatibel.

**Tests:** 21 Node-Tests und 2 Python-Protokolltests erfolgreich; 29 JS-, 3 CJS-, 11 Python-, 12 Bash- und 7 JSON-Dateien syntaktisch geprüft. `npm audit --omit=dev` meldet für die installierten JS-Abhängigkeiten 0 bekannte Schwachstellen. `npm test` enthält isolierten Modul-Bootstrap, Schema-/Status-/Modellauswahl-Regressionen sowie Datei-, Datenparser-, Journal-, Inbox-, Netzwerk- und Prozessbaumtests. `python3 -m unittest discover -s tests -p '*_test.py'` prüft das Capture-Protokoll ohne Gerätezugriff. Keine echten Telegram-Nachrichten, Sprachmodell-Benchmarks oder Windows-Laufzeittests. Syntaxprüfungen und npm-Abhängigkeitsprüfung ergänzen diese Tests.

## Nachkorrektur: HTTP-Startfehler

Der erste Refaktor kombinierte Nodes eingebautes `fetch` mit dem externen Undici-8-Agent. Ein echter HTTP-Aufruf reproduzierte `UND_ERR_INVALID_ARG: invalid onRequestStart method`. Die bisherigen isolierten Tests hatten keinen HTTP-Verbindungsaufbau abgedeckt.

Telegram verwendet jetzt `fetch`, `Agent` und `FormData` aus derselben installierten Undici-Version. Der DNS-Callback berücksichtigt sowohl Einzeladressen als auch `options.all`. Ein neuer lokaler HTTP-Integrationstest prüft GET, JSON-POST, Multipart-Upload und Dateidownload mit den tatsächlichen Bot-Funktionen. Alle 22 Node-Tests bestehen; ein lesender Live-Aufruf von Telegram `getMe` war erfolgreich. Dabei wurden keine Nachrichten gesendet und keine zweite Bot-Instanz gestartet.

## Umfang und Nachweise des ursprünglichen Audits

- Inventar: 108 vorhandene getrackte Dateien, 33.403 Zeilen in JS/Python/Shell/PowerShell/CMD; `bot.js` allein 19.011 Zeilen nach der Astra-Ergänzung.
- Bereiche: Telegram-Eingang und Versand, Autorisierung, Codex-Aufruf und Events, Router/Worker/Lanes, Zustandsverwaltung, Attachments, Audio, WorldMonitor/Wetter, Launcher/Setup, Desktop-/TV-Werkzeuge, MCP und Projektanweisungen.
- Automatische Syntax-/Parse-Prüfungen: 21 JavaScript-Dateien, 10 Python-Dateien, 12 Bash-Dateien und 13 JSON-Dateien erfolgreich. Python wurde per AST geprüft, ohne Modelle zu importieren.
- Lokale Umgebung: Node v22.22.1, Codex CLI 0.153.4. `undici` wird hier aus `/usr/share/nodejs/undici/index.js` geladen.
- Isolierte JS-Proben: [probes.cjs](../runtime/out/audit-2026-09-07/probes.cjs). Aufruf vom Repo-Root: `node runtime/out/audit-2026-09-07/probes.cjs`. Sie bestätigen beobachtetes Fehlverhalten; ein erfolgreicher Probenlauf bedeutet **nicht**, dass die Befunde behoben sind.
- Weitere Nachweise: [Syntaxergebnisse](../runtime/out/audit-2026-09-07/syntax.json), [Capture-Probe](../runtime/out/audit-2026-09-07/capture-probe.json). Runtime-Nachweise werden entsprechend Repository-Regeln nicht versioniert.
- Keine zweite Bot-Instanz, keine Telegram-Nachrichten, keine echten Desktop-/TV-Aktionen, kein Root-Exploit und keine Modell-Downloads für das Audit. Keine Windows-Laufzeitprüfung; `pwsh` und `shellcheck` waren nicht verfügbar. Kein kontrollierter Audio-Benchmark und kein vollständiger Abhängigkeiten-/CVE-Scan.
- Vorhandene Änderungen an `README.md`, `bot.js` und `setup-whisper-venv.sh` wurden erhalten. Der ursprüngliche Bericht bezieht sich auf den damaligen Arbeitsbaum, nicht ausschließlich auf den letzten Commit.

Das ist ein codebasisweites, risikoorientiertes statisches Audit mit gezielten Reproduktionen, kein Nachweis vollständiger Fehlerfreiheit oder vollständiger Pfadabdeckung.

## Priorisierte Befunde

P1 = vor weiterem Funktionsausbau beheben; P2 = nächster Stabilitäts-/Modernisierungsschritt; P3 = kleinere Korrektur. Bei Sicherheitsbefunden ist die genannte Voraussetzung entscheidend.

### F01 · P1 · Root-Capture kann nach der Pfadprüfung außerhalb des erlaubten Verzeichnisses schreiben

**Fundstellen:** [Capture-Backend](../tools/linux_trusted_capture_backend.py), `sanitize_target`, `capture_framebuffer` (ab Zeile 341), `os.replace`/`os.chown`/`os.chmod` um Zeile 389; [systemd-Installation](../setup-linux-capture-backend.sh), Zeile 64.

Der als root vorgesehene Dienst prüft einen aufgelösten Pfad und verwendet ihn später erneut als Pfadnamen. Das Zielverzeichnis gehört zum vom Bot-Benutzer beschreibbaren Bereich. Ein lokaler Prozess dieses Benutzers kann zwischen Prüfung und Verwendung einen Elternordner durch einen Symlink ersetzen. Auch Eigentümer- und Rechteänderungen nach `os.replace` erfolgen über erneut aufgelöste Pfade. Die UID-Prüfung am Socket verhindert diese Race Condition nicht.

**Nachweis:** Mit temporären Verzeichnissen, synthetischer Capture-Funktion und deaktiviertem `chown` führte der originale Code die Ausgabe nach einem solchen Ordnerwechsel außerhalb von `OUTPUT_ROOT` aus. Keine privilegierten Dateien wurden berührt. Voraussetzung für die höhere Sicherheitswirkung ist der tatsächlich als root laufende Dienst.

**Maßnahme:** Privilegierten Dienst auf Gerätezugriff und Byte-Ausgabe beschränken; das Schreiben übernimmt der unprivilegierte Client. Alternativ feste Directory-Handles, symlinkfreie relative Operationen, `fchown`/`fchmod` auf offenen Handles und ein vom Benutzer nicht manipulierbarer temporärer Bereich. Ein erneuter `resolve()`-Aufruf allein genügt nicht.

### F02 · P1 · Attachment-Allowlist lässt Symlinks auf fremde Dateien passieren

**Fundstelle:** [bot.js](../bot.js), `resolveAttachPath`, Zeile 14801.

`path.resolve` und `_isPathInside` prüfen nur den lexikalischen Pfad. `statSync` und der spätere Upload folgen Symlinks. Eine Datei im erlaubten Ausgabeordner kann dadurch auf eine außerhalb liegende, für den Bot lesbare Datei zeigen. Das betrifft `/sendfile` und modellgenerierte Attachment-Direktiven.

**Nachweis:** Die JS-Probe legt ausschließlich eine synthetische Datei außerhalb eines temporären erlaubten Ordners an; ihr Symlink wird akzeptiert.

**Maßnahme:** Reale Root-/Dateipfade prüfen und die Datei race-resistent öffnen; geöffnete Daten in einen kontrollierten Versandbereich übernehmen. Regressionen für Symlink-Dateien, Symlink-Eltern, Traversal und normale Anhänge ergänzen.

### F03 · P1 bei Gruppen-/Mehrnutzerbetrieb · Chatfreigabe entspricht vollständiger Rechnerberechtigung

**Fundstellen:** [bot.js](../bot.js), `isAllowedMessage` Zeile 18353, `handleCallbackQuery` Zeile 18409; [Runtime-Befehle](../lib/command_handlers/runtime.js), [Workspace-Befehle](../lib/command_handlers/workspace.js).

Freigegeben wird die Chat-ID, nicht die Sender-ID. Bei `ALLOW_GROUP_CHAT=1` kann jedes Mitglied einer erlaubten Gruppe Befehle und Callback-Buttons verwenden. Hinzu kommen global verwaltete Workspaces und globale Runtime-Dateien: `/retire`, `/wipe` und `/prune` können andere erlaubte Chats betreffen. Bei ausschließlich privatem Einzelbenutzerbetrieb ist das kein anonymer Fernzugriff.

**Nachweis:** Autorisierungsprobe bestätigt die Annahme eines beliebigen Senders in einer freigegebenen Gruppe.

**Maßnahme:** Explizite Benutzer-/Administratorenfreigabe, auch für `callback_query.from.id`; destruktive Betriebsbefehle als globale Admin-Funktionen kennzeichnen. Vor Mehrnutzerbetrieb Ownership für Sessions, Workspaces und Dateien festlegen.

### F04 · P1 · Router oder Bilddownload können die gesamte Bedienung blockieren

**Fundstellen:** [bot.js](../bot.js), `pollLoop` Zeile 18747, `handleIncomingMessage` Zeile 18592, Bildverarbeitung Zeile 18221, `downloadTelegramFile` Zeile 17510; [Router](../lib/orch_router_runtime.js), Zeilen 337, 401, 625.

Der Poller wartet auf den Message-Handler. Dieser wartet bei normalen Prompts wiederum auf einen eigenen Codex-Routerlauf, sobald mehrere Workspaces vorhanden sind. Router-Timeout ist standardmäßig 0; diese Jobs sind nicht Teil der normalen Lane-Verwaltung und haben eine leere Chat-ID. Ein hängender Router verhindert so auch das Einlesen von `/cancel` und `/status`. Bilddownloads laufen ebenfalls im Eingangspfad; der Download besitzt dort kein eigenes Zeitlimit.

**Maßnahme:** Eingang nur validieren und dauerhaft registrieren; Routing und Downloads über begrenzte Hintergrundjobs ausführen. Kontrollbefehle müssen unabhängig erreichbar bleiben. Router in Cancellation/Lifecycle aufnehmen und ein kurzes eigenes Zeitbudget geben. Explizite Workspace-Auswahl und Reply-Zuordnung ohne Modellrunde auflösen.

### F05 · P1 · Signalabbruch wird als Erfolg klassifiziert

**Fundstelle:** [bot.js](../bot.js), `runCodexJob`, Zeile 17443.

Beim Node-Ereignis `close(null, "SIGKILL")` greift `typeof code === "number" && code !== 0` nicht. Ohne eigenes Cancel-/Timeout-Flag folgt `ok: true`. Das kann etwa bei externem Kill oder OOM-Abbruch auftreten und Erfolgs-Callbacks auslösen.

**Nachweis:** Mock-Prozess mit exakt diesem Close-Ereignis wird vom originalen `runCodexJob` als erfolgreich zurückgegeben.

**Maßnahme:** Erfolg nur bei `code === 0` und passendem abgeschlossenen Turn-Zustand; Signal/Exit/Schema-Status separat erhalten.

### F06 · P1 · Linux-Prozessbaum und Shutdown werden nicht zuverlässig beendet

**Fundstellen:** [bot.js](../bot.js), `terminateChildTree` Zeile 497, `shutdown` Zeile 18806; [MCP-Prozessrunner](../plugins/aidolon-native-control/scripts/aidolon-control-mcp.js), Zeile 77.

Die Linux-Funktion signalisiert nur den direkten Child-Prozess. Nachkommen werden nicht ausdrücklich erfasst. `shutdown` plant die spätere Eskalation und beendet unmittelbar danach den Bot mit `process.exit`, sodass dessen Eskalationstimer nicht mehr läuft. Der MCP-Runner beendet bei Timeout ebenfalls nur das unmittelbare Child und meldet den Timeout, bevor dessen tatsächliches Ende bestätigt wurde.

**Auswirkung:** Zurückbleibende Prozesse, weiterlaufende Aktionen oder belegte Ressourcen sind möglich. Ob ein konkretes Kind selbst seine Nachkommen aufräumt, ist vom jeweiligen Tool abhängig.

**Maßnahme:** Kontrollierte Prozessgruppen bzw. ein Supervisor mit verlässlichem Baum-Cleanup; begrenztes Warten auf Close und anschließend Kill-Eskalation. Test mit harmlosem Kind/Enkel-Prozess unter Linux und entsprechendem Windows-Test.

### F07 · P1 für Neuinstallation · JavaScript-Abhängigkeit fehlt im Manifest

**Fundstellen:** [bot.js](../bot.js), Zeile 9; [package.json](../package.json); [start.sh](../start.sh), Zeile 99.

`require("undici")` wird beim Start ausgeführt, aber `package.json` deklariert keine Dependencies. Die geprüfte Maschine liefert zufällig eine Distributioninstallation. Eine reine Node-Installation nach README kann mit `MODULE_NOT_FOUND` abbrechen; `npm install` allein kennt die fehlende Dependency nicht.

**Maßnahme:** Benötigte externe Module deklarieren, Lockfile und unterstützte Node-Version festlegen; Neuinstallation in sauberer Umgebung testen. Python-Modelle und Pakete ebenfalls reproduzierbar versionieren. `git+...MiraTTS.git` ohne Revision und allgemeine Upgrade-Aufrufe sind keine reproduzierbare Auslieferung.

### F08 · P1 · Bestätigte Telegram-Aufträge können beim Crash verloren gehen

**Fundstellen:** [bot.js](../bot.js), `buildStateSnapshot` Zeile 2064, `pollLoop` Zeile 18747, `shutdown` Zeile 18806; [Lanes](../lib/orch_lane_runtime.js), Zeile 347.

Telegram-Update-IDs und Task-Metadaten werden gespeichert, ausführbare Queue-Jobs jedoch nur im Speicher gehalten. Nach einem Crash kann der Cursor bereits hinter dem Auftrag liegen, obwohl dessen Queue verloren ist. Der umgekehrte Zeitablauf kann Wiederholung auslösen. Beim Shutdown werden Queues aktiv geleert. Atomarer JSON-Dateiersatz schützt nicht die Transaktion zwischen Eingang, Job und Ausgabe.

**Maßnahme:** Kleine persistente Inbox/Job-/Outbox-Verwaltung, z. B. SQLite mit eindeutiger `update_id`, Status und Recovery. Nach Crash Aktionen mit unklarem Ausführungszustand als prüfbedürftig markieren, nicht blind erneut ausführen.

### F09 · P1 · Fehlender Projektordner führt in das Bot-Repository

**Fundstelle:** [Lane-Registry](../lib/orch_lane_registry_runtime.js), `resolveUsableWorkdir`, Zeile 90.

Ist ein Projekt nicht vorhanden, wird `ROOT` als Arbeitsverzeichnis verwendet. Ein Auftrag für ein verschwundenes Repository kann damit im Bot-Repository landen. Außerdem reicht `existsSync`; eine normale Datei wird als Arbeitsverzeichnis akzeptiert und scheitert später.

**Nachweis:** Isolierte Probe bestätigt den Fallback `/missing-project` → `/bot-repo`.

**Maßnahme:** Projektgebundene Arbeit mit einer verständlichen Fehlermeldung stoppen; `stat.isDirectory()` prüfen. Den allgemeinen Workspace bewusst auswählen lassen oder nur bei von vornherein allgemeinen Aufgaben verwenden.

### F10 · P2 · Startup-Cursor kann einen angeblich behaltenen Callback überspringen

**Fundstelle:** [bot.js](../bot.js), `skipStaleUpdates`, Zeile 18720.

Ein Callback ohne Message-Datum wird als behalten gezählt. Eine nachfolgende alte Nachricht darf den globalen Cursor dennoch über diesen Callback hinausheben. Im nächsten Poll ist der Callback verloren.

**Nachweis:** Callback Update 10, alte Nachricht Update 11 → Cursor 11, obwohl Callback 10 nicht verarbeitet wurde.

**Maßnahme:** Cursor nur über ein zusammenhängend verarbeitetes/ausdrücklich verworfenes Präfix erhöhen; gemischte Startup-Batches testen.

### F11 · P2 · Wartende Prompts speichern die Session zu früh

**Fundstellen:** [Lanes](../lib/orch_lane_runtime.js), Zeile 290 und Zeile 755.

`resumeSessionId` wird beim Enqueue gespeichert. Läuft gerade der erste Auftrag einer neuen Unterhaltung, existiert seine Session möglicherweise noch nicht in der Chat-Zuordnung. Ein in dieser Zeit eingereihter Folgeauftrag speichert eine leere ID und startet später eine weitere neue Session, obwohl der Vorgänger inzwischen eine ID geliefert hat. Kontextsnippets können das verdecken, ersetzen die native Fortsetzung aber nicht.

**Maßnahme:** Explizit gewählte Sessions von automatischer Fortsetzung unterscheiden; automatische Session erst beim Dispatch auflösen. Gleichzeitig eine Gesprächsgeneration speichern, damit `/new` oder `/start` laufende Altaufträge nicht später wieder zur aktiven Session machen.

### F12 · P1, vom Benutzer beobachtet · Kein definierter Umgang mit aktiven Turns und Schema-Konflikten

**Fundstellen:** [bot.js](../bot.js), `buildCodexExecSpec` Zeile 4884, Schema-Option Zeile 4947 und Fehlerbehandlung Zeile 17443; [Resume-Befehl](../lib/command_handlers/codex.js), Zeile 96.

Der Bot reicht sein Output-Schema auch bei `exec resume` weiter, ohne einen aktiven Turn samt dessen Ausgabeanforderungen zu verwalten. Der vorgelegte Fehler `ActiveTurnOutputSchemaMismatch` passt zu einem Versuch, einem aktiven Turn abweichende Schema-Anforderungen mitzugeben. Das genaue konkurrierende Ereignis ist durch den Logauszug allein nicht bewiesen; die Sitzung wurde im Audit nicht erneut angestoßen.

**Maßnahme:** Pro Thread aktiven Turn und Eigentümer verfolgen; laufende Arbeit gezielt steuern bzw. auf deren Abschluss warten. Schema nur passend zum neuen Turn festlegen. Kein pauschaler Retry und kein globales Abschalten strukturierter Ausgabe. `/new` kann eine neue Unterhaltung ermöglichen, verliert aber die unmittelbare native Fortsetzung und ist keine Fehlerbehebung.

### F13 · P2 · Erfolgreiche Arbeit kann ohne zugestellte Antwort verschwinden

**Fundstellen:** [Lanes](../lib/orch_lane_runtime.js), Zeilen 938–1000; [Task-Lifecycle](../lib/orch_task_runtime.js), Zeile 175.

Fehler beim Versand der Ergebnisnachricht werden geloggt; der Task wird trotzdem anhand von `result.ok` als abgeschlossen gespeichert. Es gibt keine dauerhafte Outbox oder einen separaten Zustellstatus. Bei einem kurzen Telegram-Ausfall bleibt das Ergebnis unter Umständen nur lokal zurück.

**Maßnahme:** Ausführungserfolg und Zustellung trennen, Ergebnis und ausstehende Nachricht persistieren. Telegram-Fehlerdetails einschließlich `retry_after` erhalten; bei unklarem Upload-Ausgang nicht unkontrolliert doppelt senden.

### F14 · P2 · Bereits abgebrochenes Audio kann nach dem Abbruch noch registriert werden

**Fundstellen:** [bot.js](../bot.js), `requestTtsKeepalive` Zeile 16083 und `transcribeAudioWithWhisperKeepalive` Zeile 17807.

Nach dem asynchronen Warmstart wird bei bereits abgebrochenem Signal `onAbort()` aufgerufen, aber danach trotzdem `pending` gesetzt und in den zuvor erhaltenen Prozess geschrieben. Zum Zeitpunkt des Stop-Aufrufs war dieses Pending noch nicht registriert. Je nach Prozessende/Schreibfehler folgt eine verspätete Ablehnung oder ein unnötig wartender Request. Für häufige Sprachunterbrechungen ist dieser Ablauf besonders ungünstig.

**Maßnahme:** Vor und unmittelbar nach jedem Warmstart `signal.aborted` prüfen und sofort abbrechen; Pending/Listener in definierter Reihenfolge setzen und in einem zentralen Abschlussweg entfernen. Testfälle für Abbruch vor, während und nach Warmstart.

### F15 · P3 · Gültige Bildendung wird zu `.img`

**Fundstelle:** [bot.js](../bot.js), Zeile 18301, `safeExt`.

Der Regex ist an dieser Stelle doppelt escaped. `.png` wird nicht erkannt und als `.img` gespeichert. Manche Decoder erkennen den Inhalt weiterhin; Dateiendungs-basierte Werkzeuge oder Uploadbehandlung können daran scheitern.

**Nachweis:** Originale Zuweisung mit `.png` ergibt `.img`.

**Maßnahme:** Literalpunkt korrekt matchen; Bildinhalt und MIME zusätzlich validieren, Endung nicht als Sicherheitsnachweis verwenden.

### F16 · P2, Härtung · Wetterdaten werden als JavaScript ausgeführt

**Fundstellen:** [bot.js](../bot.js), `parseCwaJavascriptVariable` Zeile 12396, `fetchCwaTaiwanWeatherBriefing` Zeile 12466, `fetchTextUrl` Zeile 7678.

Die Anwendung lädt JavaScript eines externen Datenanbieters und führt es zweimal in einem VM-Kontext aus, um Datenvariablen auszulesen. Das Zeitlimit reduziert CPU-Hänger, bietet aber keine harte Speichergrenze; der Textdownload ist ebenfalls nicht größenbeschränkt. Das ist unnötig aktive Verarbeitung für einen Datenfeed. Ein konkreter VM-Ausbruch wurde nicht nachgewiesen.

**Maßnahme:** Daten-API oder restriktiver Parser für reine Literale; maximale Antwortgröße und strikte Datenvalidierung. Falls aktive Verarbeitung unvermeidbar ist, isolierter Worker mit Ressourcenlimit.

### F17 · P3 · Workflow-Pfad ignoriert die später geladene `.env`

**Fundstellen:** [bot.js](../bot.js), `WORKFLOW_CATALOG_PATH` Zeile 25, `loadEnv` Zeile 729.

`ORCH_WORKFLOW_CATALOG_PATH` wird ausgewertet, bevor `.env` geladen ist. Ein ausschließlich dort gesetzter Wert wirkt nicht; ein bereits exportierter Prozesswert funktioniert.

**Maßnahme:** Konfiguration in einem einzigen, nach `loadEnv` ausgeführten Schritt parsen und validieren. Solche Reihenfolgeabhängigkeiten durch reine Config-Tests abdecken.

### F18 · P2 · `/compress` erzeugt eine Zusammenfassung, keine nachgewiesene native Kompaktierung

**Fundstelle:** [Codex-Befehle](../lib/command_handlers/codex.js), Zeile 131.

Der Befehl schickt lediglich einen normalen Prompt mit der Bitte um Komprimierung. Der Bot ruft keine native Kompaktierungsoperation auf. Eine Antwortzusammenfassung kann hilfreich sein, garantiert aber keine Verkleinerung des aktiven Kontexts.

**Maßnahme:** Echte Kompaktierung im Codex-Adapter anbieten und Abschlussstatus anzeigen; bis dahin den Befehl als Zusammenfassung benennen.

## Architektur: behalten, ersetzen, ausbauen

| Bereich | Entscheidung | Konkreter Nutzen |
|---|---|---|
| Telegram-Transport, Reply-ID-Zuordnung, Uploads | Behalten und modularisieren | Telegram-spezifische Aufgaben bleiben klar kontrollierbar. |
| Eigener Modell-/Denkstufenkatalog | Dynamische Discovery mit letztem gültigem Cache | Neue Modelle benötigen künftig keinen Bot-Patch. |
| CLI-Prozess pro Nachricht, private JSONL-Session-Scans | Codex-Adapter auf App Server prüfen | Explizite Session-/Turn-Zustände; weniger Annahmen über interne Dateiformate. |
| Generischer LLM-Router und Split-Framework | Auf Workspace-Zuordnung reduzieren | Weniger Vorlauf, weniger eigene Agentenlogik; komplexe Zerlegung an Codex. |
| Skills, MCP-Plugin, `AGENTS.md` | Behalten, gezielt konsolidieren | Fähigkeiten werden zentral gepflegt und außerhalb Telegram nutzbar. |
| Prompt-Preambles, Sprachregeln, Fehler-Lessons | Doppelungen reduzieren | Weniger wiederholter Kontext und weniger widersprüchliche Anweisungen. |
| Queue, Taskzustand und Telegram-Outbox | Kleine persistente Steuerung | Crash-Recovery, Zustellstatus und nachvollziehbare Abbrüche. |
| STT/TTS-Worker | Austauschbare Adapter | Modelle vergleichen, ohne Chat-/Queue-Code umzubauen. |
| Wetter und WorldMonitor | Eigenständige Dienste/Module | Feed-I/O und Parsing behindern die Sprachbedienung weniger. |
| Desktop-/TV-Scripts | Als Spezialwerkzeuge behalten | Gerätespezifische Fähigkeiten sind durch ein besseres Sprachmodell nicht automatisch überflüssig. |

Die aktuelle offizielle App-Server-Dokumentation beschreibt `model/list` einschließlich Denkstufen, `thread/list`/`thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt` und `thread/compact/start`. Diese Schnittstellen passen zu den genannten Ersatzstellen. Die Architekturentscheidung, sie hier hinter einem Adapter einzuführen, ist eine Empfehlung dieses Audits. Verfügbarkeit und Protokoll sollten gegen die installierte CLI geprüft werden. [OpenAI: App Server](https://learn.chatgpt.com/docs/app-server)

Für das Transportprogramm empfiehlt sich ein einziger normalisierter Ereignisstrom: Eingang → Auftrag → Thread/Turn → Fortschritt → Ergebnis → Zustellung. `bot.js` kann dann überwiegend starten und Komponenten verbinden. TypeScript oder zumindest JSDoc-Typen helfen besonders bei Jobvarianten und Callback-Verträgen; eine vollständige Sprachmigration ist keine Voraussetzung für die ersten Reparaturen.

## Audio und Realtime

Der gesonderte [Audio- und Realtime-Vorschlag](voice-modernization-2026-09-07.md) vergleicht neuere STT/TTS-Kandidaten, erklärt die heutigen Wartezeiten und beschreibt Unterbrechungen sowie einen möglichen Live-Kanal. Die Ideen sind Optionen, keine bereits beschlossene oder implementierte Produkterweiterung.

## Empfohlene Reihenfolge

1. **Stabilitätsfundament:** F01/F02, Autorisierungsgrenzen bei Gruppen, F04–F09 und der beobachtete Schema-Konflikt. Echte Regressionstests für Abbruch, Pfadgrenzen, Sessionwechsel und Crash-Recovery.
2. **Codex-Adapter:** zunächst Modell-Discovery und Sessionzustand, dann native Interrupt-/Steer-/Compact-Operationen. Bestehenden CLI-Pfad nur als bewusst getesteten Übergang weiterführen.
3. **Audio messbar machen:** Stufenlaufzeiten, Zeit bis zum ersten Audio, RTF, Abbruchlatenz und Queue-Wartezeit. Dann bestehende Pipeline und zwei bis drei passende Modelle vergleichen.
4. **Sprachkomfort:** Generations-IDs gegen verspätete Audioausgabe, kürzere erste Sprachsegmente und sauberer Umgang mit neuen Nutzereingaben.
5. **Optional Live-Sprachfenster:** erst auf Basis stabiler Threads und verlässlicher Audio-Abbrüche; eigener kleiner Prototyp mit echten Handytests.

Ergänzende sinnvolle Funktionen: `/doctor` für lokale Komponenten und Capability-Checks; `/latency` für die letzten Pipelinezeiten; eine aktualisierbare Statusnachricht statt Fortschrittsflut; getrennte Sprachprofile „schnelles Gespräch“ und „ausführlicher Arbeitsauftrag“; Offline-/Textfallback bei Audiofehlern. Diese Funktionen sollten auf denselben Zustandsdaten aufbauen und keine weitere parallele Orchestrierungsschicht erzeugen.

## Nachkorrektur: fremde Companion-Thread-ID

Am 7. September gegen 21:12 Taiwan-Zeit enthielten Companion-Werkzeugausgaben eine Windows-Thread-ID. `findSessionIdDeep` durchsuchte auch verschachtelte Werkzeugausgaben und ersetzte damit die lokale Sitzung. Folgefragen scheiterten anschließend an `no rollout found`.

Die Sitzungserkennung akzeptiert jetzt ausschließlich die äußere stdout-Nachricht `thread.started`; JSON-Tools, Agententext und stderr dürfen keine Sitzung festlegen. Bei JSON-Ausführung entfällt außerdem die freie Textsuche als Session-Fallback. Eine explizite private Zuordnung in `runtime/session-repairs.json` korrigiert den nachgewiesenen beschädigten Verweis beim nächsten Lauf nach Bot-Neustart auf den erhaltenen ursprünglichen Chat. Das ist keine automatische Neuerstellung oder pauschale Wiederholung fehlgeschlagener Aktionen. Die ursprüngliche Sitzung wurde mit `thread/read` erfolgreich lesend geprüft. Neue Regressionen decken verschachtelte Companion-Ausgaben, unveränderte Elternsitzung und gezielte Reparatur ab.

## Windows-App und Telegram gemeinsam verwenden

Der aktuelle Companion bietet Desktopsteuerung und Prozessausführung, aber noch keine dauerhafte gemeinsame Codex-Chat-Verbindung. Für diese Erweiterung braucht jede Bindung mindestens Rechner, Codex-Profil, Thread-ID und Verbindung zum zuständigen App Server. Eine auf Windows erzeugte ID darf nicht an die Linux-CLI geschickt werden.

Vorgesehener Ablauf: Telegram-Audio lokal transkribieren, an den zuständigen Windows-Thread senden, sichtbare `agentMessage`-Zwischenmeldungen sammeln und mit einer eigenen TTS-Stimme ausgeben. `turn/steer` kann einem aktiven Turn weitere Eingaben zuführen; abgeschlossenes/untätiges Gespräch verwendet `turn/start`. Ereignisse nach Thread/Turn/Item deduplizieren und Satzstücke erst nach stabilen Grenzen sprechen. Keine parallelen unabhängigen Schreiber auf denselben Verlauf und keine Werkzeuglogs oder internen Reasoning-Inhalte als Sprachantwort.

Diese Schnittstellen sind in der [offiziellen App-Server-Dokumentation](https://learn.chatgpt.com/docs/app-server) beschrieben. Eine erreichbare gemeinsame Verbindung zur konkret laufenden Windows-Desktop-App ist hier **nicht verifiziert**. Die App wurde weder geöffnet, neu gestartet noch unterbrochen. Ein separater Prozess, der nur dieselbe gespeicherte Thread-ID lädt, belegt keine Live-Synchronisierung mit der App. ChatGPT-Chats sind ebenfalls nicht automatisch Codex-Threads.
