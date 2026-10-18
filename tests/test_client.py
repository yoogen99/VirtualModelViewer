import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('vmv_client', Path(__file__).resolve().parents[1] / 'blender_addon/virtual_model_viewer/client.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class ClientTests(unittest.TestCase):
    def test_server_urls(self):
        self.assertEqual(client.base_url('https://viewer.example/'), 'https://viewer.example')
        self.assertEqual(client.base_url('http://127.0.0.1:8797'), 'http://127.0.0.1:8797')
        for url in ['http://viewer.example', 'file:///test', 'https://user:secret@viewer.example', 'https://viewer.example/api', 'https://viewer.example/?token=x']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                client.base_url(url)

    def test_does_not_follow_redirect_with_token(self):
        handler = client.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, '', {}, 'https://other.example'))

    def test_upload_limits_and_invalid_ids(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'model.glb'
            path.write_bytes(b'123')
            with self.assertRaises(ValueError):
                client.publish('https://viewer.example', 'short', str(path), 'test', {})
            with self.assertRaises(ValueError):
                client.publish('https://viewer.example', 'x' * 32, str(path), 'test', {}, '../bad')
            with patch.object(client, 'MAX_BYTES', 2):
                with self.assertRaises(ValueError):
                    client.publish('https://viewer.example', 'x' * 32, str(path), 'test', {})

    def test_qr_requires_png(self):
        with patch.object(client, '_send', return_value=b'not a png'):
            with self.assertRaises(ValueError):
                client.fetch_qr('https://viewer.example', 'a' * 48)


if __name__ == '__main__':
    unittest.main()
