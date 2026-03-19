# Fish Audio S1-mini / S2 Expression Reference

Verified against official Fish Audio docs on 2026-03-19.

## Quick Read

- `S1` and `S1-mini` use fixed `(parenthesis)` tags.
- `S2` uses free-form `[bracket]` inline descriptions and is not limited to a closed tag list.
- Fish's current docs are not perfectly aligned across pages. This file separates:
  - canonical S1 tags from the main Emotion Control reference,
  - extra tags seen in official self-hosting/examples that should be tested before production use,
  - S2 starter tags/examples taken from official S2 sources.

## S1 / S1-mini: Canonical Fixed Tags

Use these with `(parentheses)`.

### Basic Emotions

`(happy)`, `(sad)`, `(angry)`, `(excited)`, `(calm)`, `(nervous)`, `(confident)`, `(surprised)`, `(satisfied)`, `(delighted)`, `(scared)`, `(worried)`, `(upset)`, `(frustrated)`, `(depressed)`, `(empathetic)`, `(embarrassed)`, `(disgusted)`, `(moved)`, `(proud)`, `(relaxed)`, `(grateful)`, `(curious)`, `(sarcastic)`

### Advanced Emotions

`(disdainful)`, `(unhappy)`, `(anxious)`, `(hysterical)`, `(indifferent)`, `(uncertain)`, `(doubtful)`, `(confused)`, `(disappointed)`, `(regretful)`, `(guilty)`, `(ashamed)`, `(jealous)`, `(envious)`, `(hopeful)`, `(optimistic)`, `(pessimistic)`, `(nostalgic)`, `(lonely)`, `(bored)`, `(contemptuous)`, `(sympathetic)`, `(compassionate)`, `(determined)`, `(resigned)`

### Tone Markers

`(in a hurry tone)`, `(shouting)`, `(screaming)`, `(whispering)`, `(soft tone)`

### Audio Effects

`(laughing)`, `(chuckling)`, `(sobbing)`, `(crying loudly)`, `(sighing)`, `(groaning)`, `(panting)`, `(gasping)`, `(yawning)`, `(snoring)`

### Pause / Atmosphere Markers

`(audience laughing)`, `(background laughter)`, `(crowd laughing)`, `(break)`, `(long-break)`

### Intensity Modifiers

Fish's main Emotion Control page explicitly shows adjective modifiers in front of the emotion word:

- `(slightly sad)`
- `(very excited)`
- `(extremely angry)`

This strongly suggests modifiers such as `slightly`, `very`, and `extremely` are valid patterns for S1.

## S1 / S1-mini: Fine-Grained and Experimental Controls

These appear in the official Fine-grained Control page. Fish labels several of them as experimental / developing.

### Pause Words

`um`, `uh`, `嗯`, `啊`

### Experimental Special Effects

`(break)`, `(long-break)`, `(breath)`, `(laugh)`, `(cough)`, `(lip-smacking)`, `(sigh)`

Notes from Fish:

- `(laugh)`, `(cough)`, `(lip-smacking)`, and `(sigh)` are described as still developing.
- Fish says you may need to repeat those tags multiple times for better results.

## S1 / S1-mini: Official But Inconsistent / Example-Only Tags

Fish's docs currently contain tags in official examples and self-hosting pages that do not fully match the main Emotion Control table. Treat these as "test before production lock-in."

### Extra Tags Listed on the Official Self-Hosting Inference Page

`(interested)`, `(joyful)`, `(impatient)`, `(scornful)`, `(panicked)`, `(furious)`, `(reluctant)`, `(keen)`, `(disapproving)`, `(negative)`, `(denying)`, `(astonished)`, `(serious)`, `(conciliative)`, `(comforting)`, `(sincere)`, `(sneering)`, `(hesitating)`, `(yielding)`, `(painful)`, `(awkward)`, `(amused)`

### Tags Used in Official Best-Practice / Example Prompts

`(friendly)`, `(helpful)`, `(concerned)`, `(encouraging)`, `(narrator)`, `(mysterious)`, `(relieved)`, `(enthusiastic)`, `(urgent)`, `(professional)`, `(welcoming)`, `(clear)`, `(patient)`, `(thoughtful)`, `(impressed)`, `(celebrating)`, `(triumphant)`, `(joyful)`, `(brave)`, `(struggling)`

These are useful candidates for local testing because they appear in Fish's own examples, but they are not part of the clean canonical S1 tag table.

## S1 / S1-mini: Usage Rules

- Put emotion tags at the beginning of the sentence.
- Tone markers and sound effects can appear later in the sentence.
- Fish recommends one primary emotion per sentence.
- Fish recommends at most 3 combined emotions per sentence.
- Add matching text after sound effects when useful, for example `Ha ha` after `(laughing)`.

### Examples

- `(sad)(whispering) I miss you so much.`
- `(angry)(shouting) Get out of here now!`
- `(excited)(laughing) We won! Ha ha!`
- `(happy) I got the promotion!`
- `(uncertain) But... it means relocating.`
- `(sad) I'll miss everyone here.`
- `(hopeful) Though it's a great opportunity.`
- `(determined) I'm going to make it work!`

## S1 / S1-mini: Language Support Caveat

Fish's docs currently disagree here:

- The main Emotion Control page says emotion markers work across 13 languages.
- The official self-hosting / running-inference page says local emotion control is currently supported for English, Chinese, and Japanese, with more languages coming soon.

Practical takeaway: for local `S1-mini`, treat English / Chinese / Japanese as the safest supported emotion-control set until proven otherwise on your exact runtime.

## S2: Free-Form Inline Control

Use `[brackets]`.

Important: S2 does not use a fixed official vocabulary. Fish explicitly says S2 accepts free-form natural-language inline descriptions, and the official model card says it supports `15,000+ unique tags`.

### Official S2 Examples

`[laugh]`, `[whispers]`, `[super happy]`, `[whisper in small voice]`, `[professional broadcast tone]`, `[pitch up]`

### Official S2 Starter Tags From the Model Card

These are exact examples from Fish's official `s2-pro` model card.

#### Rhythm / Control

`[pause]`, `[short pause]`, `[emphasis]`, `[interrupting]`

#### Human Sounds / Breath / Reactions

`[laughing]`, `[laughing tone]`, `[chuckle]`, `[chuckling]`, `[inhale]`, `[exhale]`, `[sigh]`, `[panting]`, `[tsk]`, `[clearing throat]`, `[moaning]`

#### Emotion / Affect

`[excited]`, `[excited tone]`, `[angry]`, `[sad]`, `[surprised]`, `[shocked]`, `[delight]`

#### Loudness / Voice Placement

`[volume up]`, `[volume down]`, `[low volume]`, `[low voice]`, `[whisper]`, `[loud]`, `[shouting]`, `[screaming]`

#### Style / Rendering

`[singing]`, `[echo]`, `[with strong accent]`, `[audience laughter]`

## S2: Practical Prompt Patterns

This section is an inference from Fish's official S2 statement that the model accepts free-form natural-language descriptions, plus the official examples above.

### Delivery Style

- `[professional broadcast tone]`
- `[calm and deliberate]`
- `[quiet and intimate]`
- `[urgent but controlled]`
- `[soft and reassuring]`

### Emotion Strength

- `[happy]`
- `[super happy]`
- `[slightly sad]`
- `[deeply worried]`
- `[angry but restrained]`

### Prosody / Emphasis

- `[pitch up]`
- `[pitch down]`
- `[slow down]`
- `[speed up]`
- `[strong emphasis]`

### Breath / Pause / Realism

- `[pause]`
- `[short pause]`
- `[inhale]`
- `[exhale]`
- `[sigh]`

### Human Reactions

- `[laugh]`
- `[laughing]`
- `[chuckle]`
- `[panting]`
- `[clearing throat]`

The phrases above are not a closed "supported tags" list. They are examples of the kind of natural-language inline guidance Fish says S2 is trained to follow.

## S2: Example Strings Worth Testing

- `I can help with that [short pause] but first let me check one thing.`
- `That was actually funny [laughing] I did not expect that.`
- `Please stay quiet [whisper in small voice] someone is coming.`
- `Welcome back [professional broadcast tone] tonight's headline is unusual.`
- `We did it [super happy] this finally works.`
- `No, wait [pitch up] that changes everything.`

## Integration Notes Confirmed For Later Bot Work

- Self-hosted `S1-mini` voice cloning expects both the reference audio and its transcript.
- The official local inference flow uses `--prompt-text` together with `--prompt-tokens`.
- The HTTP API example likewise sends both `reference_audio` and `reference_text`.
- The official reference library layout uses `sample.wav` plus `sample.lab`.
- Fish recommends clear single-speaker reference audio and says `10-30 seconds` is a good range for better quality.
- Fish explicitly documents batch processing to amortize model-loading overhead.
- Fish documents a `--compile` acceleration path, but also notes Triton-based compilation is not supported on Windows/macOS.

## Sources

- Fish Audio Emotion Control: https://docs.fish.audio/developer-guide/core-features/emotions
- Fish Audio Fine-grained Control: https://docs.fish.audio/developer-guide/core-features/fine-grained-control
- Fish Audio Voice Cloning Best Practices: https://docs.fish.audio/developer-guide/best-practices/voice-cloning
- Fish Audio Self-Hosting / Running Inference: https://docs.fish.audio/developer-guide/self-hosting/running-inference
- Fish Audio S2 launch post: https://fish.audio/blog/fish-audio-open-sources-s2/
- Fish Audio official `s2-pro` model card: https://huggingface.co/fishaudio/s2-pro
