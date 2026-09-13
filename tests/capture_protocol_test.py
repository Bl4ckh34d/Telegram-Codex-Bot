import base64
import importlib.util
import json
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('capture_backend', Path(__file__).resolve().parents[1] / 'tools/linux_trusted_capture_backend.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)

class CaptureProtocolTest(unittest.TestCase):
    def exchange(self, request, capture):
        server, client = socket.socketpair()
        try:
            client.sendall(json.dumps(request).encode() + b'\n')
            with patch.object(backend, 'peer_credentials', return_value=(1, 123, 456)), patch.object(backend, 'ALLOWED_UID', 123), patch.object(backend, 'ALLOWED_GID', 456), patch.object(backend, 'capture_framebuffer', side_effect=capture):
                backend.handle_client(server)
            return json.loads(client.recv(65536))
        finally:
            client.close()
            server.close()

    def test_server_uses_private_output_and_returns_bytes(self):
        image = b'\x89PNG\r\n\x1a\nfake-test-data'
        def capture(target):
            self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
            target.write_bytes(image)
            return {'method': 'synthetic', 'relaxed': False}
        result = self.exchange({'format': 'png-base64', 'output': '/untrusted/path'}, capture)
        self.assertTrue(result['ok'])
        self.assertEqual(base64.b64decode(result['image_base64']), image)
        self.assertNotIn('path', result)

    def test_old_path_protocol_rejected_before_capture(self):
        def capture(_):
            self.fail('must not capture')
        result = self.exchange({'output': '/untrusted/path'}, capture)
        self.assertFalse(result['ok'])
        self.assertIn('png-base64', result['error'])

if __name__ == '__main__':
    unittest.main()
