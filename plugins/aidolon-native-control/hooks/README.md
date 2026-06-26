AIDOLON hook policy lives in Codex configuration, not in bot-side routing.

This plugin keeps a hooks folder so local hook scripts can be added without changing the Telegram transport. The bot also supports `codex exec --output-schema` through `schemas/aidolon-telegram-final.schema.json`, which is the default final-response guard for normal Telegram replies.
