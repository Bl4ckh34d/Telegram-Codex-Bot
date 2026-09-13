# Sprachbetrieb: Modernisierung und nächste Schritte

Stand: 7. September 2026. Empfehlungen beruhen auf Herstellerdokumentation und Codeprüfung; es wurden keine neuen Sprachmodelle heruntergeladen oder auf diesem Laptop verglichen.

## Bereits im Refaktor

- Neue eingehende Sprachnachrichten entwerten ältere automatische Sprachantworten desselben Chats. Noch wartende TTS-Aufträge werden entfernt, laufende Synthese wird abgebrochen. Explizite `/tts`-Aufträge und normale Coding-Aufträge bleiben eigenständige Aufgaben.
- Mehrteilige Sprachantworten werden standardmäßig abschnittsweise erzeugt und versendet (`TTS_BATCH_PIPELINED_MAX_CHUNKS=0`). Der Text kommt weiterhin nach Abschluss des Codex-Laufs; dies ist noch kein Token-Streaming vom Modell zur Stimme.
- Bereits abgebrochene STT-/TTS-Anfragen werden auch nach einem Warmup nicht mehr neu beim Backend angemeldet.
- Funktionierende MiraTTS-Installationen werden beim Start wiederverwendet. `TTS_UPGRADE=1` fordert eine erneute Installation/Aktualisierung an. Das beseitigt die im Log sichtbare wiederholte Installation und Entfernung von ONNX Runtime und NumPy im normalen Startpfad.
- Statusfragen wie „Gib mir mal den Status Check.“ werden lokal beantwortet.

Ein gewöhnlicher Telegram-Bot erhält eine abgeschickte Voice-Datei und sendet Voice-Dateien zurück. Die Bot API bietet dafür keinen kontinuierlichen Telefonkanal. Der Bot kann insbesondere die Wiedergabe einer bereits zugestellten Datei auf dem Handy nicht abbrechen. [Telegram Bot API](https://core.telegram.org/bots/api)

## Empfehlung: zwei getrennte Nutzungsarten

**Telegram-Nachrichten:** Die vorhandene Oberfläche behalten, STT messen und austauschen, wenn der Gewinn belegt ist. Kurze Antworten, kurze Audiostücke und sofortige lokale Status-/Abbruchbefehle verbessern die Bedienung ohne neues Frontend.

**Gesprächsmodus:** Eine kleine HTTPS-Weboberfläche vom Bot aus öffnen. Das Handy liefert Mikrofon-Audio kontinuierlich; VAD erkennt Sprechbeginn. Jeder Antwortlauf erhält eine Generation-ID. Bei neuem Sprechen werden laufende Antwort, TTS, Audiowarteschlange und Clientwiedergabe gemeinsam beendet. Bereits gehörte Textanteile müssen im Gesprächskontext von noch nicht gehörten Anteilen unterschieden werden. Das ist eine zusätzliche Oberfläche, keine Eigenschaft von `sendVoice`.

Für möglichst wenig Laptoplast ist WebRTC mit einer gehosteten Realtime-API ein sinnvoller Prototyp. Der Server stellt kurzlebige Zugangsdaten aus; ein dauerhaftes API-Secret gehört nicht ins Browser-JavaScript. OpenAI dokumentiert WebRTC-Verbindungen und VAD-basierte Unterbrechung; bei WebSocket-Anbindung muss die Anwendung Wiedergabe und Kürzung selbst koordinieren. Diese Variante benötigt Netzwerk und separat zu prüfende API-Kosten. [WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc), [Unterbrechung und Gesprächszustand](https://developers.openai.com/api/docs/guides/realtime-conversations)

Eine Telegram Mini App kann als Einstieg dienen. Ihre `initData` muss serverseitig validiert werden; `initDataUnsafe` ist kein Identitätsnachweis. Mikrofonzugriff und WebRTC im tatsächlichen Android-/iOS-Webview testen, mit externem Browser als Ausweichweg. [Telegram Mini Apps](https://core.telegram.org/bots/webapps)

## Lokale Modellkandidaten

| Kandidat | Zweck und Bewertung |
|---|---|
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | Erster Vergleich zum vorhandenen Whisper small: CTranslate2 und CPU-INT8. Gleiche Aufnahme und vergleichbare Modellgröße erleichtern eine faire Messung. |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Alternative mit Quantisierung und lokalen Streaming-Beispielen; sinnvoll für kontrollierbare CPU-Ausführung. |
| [Moonshine Streaming](https://moonshine-voice.readthedocs.io/en/latest/models/available-models/) | Kleine Streaming-STT-Modelle für Deutsch, Englisch und Mandarin. Sprachwechsel und gemischtsprachige Sätze separat testen; die Sprachen werden nicht automatisch durch ein einziges Modell abgedeckt. Lizenz pro konkretem Modell prüfen. |
| [Piper](https://github.com/OHF-Voice/piper1-gpl) | CPU-orientierter lokaler TTS-Kandidat. Deutsche/englische Stimmen auf Verständlichkeit testen; GPL-3.0 und jeweilige Stimmenlizenzen bei Weitergabe berücksichtigen. |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | Mehrsprachiger Qualitätskandidat mit Streaming-Unterstützung, 0.6B/1.7B. Herstellerlatenzen sind kein Nachweis für diesen Laptop. |
| [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) | Mehrsprachige STT-Alternative inklusive DE/EN/ZH. Ressourcenbedarf gegen kleine CPU-Modelle messen. |
| [Silero VAD](https://github.com/snakers4/silero-vad) | Sprachaktivitätserkennung für einen eigenen Gesprächskanal; ersetzt weder STT noch Echo-Unterdrückung. |

Die gelesene Hardwareausstattung (i9-12900H, 20 logische CPUs, ungefähr 30 GiB RAM) spricht dafür, CPU-Kandidaten zuerst zu messen. Daraus folgt keine belegte Echtzeitgeschwindigkeit. GPU-Verfügbarkeit und nutzbare Treiber wurden nicht als Benchmarkgrundlage bestätigt.

## Messplan vor einem Modellwechsel

1. 20–30 eigene DE-/EN-/ZH-Aufnahmen mit kurzen Befehlen, längeren Sätzen, Eigennamen, Hintergrundgeräuschen und Sprachwechseln verwenden.
2. Kalten Start getrennt vom warmen Betrieb messen: STT-Dauer, Modellantwortbeginn, erstes spielbares Audio, gesamte Antwortzeit; Median und 95. Perzentil.
3. Fehler bei Namen und Befehlen manuell zählen; RAM, CPU, Stromverbrauch und gleichzeitig laufenden Codex beobachten.
4. Unterbrechung während Warmup, Synthese und Upload prüfen. Alte Generationen dürfen anschließend keine neue Audioausgabe starten.
5. Im Gesprächsmodus Handy-Lautsprecher und Headset testen. Echo-Unterdrückung und falsch erkannte Sprechpausen bestimmen die Alltagstauglichkeit ebenso wie das Modell.

Erst danach den Standard wechseln. Eine gute nächste Erweiterung wäre `/doctor` mit diesen Latenzen, Backendzustand, Queue-Länge und letzten Fehlern, ohne private Prompts oder Tokens im Diagnosebericht auszugeben.
