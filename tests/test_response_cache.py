import importlib.util
from pathlib import Path
import sys
import unittest


spec = importlib.util.spec_from_file_location(
    "jiafen_cache_test_app", Path(__file__).resolve().parents[1] / "application" / "app.py"
)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class ResponseCacheTests(unittest.TestCase):
    def setUp(self):
        self.client = module.app.test_client()

    def get(self, *args, **kwargs):
        response = self.client.get(*args, **kwargs)
        self.addCleanup(response.close)
        return response

    def test_html_has_short_private_cache(self):
        response = self.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"],
                         "private, max-age=300, stale-while-revalidate=86400")

    def test_force_reload_revalidates_html(self):
        response = self.get("/?shell_reload=123")
        self.assertEqual(response.headers["Cache-Control"], "private, no-cache")

    def test_versioned_scripts_and_styles_have_long_cache(self):
        for path in ["/app.js?v=test", "/style.css?v=test", "/archives.js?v=test"]:
            with self.subTest(path=path):
                response = self.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["Cache-Control"],
                                 "public, max-age=31536000, immutable")

    def test_unversioned_script_revalidates_without_downloading_unchanged_body(self):
        response = self.get("/app.js")
        self.assertEqual(response.headers["Cache-Control"], "no-cache")
        cached = self.get("/app.js", headers={"If-None-Match": response.headers["ETag"]})
        self.assertEqual(cached.status_code, 304)
        self.assertEqual(cached.data, b"")

    def test_authentication_and_errors_are_not_cached(self):
        for path in ["/api/me", "/api/events", "/missing.js?v=test"]:
            with self.subTest(path=path):
                response = self.get(path)
                self.assertEqual(response.headers["Cache-Control"], "no-store")


if __name__ == "__main__":
    unittest.main()
