---
tags:
- tts
- audio
language:
- en
- zh
pipeline_tag: text-to-speech
license: cc-by-nc-sa-4.0
---

## MiraTTS

This is the model for the [MiraTTS](https://github.com/ysharma3501/MiraTTS) repository.
MiraTTS is a high quality TTS model that can generate clear and realistic speech at speeds as fast as 100x realtime.

## Key benefits
- Incredibly fast: Over 100x realtime by using Lmdeploy and batching.
- High quality: Generates clear and crisp 48khz audio outputs which is much higher quality then most models.
- Memory efficient: Works within 6gb vram.
- Low latency: Latency can be low as 100ms.
- Voice cloning: Can voice clone any voice with good quality.

Random samples, non cherry picked:
<audio controls>
  <source src="https://huggingface.co/YatharthS/MiraTTS/resolve/main/example2.wav" type="audio/wav">
  Your browser does not support the audio element.
</audio>
<audio controls>
  <source src="https://huggingface.co/YatharthS/MiraTTS/resolve/main/example3.wav" type="audio/wav">
  Your browser does not support the audio element.
</audio>
<audio controls>
  <source src="https://huggingface.co/YatharthS/MiraTTS/resolve/main/example1.wav" type="audio/wav">
  Your browser does not support the audio element.
</audio>

Thanks to Gapeleon for creating a great space for this model, you can try it here: https://huggingface.co/spaces/Gapeleon/Mira-TTS

If you find this model/code helpful, please give a like or star. Thank you.

Please check out the [github repo](https://github.com/ysharma3501/MiraTTS) for usage and finetuning notebooks.