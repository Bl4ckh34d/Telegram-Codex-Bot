import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tts_runtime import create_tts


class TtsRuntimeTests(unittest.TestCase):
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
        self.assertEqual(loads, [("model", {"cache_max_entry_count": 0.15})] * 2)


if __name__ == "__main__":
    unittest.main()
