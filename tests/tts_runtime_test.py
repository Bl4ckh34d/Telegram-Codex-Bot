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
