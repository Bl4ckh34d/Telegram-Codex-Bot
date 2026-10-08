"""Exercise both speech entry points without downloading models or using a GPU."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import whisper_transcribe
import whisper_transcribe_server
import whisper_runtime


class WhisperRuntimeTests(unittest.TestCase):
    def test_cuda_worker_releases_temporary_cache_without_reloading_model(self):
        calls=[]
        # GPU allocations are external; model load and the server request loop
        # stay real. Cache release must happen after decoding, without unload.
        model=types.SimpleNamespace(device=types.SimpleNamespace(type="cuda"))
        model.transcribe=lambda *a, **kw: calls.append("decode") or {"text":"Hallo", "language":"de"}
        def load(*a, **kw):
            calls.append("load")
            return model
        torch=types.SimpleNamespace(cuda=types.SimpleNamespace(empty_cache=lambda: calls.append("release")))
        with tempfile.NamedTemporaryFile(suffix=".wav") as audio:
            rows=[{"id":str(i), "type":"transcribe", "audio_path":audio.name, "language":"de"} for i in range(2)]
            with patch.dict(sys.modules, {"whisper":types.SimpleNamespace(load_model=load), "torch":torch}), \
                 patch.dict(os.environ, {"WHISPER_DEVICE":"cuda", "WHISPER_FP16":"auto"}), \
                 patch.object(sys,"argv",["worker"]), \
                 patch.object(sys,"stdin",io.StringIO("\n".join(json.dumps(row) for row in rows))), \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(whisper_transcribe_server.main(),0)
        self.assertEqual(calls,["load","decode","release","decode","release"])

    def run_worker(self, server, device, fp16="auto", language="auto"):
        calls, loads = [], []
        model = types.SimpleNamespace(device=types.SimpleNamespace(type=device))

        def transcribe(audio, **options):
            calls.append(options)
            return {"text": "test transcript", "language": "fr"}

        model.transcribe = transcribe

        def load(name, **options):
            loads.append(options)
            return model

        with tempfile.NamedTemporaryFile(suffix=".wav") as audio:
            args = ["worker", "--model", "small"]
            if not server:
                args += ["--audio", audio.name, "--language", language]
            request = {"id": "probe", "type": "transcribe", "audio_path": audio.name,
                       "language": language}
            output = io.StringIO()
            with patch.dict(sys.modules, {"whisper": types.SimpleNamespace(load_model=load),
                                         "torch": types.SimpleNamespace(cuda=types.SimpleNamespace(empty_cache=lambda: None))}), \
                 patch.dict(os.environ, {"WHISPER_DEVICE": device, "WHISPER_FP16": fp16}), \
                 patch.object(sys, "argv", args), patch.object(sys, "stdin", io.StringIO(json.dumps(request))), \
                 contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                result = (whisper_transcribe_server if server else whisper_transcribe).main()
            self.assertEqual(result, 0)
            self.assertIn("test transcript", output.getvalue())
        return calls, loads

    def test_cuda_uses_fp16_in_both_workers_including_translation(self):
        for server in (False, True):
            with self.subTest(server=server):
                calls, loads = self.run_worker(server, "cuda")
                self.assertEqual(calls, [{"fp16": True}, {"fp16": True, "task": "translate"}])
                self.assertEqual(loads[0]["device"], "cuda")

    def test_cpu_uses_fp32_and_explicit_language_does_not_translate(self):
        for server in (False, True):
            calls, _ = self.run_worker(server, "cpu", language="de")
            self.assertEqual(calls, [{"fp16": False, "language": "de"}])

    def test_cuda_fp32_override_is_preserved(self):
        for server in (False, True):
            calls, _ = self.run_worker(server, "cuda", fp16="0", language="en")
            self.assertEqual(calls, [{"fp16": False, "language": "en"}])

    def test_turbo_translation_uses_one_cached_cpu_model_without_extra_vram(self):
        loads, calls = [], []
        translator = types.SimpleNamespace(transcribe=lambda audio, **kw: calls.append(kw) or {"text":"English"})
        module = types.ModuleType("whisper")
        module.load_model = lambda name, **kw: loads.append((name, kw)) or translator
        self.addCleanup(whisper_runtime._cpu_translator.cache_clear)
        for name in ("turbo", "large-v3-turbo"):
            result = whisper_runtime.translate_to_english(module, object(), "audio.wav", name, "cache", True)
            self.assertEqual(result["text"], "English")
        self.assertEqual(loads, [("small", {"device":"cpu", "download_root":"cache"})])
        self.assertEqual(calls, [{"fp16":False, "task":"translate"}] * 2)


if __name__ == "__main__":
    unittest.main()
