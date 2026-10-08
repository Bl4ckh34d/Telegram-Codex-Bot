import os
import json
import subprocess
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tts_runtime import create_tts


class TtsRuntimeTests(unittest.TestCase):
    def test_chinese_synthesis_normalizes_script_without_translating_taiwanese_vocabulary(self):
        from tts_runtime import normalize_chinese_tts
        text = '兩個語音模型都已經準備好了，切換語言不需要重新載入。'
        self.assertEqual(normalize_chinese_tts(text), '两个语音模型都已经准备好了，切换语言不需要重新载入。')
        self.assertEqual(normalize_chinese_tts('記憶體'), '记忆体')
        self.assertEqual(normalize_chinese_tts('Grüße, the file is ready.'), 'Grüße, the file is ready.')
        with patch.dict(os.environ, {'TTS_CHINESE_SIMPLIFY':'0'}):
            self.assertEqual(normalize_chinese_tts(text), text)

    def test_lazy_pool_unloads_all_models_and_factory_before_reloading(self):
        import aidolon_tts_server as server
        from types import SimpleNamespace
        events = []
        def load(state):
            events.append(('load', state['model']))
            state['tts'] = SimpleNamespace(pipe=SimpleNamespace(close=lambda: events.append(('close', state['model']))))
        pool = server.ModelPool(['de', 'base'], Path('ref.wav'), lambda: object())
        self.assertEqual(pool.states, {})
        with patch.object(server, '_reload_tts_runtime', load), patch.object(server, '_release_cuda_cache') as release:
            first = pool.get('de')
            self.assertIs(first, pool.get('de'))
            pool.get('base')
            factory = pool.factory
            pool.unload()
            self.assertEqual(pool.states, {})
            self.assertIsNone(pool.factory)
            release.assert_called_once()
            pool.get('de')
            self.assertIsNot(pool.factory, factory)
            with self.assertRaisesRegex(ValueError, 'not loaded'):
                pool.get('unconfigured')
        self.assertEqual(events, [('load','de'),('load','base'),('close','de'),('close','base'),('load','de')])

    def test_resident_models_prewarm_and_switch_without_reloading(self):
        script = r'''
import sys, types, json
import aidolon_tts_server as server
sys.modules['mira'] = types.ModuleType('mira')
model = types.ModuleType('mira.model')
model.MiraTTS = object
sys.modules['mira.model'] = model
loads = []
def load(state):
    loads.append(state['model'])
server._reload_tts_runtime = load
server._resident_factory = lambda factory: factory
server._handle_synthesize = lambda rid, payload, **kw: server._emit({'id':rid,'model':kw['state']['model'],'loads':loads[:]})
sys.argv = ['worker', '--model', 'german', '--resident-model', 'base', '--reference-audio', server.__file__]
server.main()
'''
        requests = [
            {"id": "1", "type": "synthesize", "model": "german", "text": "Hallo"},
            {"id": "2", "type": "synthesize", "model": "base", "text": "Hello"},
            {"id": "3", "type": "synthesize", "model": "german", "text": "Noch einmal"},
            {"id": "4", "type": "synthesize", "model": "unknown", "text": "invalid"},
        ]
        result = subprocess.run([sys.executable, "-c", script],
            input="".join(json.dumps(p) + "\n" for p in requests).encode(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        rows = [json.loads(line) for line in result.stdout.decode().splitlines() if json.loads(line).get('type') != 'loaded']
        self.assertEqual(rows[0]["models"], ["german", "base"])
        self.assertEqual([row["model"] for row in rows[1:4]], ["german", "base", "german"])
        self.assertTrue(all(row["loads"] == ["german", "base"] for row in rows[1:4]))
        self.assertFalse(rows[4]["ok"])
        self.assertIn("not loaded", rows[4]["error"])

    def test_resident_factory_shares_codec_but_not_language_pipelines(self):
        from tts_runtime import resident_mira_factory
        from types import SimpleNamespace
        class Mira:
            def __init__(self, model, **options):
                self.codec = object()
                self.pipe = {"model": model}
                self.gen_config = {"temperature": 0.8}
        factory = resident_mira_factory(Mira,
            lambda model, **kw: {"model": model, **kw}, SimpleNamespace)
        first = factory("de", cache_max_entry_count=0.05, enable_prefix_caching=False)
        second = factory("en", cache_max_entry_count=0.05, enable_prefix_caching=False)
        self.assertIs(first.codec, second.codec)
        self.assertIsNot(first.pipe, second.pipe)
        self.assertEqual(second.pipe["model"], "en")
        self.assertEqual(second.pipe["backend_config"].dtype, "bfloat16")
        self.assertFalse(second.pipe["backend_config"].enable_prefix_caching)
        second.gen_config["temperature"] = 0.1
        self.assertEqual(first.gen_config["temperature"], 0.8)

    def test_recovery_releases_old_pipeline_before_allocating_replacement(self):
        import aidolon_tts_server as server
        from types import SimpleNamespace
        events = []
        old = SimpleNamespace(pipe=SimpleNamespace(close=lambda: events.append("close")))
        def factory(model, **options):
            events.append("load")
            return SimpleNamespace(encode_audio=lambda path: "new context")
        state = {"model": "de", "default_ref_path": Path("ref.wav"), "tts_factory": factory,
                 "tts": old, "ctx_cache": {"old": "old context"}}
        with patch("tts_runtime.prepare_cuda"):
            server._reload_tts_runtime(state)
        self.assertEqual(events, ["close", "load"])
        self.assertNotIn("old", state["ctx_cache"])

    def test_json_pipe_preserves_unicode_under_windows_legacy_encoding(self):
        script = r'''
import sys, types
import aidolon_tts_server as server
sys.modules['mira'] = types.ModuleType('mira')
model = types.ModuleType('mira.model')
model.MiraTTS = object
sys.modules['mira.model'] = model
server._reload_tts_runtime = lambda state: None
server._handle_synthesize = lambda rid, payload, **kw: server._emit({'text': payload['text'], 'codepoints': [ord(c) for c in payload['text']]})
sys.argv = ['worker', '--model', 'unused', '--reference-audio', server.__file__]
server.main()
'''
        text = "Grüße, Äpfel, Öl, süß — 中文"
        result = subprocess.run([sys.executable, "-c", script],
            input=(json.dumps({"id": "test", "type": "synthesize", "text": text}, ensure_ascii=False) + "\n").encode("utf-8"),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
            env={**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"})
        self.assertEqual(result.returncode, 0, result.stderr)
        reply = json.loads(result.stdout.decode("utf-8").splitlines()[-1])
        self.assertEqual(reply["codepoints"], [ord(c) for c in text])
        self.assertEqual(reply["text"], text)

    def test_invalid_cache_fraction_fails_before_allocating_gpu_memory(self):
        for value in ("0", "1", "-0.1", "nan", "inf", "invalid"):
            with self.subTest(value=value), patch.dict(os.environ, {"TTS_GPU_CACHE_FRACTION": value}), \
                 patch("tts_runtime.prepare_cuda") as prepare:
                with self.assertRaises(ValueError):
                    create_tts(lambda *a, **kw: self.fail("must not load model"), "model")
                prepare.assert_not_called()

    def test_cache_budget_is_applied_to_initial_load_and_recovery(self):
        import aidolon_tts_server as server
        import aidolon_tts_synthesize as single
        loads = []

        class Runtime:
            def __init__(self, model, **options):
                loads.append((model, options))

            def encode_audio(self, reference):
                return "cached reference"

        with patch.dict(os.environ, {"TTS_GPU_CACHE_FRACTION": "0.15"}), patch("tts_runtime.prepare_cuda"):
            state = {"model": "model", "default_ref_path": Path("reference.wav"), "tts_factory": Runtime}
            server._reload_tts_runtime(state)
            single._reload_tts_runtime("model", Path("reference.wav"), Runtime)
        self.assertEqual(loads, [("model", {"cache_max_entry_count": 0.15, "enable_prefix_caching": os.name != "nt"})] * 2)

    def test_windows_disables_prefix_cache_but_allows_explicit_override(self):
        with patch.dict(os.environ, {}, clear=True), patch("tts_runtime.prepare_cuda"), patch("tts_runtime.os.name", "nt"):
            options = create_tts(lambda model, **kw: kw, "model")
            self.assertFalse(options["enable_prefix_caching"])
            with patch.dict(os.environ, {"TTS_PREFIX_CACHING": "1"}):
                self.assertTrue(create_tts(lambda model, **kw: kw, "model")["enable_prefix_caching"])

    def test_invalid_prefix_cache_setting_fails_before_model_allocation(self):
        with patch.dict(os.environ, {"TTS_PREFIX_CACHING": "maybe"}), patch("tts_runtime.prepare_cuda") as prepare:
            with self.assertRaises(ValueError):
                create_tts(lambda *a, **kw: self.fail("must not load model"), "model")
            prepare.assert_not_called()


if __name__ == "__main__":
    unittest.main()
