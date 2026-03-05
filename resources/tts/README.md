Starship comms beep assets.

Files:
- `a11-comms-start.wav`: short start-of-transmission tone.
- `a11-comms-end.wav`: short end-of-transmission tone.
- `quindar-tones.ogg`: source clip used to derive the two WAV files.

Source clip:
- https://upload.wikimedia.org/wikipedia/commons/5/56/Quindar_tones.ogg

Extraction used:
- start: `ffmpeg -i quindar-tones.ogg -ss 0 -t 0.26 -ac 1 -ar 48000 a11-comms-start.wav`
- end: `ffmpeg -i quindar-tones.ogg -ss 1.24 -t 0.28 -ac 1 -ar 48000 a11-comms-end.wav`
