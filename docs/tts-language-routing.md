# TTS language routing

Keep `TTS_MODEL=models/MiraTTS` for English/Chinese. After downloading the gated
German fine-tune, set `TTS_MODEL_DE=models/MiraToffel` and optionally
`TTS_DEFAULT_LANGUAGE=de` in the private `.env`, then use `/restart`.
Startup prewarming imports the Python synthesis libraries without loading GPU
models. The first speech request loads the language model it needs.
`TTS_SEND_TEXT=0` keeps successful voice replies voice-only in the ordinary bot;
app topics use `/app output auto` to follow text versus voice input.

Both models use `TTS_REFERENCE_AUDIO` (including an English reference sample).
No German reference is required by the bot. Speaker similarity across languages
needs listening evaluation; sharing a reference does not guarantee identical voices.
The existing optional `TTS_REFERENCE_AUDIO_ZH_TW` still applies to Chinese text.

Routing uses an offline word/script heuristic for German, English and Chinese.
It evaluates the complete TTS job, including all chunks of a batch, to avoid
switching models for short fragments. Ambiguous text uses `TTS_DEFAULT_LANGUAGE`.
This is not a universal language detector: mixed-language passages use one model,
and short or unusual text may be misclassified. Other languages need their own
supported models and a stronger detector before claiming support.

Speech text preparation also follows the detected language. German replies use
German link/path placeholders, `Grad Celsius`, and clock forms such as `6 Uhr`.
They bypass the previous English contractions/ordinal/clock expansions. Slash
commands become `Schrägstrich app`; `$Skill` becomes `Dollarzeichen Skill`, while
`$5`/`5 $` become `5 Dollar`. English uses English symbol names and retains its
existing clock/ordinal rules. These changes apply to spoken text, not the
original Telegram message or executable command. Regression tests exercise both
languages and repeated normalization.

Measurements: Celsius/Fahrenheit and Kelvin (without "degrees"), signed and
decimal values; common currency symbols and ISO codes including EUR, GBP, CHF,
USD, TWD, CAD, AUD, HKD, JPY, CNY, KRW and INR. A bare yen/yuan symbol is kept
ambiguous as "Yen oder Yuan"; explicit JPY/CNY identifies the currency.
Numeric amounts normalize comma/dot separators without converting value or
currency. A single three-digit separator group is interpreted as thousands;
ambiguous numeric formats cannot always be inferred from text alone.
German currency amounts are now spelled out before synthesis: `0,37 $` becomes
`null Komma drei sieben Dollar`; `1 $` becomes `ein Dollar`. Decimal digits and
leading fractional zeros are retained explicitly, including three-digit German
decimal fractions. Feminine currency nouns use `eine` for the integer one.

Physical units include metric length, area and volume (m²/m^2/m2, m³/m^3/m3),
liters, mass, duration, speed/acceleration, energy/power, frequency, pressure,
voltage, current, resistance, force and amount of substance. SI case matters:
mW is milliwatts; MW is megawatts. Unknown units are not guessed. English uses
English unit names and singular/plural forms; German uses German names.

Only one synthesis request runs at a time. `TTS_IDLE_UNLOAD_MS=60000` is the
default: models load on demand and unload after one minute without voice input
or synthesis activity. Active and queued synthesis prevents idle unloading.
Python imports remain ready; both language pipelines, reference tensors, the
shared codec and unused CUDA allocator cache are released. A small CUDA context
can remain until the worker exits. Whisper stays loaded to transcribe voice input.

With `TTS_KEEP_MODELS_LOADED=1`, used language models share one codec and stay
available together until the idle timeout. The second language loads only on
first use. Set `TTS_IDLE_UNLOAD_MS=0` to restore always-resident startup prewarming.
Worker readiness and the list of GPU-loaded models are reported separately.

Set `TTS_KEEP_MODELS_LOADED=0` on a machine with insufficient VRAM to retain
load-on-switch behavior. That mode stops the previous worker and waits for it
to exit before loading the next language. Ordinary cancellation/recovery also
waits for the retiring worker. Pipeline recovery releases the failed pipeline
before allocating its replacement. `/speech status` or `node tools/tts-control.cjs
status` reports the loaded model list.

`/speech pause` persists a global speech pause, finishes the current synthesis
request, stops the TTS worker, and replies to future voice inputs with text.
`/speech resume` enables speech and preloads the configured models; the idle
timeout then applies again. Local agents use `node tools/tts-control.cjs
pause|resume|status` from this repository. Before user-requested GPU-heavy work,
they announce the pause and verify the control command succeeded. They resume
only on user request. No debugger or listening network port is required.

Chinese speech input uses [OpenCC](https://github.com/yichen0831/opencc-python)
`t2s` conversion before synthesis, preserving the original visible text and
Taiwanese vocabulary. In local back-transcription checks, Traditional Chinese
produced dropped/mispronounced words; equivalent Simplified input reduced those
errors. This is not a guarantee of word-perfect audio or a listening evaluation.
Set `TTS_CHINESE_SIMPLIFY=0` to disable this normalization.

The keepalive worker explicitly uses UTF-8 for its JSON pipes. On Windows,
redirected Python stdin otherwise defaults to the locale encoding, corrupting
umlauts and Chinese characters before they reach the model. The regression test
forces a legacy cp1252 environment and checks both decoded input and UTF-8 output
without allocating a GPU model.

Fine-tune: `SebastianBodza/MiraToffel_miraTTS_german`, pinned revision
`85ad2e06949d5537b54e3542bc95f54d1b9083ec`. Accept access conditions on Hugging Face,
then authenticate locally with `.tts-venv/bin/hf auth login`. Never put tokens in
chat or tracked configuration. Downloaded weights and credentials stay local.
