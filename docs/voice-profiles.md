# Voice effects

The existing voice reference remains the source of all profiles. These are DSP
characters, not different trained speakers. `/voice` selects a profile; `/abtest`
compares them. `/app voice` selects the intermediate-reply profile for an app chat.

| Profile | Character |
| --- | --- |
| hologram-ai | Soft, bright, ethereal; +3.2 semitones and brief upper-octave shimmer |
| starship-comms | Narrow-band radio, restrained digital grit, start/end signals |
| cyber-oracle | Deep, slow, dark; -5 semitones, short echo and sparse lower-octave shadow |
| alien-terminal | Metallic cyberpunk; mild continuous modulation and brief distorted fifths |
| anonymous | Dry, low and imposing; -7 semitones without echo/modulation |

The strong effects are parallel layers with short triangular gain envelopes.
Continuous main speech remains present. This avoids abrupt edits to the main
voice and limits transient pitch effects to short windows. Shared loudness
normalization replaces the old preset-specific gain boosts. Mono compatibility
is intentional because Telegram voice messages are encoded as mono Opus.

Radio and Alien profiles also repeat short captured audio segments (roughly
65–95 ms), with faded edges and at most two micro-loop windows per chunk.
Hologram and Alien have quiet delayed, pitch-shifted shadow voices. Small seeded
variations alter timing, wet gain, shadow delay and effect pitch, without
randomizing the core speaker identity. A job retains its seed for retries;
pipelined chunks derive distinct variations from their index. The app's selected
profile now applies to final answers as well as intermediate replies. Every
chunk retains that same profile.

Quiet generated backgrounds follow each character: airy harmonics for Hologram,
equipment hum/console beeps for Starship, low drones for Oracle, irregular
machine hum for Alien, and a dry server-room hum for Anonymous. A sidechain
compressor ducks the bed under speech. The voice defines output duration so the
continuous generators cannot extend the file indefinitely. No extra speech
model, GPU allocation or downloaded sound assets are involved.
`TTS_AMBIENCE_ENABLED=0` disables the bed; `TTS_AMBIENCE_LEVEL` accepts 0–1.
Natural/custom voices remain outside the ambience pipeline.

Optional FFmpeg filters are detected at runtime. If complex layering is
unavailable, profiles use their simpler filter chain. Pitch shifting prefers
rubberband; asetrate/aresample/atempo provide a duration-compensated fallback.
That fallback can sound different. Custom filtergraphs and the natural profile
retain their existing behavior.

Local preview renders: `runtime/out/voice-profiles/`. All five effect profiles
rendered through the real filtergraph builder into 48 kHz mono Opus. Their
measured loudness ranged from -19.44 to -18.12 LUFS and true peaks stayed below
-1.8 dBTP on the preview sentence. These are sample measurements, not a guarantee
for every utterance. Listening preference and perceived speaker femininity
require human evaluation.

### Expanded spaces (2026-09-08)

Backgrounds now combine slowly moving hums, seeded filtered noise, three staggered
synthetic event layers and occasional static/air swells. Hologram uses high floating
chimes, Starship short console chirps and radio static, Oracle low resonant sweeps,
Alien sliding electronic signals, and Anonymous restrained equipment tones.
Optional room echoes apply to the background itself. These sources are independent
of the vocal waveform, so the room remains audible during speech pauses. Moderate
ducking keeps words in front; output still ends with the voice clip.

The audio job/chunk seed controls frequencies, event timing, lengths and noise.
Retries reproduce that chunk's space; subsequent chunks vary it. The same processing
applies after German or English synthesis. Themes follow the selected voice profile,
not automatic interpretation of message content. No additional model is loaded.
On FFmpeg installations without `aevalsrc` or `aecho`, the simpler generated bed
remains available. Real FFmpeg tests verify every profile against a silent input:
nonzero background, finite/bounded samples and no unintended duration extension.

### Speaking speed

Profile speeds relative to synthesized speech: Hologram 1.5×, Starship 1.2×,
Oracle 1.1×, Alien 1.2×, Natural (`off`) 1.2×, Anonymous 1.25×.
Pitch-preserving `atempo` runs before voice effects and generated backgrounds,
so ambient sounds are not sped up. Previous small Hologram/Oracle tempo offsets
are removed. Natural retains its unmodified timbre while using the requested
speed. Custom profiles retain their own configured timing. Echoes and radio
bookends can make the final file slightly longer than source-duration/speed.
All six profiles were rendered with the actual production filtergraph builder.
