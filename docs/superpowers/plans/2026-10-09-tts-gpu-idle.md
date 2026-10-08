# TTS GPU lifetime and attachment repair

The user authorizes implementation, restart, commit and push. Keep unrelated ambient-listener prototypes outside the commit.

1. Measure unloaded-model latency through the first WAV. Full process startup measured 14.3–15.4 seconds. Keeping imports warm and releasing model pipelines plus the shared codec measured 5.8–7.8 seconds, so use this strategy.
2. Load language models on demand. Unload after 60 seconds without voice input or synthesis activity. Never unload in the middle of synthesis. Provide persistent pause/resume controls for GPU-heavy tasks; paused voice inputs receive text.
3. Repair the Windows attachment file-identity check without removing traversal, replacement or size guards. Verify inbound Telegram files retain their caption and bytes in the selected App thread. The existing transport exposes local file references, not native attachment thumbnails.
4. Investigate Chinese synthesis separately from transcription errors; only change behavior with supporting evidence.
5. Run focused and full checks, review, restart via exit 75, verify live idle/pause/resume behavior, capture reusable knowledge, commit and push the related changes.
