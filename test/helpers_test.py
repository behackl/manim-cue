import builtins
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from fractions import Fraction
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "python" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


discover = load("discover").discover
support = load("support")
verify = support.verify


class DiscoveryTests(unittest.TestCase):
    def test_aliases_multiline_and_local_inheritance_without_execution(self):
        source = '''from manim import Scene as Base
import manim as m
raise RuntimeError("MUST NOT EXECUTE")
class One(
    Base,
): pass
class Two(One): pass
class Three(m.ThreeDScene): pass
class NotAScene: pass
'''
        self.assertEqual(discover(source), [{"name": "One", "line": 4}, {"name": "Two", "line": 7}, {"name": "Three", "line": 8}])

    def test_unresolved_bases_are_not_guessed(self):
        self.assertEqual(discover("from elsewhere import Custom\nclass Demo(Custom): pass"), [])
        self.assertEqual(discover("from manim import *\nclass Demo(Scene): pass"), [{"name": "Demo", "line": 2}])
        with self.assertRaises(SyntaxError):
            discover("class (")


class VerificationTests(unittest.TestCase):
    def test_fixture_revision_and_corruption(self):
        fixture = ROOT / "test/fixtures/timeline-v1.json"
        self.assertEqual(verify(fixture)["revision"], json.loads(fixture.read_text())["revision"])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "report.json"
            data = json.loads(fixture.read_text())
            data["end"] += 1
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "revision"):
                verify(path)

    def test_python_float_spelling_is_part_of_the_canonical_digest(self):
        self.assertNotEqual(hashlib.sha256(b'{"rate":4.0}').hexdigest(), hashlib.sha256(b'{"rate":4}').hexdigest())


class ProbeTests(unittest.TestCase):
    def probe_frames(self, pts, collect_times=True):
        stream = SimpleNamespace(guessed_rate=30, base_rate=30, average_rate=30.001244,
                                 duration=3000, time_base=Fraction(1, 30000),
                                 width=64, height=64, codec_context=SimpleNamespace(name="h264", format=SimpleNamespace(name="yuv420p")))
        class Container:
            format = SimpleNamespace(name="mov,mp4,m4a,3gp,3g2,mj2")
            streams = SimpleNamespace(video=[stream], audio=[])
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def decode(self, stream):
                return (SimpleNamespace(pts=p, time_base=Fraction(1, 30000)) for p in pts)
        with patch.dict("sys.modules", {"av": SimpleNamespace(open=lambda _: Container())}):
            return support.probe("unused.mp4", collect_times=collect_times)

    def test_nominal_cadence_is_separate_from_average_rate(self):
        result = self.probe_frames([0, 1000, 1980])
        self.assertEqual(result["rate"], 30)
        self.assertEqual(result["averageRate"], 30.001244)
        self.assertEqual(result["frames"], 3)
        self.assertEqual(result["frameTimes"], [0, 1000 / 30000, 1980 / 30000])
        self.assertAlmostEqual(result["maxFrameTimeError"], 20 / 30000)

    def test_export_checks_frames_without_collecting_a_pts_table(self):
        result = self.probe_frames([0, 1000, 2000], collect_times=False)
        self.assertEqual(result["frames"], 3)
        self.assertIsNone(result["frameTimes"])
        self.assertEqual(result["codec"], "h264")
        self.assertEqual(result["pixelFormat"], "yuv420p")
        with self.assertRaises(ValueError):
            self.probe_frames([0, 0], collect_times=False)

    def test_full_frame_sequence_measures_interior_drift(self):
        result = self.probe_frames([0, 1800, 2000])
        self.assertAlmostEqual(result["maxFrameTimeError"], 800 / 30000)

    def test_missing_or_repeated_timestamps_are_rejected(self):
        for pts in ([0, None], [0, 0]):
            with self.assertRaises(ValueError):
                self.probe_frames(pts)


class DiagnosticTests(unittest.TestCase):
    def test_supported_api_reports_module_and_actual_runtime(self):
        module = SimpleNamespace(__file__="/environment/manim/__init__.py", __version__="test",
                                 Manager=SimpleNamespace(evaluate=lambda self, capture_timeline=False: None,
                                                         capture_frame_at=lambda self, timestamp: None),
                                 config=SimpleNamespace(video_codec="libx264", pixel_format="yuv420p", video_encoder_options={}))
        with patch.dict("sys.modules", {"manim": module}):
            result = support.diagnose()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["python"], support.sys.executable)
        self.assertEqual(result["prefix"], support.sys.prefix)
        self.assertEqual(result["manim_module"], module.__file__)
        self.assertTrue(result["capture_frame"])
        self.assertTrue(result["timeline"])
        self.assertTrue(result["video_encoder"])
        self.assertIsNone(result["error"])

    def test_capabilities_not_version_determine_ready_limited_or_unsupported(self):
        for timeline in (False, True):
            for frame in (False, True):
                for encoder in (False, True):
                    with self.subTest(timeline=timeline, frame=frame, encoder=encoder):
                        manager = SimpleNamespace(evaluate=(lambda self, capture_timeline=False: None) if timeline else (lambda self: None))
                        if frame:
                            manager.capture_frame_at = lambda timestamp: None
                        config = SimpleNamespace(video_codec="libx264", pixel_format="yuv420p")
                        if encoder:
                            config.video_encoder_options = {}
                        module = SimpleNamespace(__version__="0.21.0", Manager=manager, config=config)
                        with patch.dict("sys.modules", {"manim": module}):
                            result = support.diagnose()
                        expected = "ready" if timeline and frame and encoder else "limited" if timeline or frame or encoder else "unsupported-manim"
                        self.assertEqual(result["status"], expected)
                        self.assertEqual((result["timeline"], result["capture_frame"], result["video_encoder"]), (timeline, frame, encoder))
                        if expected != "ready":
                            self.assertIn("version alone", result["error"])

    def test_unsupported_build_writes_actionable_diagnostic_before_scene_loading(self):
        with tempfile.TemporaryDirectory() as tmp:
            module = SimpleNamespace(__version__="0.21.0")
            with patch.dict("sys.modules", {"manim": module}):
                with self.assertRaisesRegex(RuntimeError, "Check Python Environment"):
                    support.prepare({"run": tmp})
            result = json.loads((Path(tmp) / "diagnostic.json").read_text())
            self.assertEqual(result["status"], "unsupported-manim")
            self.assertIn("capture_timeline", result["error"])
            self.assertFalse((Path(tmp) / "profile.json").exists())

    def test_encoder_only_build_can_prepare_an_independent_export(self):
        config = SimpleNamespace(video_codec="libx264", pixel_format="yuv420p", video_encoder_options={},
                                 pixel_width=640, pixel_height=360, frame_width=8, frame_height=4.5,
                                 seed=0, get_dir=lambda *args, **kwargs: None)
        module = SimpleNamespace(__version__="0.21.0", __file__=__file__, config=config)
        with tempfile.TemporaryDirectory() as tmp, patch.dict("sys.modules", {"manim": module}):
            profile = support.prepare({"run": tmp, "source": str(Path(tmp) / "scene.py"), "scene": "Demo",
                                       "width": 320, "fps": 4,
                                       "export": {"width": 320, "height": 180, "fps": 4, "crf": 18,
                                                  "preset": "medium", "encoderOptions": {}}})
            self.assertFalse(profile["timeline"])
            self.assertFalse(profile["captureFrame"])
            self.assertTrue(profile["videoEncoder"])
            self.assertTrue((Path(tmp) / "cue.cfg").is_file())

    def test_missing_operation_capability_fails_before_profile_or_scene_work(self):
        for exporting in (False, True):
            with self.subTest(exporting=exporting), tempfile.TemporaryDirectory() as tmp:
                # Encoder-only cannot preview; timeline/frame-only cannot encode an export.
                module = SimpleNamespace(config=SimpleNamespace(video_codec="libx264", pixel_format="yuv420p"))
                if exporting:
                    module.Manager = SimpleNamespace(capture_frame_at=lambda timestamp: None)
                else:
                    module.config.video_encoder_options = {}
                request = {"run": tmp, "export": {"width": 320} if exporting else None}
                with patch.dict("sys.modules", {"manim": module}):
                    with self.assertRaisesRegex(RuntimeError, "Check Python Environment"):
                        support.prepare(request)
                self.assertEqual(json.loads((Path(tmp) / "diagnostic.json").read_text())["status"], "limited")
                self.assertFalse((Path(tmp) / "cue.cfg").exists())

    def test_old_or_shadowing_module_is_not_reported_as_missing_manim(self):
        with patch.dict("sys.modules", {"manim": SimpleNamespace(__file__="/project/manim.py")}):
            result = support.diagnose()
        self.assertEqual(result["status"], "unsupported-manim")
        self.assertEqual(result["manim_module"], "/project/manim.py")
        self.assertIn("capture_timeline", result["error"])

    def test_missing_manim_and_missing_dependency_are_distinguished(self):
        original_import = builtins.__import__
        for missing, expected in (("manim", "missing-manim"), ("av", "import-error")):
            def importing(name, *args, **kwargs):
                if name == "manim":
                    raise ModuleNotFoundError(f"No module named '{missing}'", name=missing)
                return original_import(name, *args, **kwargs)
            with patch("builtins.__import__", side_effect=importing):
                result = support.diagnose()
                self.assertEqual(result["status"], expected)
                with self.assertRaisesRegex(RuntimeError, "Python:.*") as failure:
                    support.prepare({})
            self.assertIn(support.sys.executable, str(failure.exception))
            self.assertIn("Check Python Environment", str(failure.exception))


if __name__ == "__main__":
    unittest.main()
