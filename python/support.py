"""Environment check, scene inspection and video render through public Manim APIs."""
import configparser
import hashlib
from inspect import signature
import json
import os
from pathlib import Path
import runpy
import sys


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=True, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


class CueError(Exception):
    """An error with a message for the user, printed without a traceback."""


def check_source(request):
    if digest(request["source"]) != request["sourceHash"]:
        raise CueError("The scene file changed during the update. Save it again to update.")


def parameters(function):
    try:
        return signature(function).parameters
    except (TypeError, ValueError):
        return {}


def diagnose():
    report = {
        "python": sys.executable, "python_version": sys.version.split()[0],
        "prefix": sys.prefix, "base_prefix": sys.base_prefix, "cwd": str(Path.cwd()),
        "manim_module": None, "manim_version": None, "status": "import-error", "error": None,
        "capture_frame": False, "timeline": False, "video_encoder": False,
    }
    try:
        import manim
    except Exception as error:
        report["status"] = "missing-manim" if isinstance(error, ModuleNotFoundError) and error.name == "manim" else "import-error"
        report["error"] = f"{type(error).__name__}: {error}"
        return report
    report["manim_module"] = getattr(manim, "__file__", None)
    report["manim_version"] = getattr(manim, "__version__", None)
    manager = getattr(manim, "Manager", None)
    evaluate = parameters(getattr(manager, "evaluate", None))
    render = parameters(getattr(manager, "render", None))
    report["capture_frame"] = hasattr(manim, "RenderedFrame") and "frame_times" in evaluate and "on_frame" in evaluate
    report["timeline"] = "capture_timeline" in evaluate and "capture_timeline" in render
    report["video_encoder"] = all(hasattr(getattr(manim, "config", None), key)
                                  for key in ("video_codec", "pixel_format", "video_encoder_options"))
    features = [report[key] for key in ("timeline", "capture_frame", "video_encoder")]
    report["status"] = "ready" if all(features) else "limited" if any(features) else "unsupported-manim"
    missing = []
    if not report["capture_frame"]:
        missing.append("frames (manim.RenderedFrame, Manager.evaluate with frame_times and on_frame)")
    if not report["timeline"]:
        missing.append("timelines (Manager.evaluate and Manager.render with capture_timeline)")
    if not report["video_encoder"]:
        missing.append("video export (config.video_codec, pixel_format and video_encoder_options)")
    if missing:
        report["error"] = "Missing features: " + "; ".join(missing) + "."
    return report


def prepare(request):
    """Write the Manim configuration of this run and return its profile."""
    report = diagnose()
    write_json(Path(request["run"]) / "diagnostic.json", report)
    export = request.get("export")
    usable = report["video_encoder"] if export else report["timeline"] and report["capture_frame"]
    if not usable:
        raise CueError(f"This Python environment is not ready for Manim Cue ({report['status']}).\n"
                       f"Python: {report['python']}\nManim: {report['manim_module'] or 'not installed'}\n{report['error']}")
    import manim
    from manim import config
    run = Path(request["run"])
    source = Path(request["source"])
    project = Path.cwd() / "manim.cfg"
    user = Path.home() / ("AppData/Roaming/Manim/manim.cfg" if os.name == "nt" else ".config/manim/manim.cfg")
    parser = configparser.ConfigParser()
    if project.is_file():
        parser.read(project, encoding="utf-8")
    if not parser.has_section("CLI"):
        parser.add_section("CLI")
    width = max(64, int(request["width"]) // 2 * 2)
    height = export["height"] if export else max(2, round(width * config.pixel_height / config.pixel_width / 2) * 2)
    if width * height > 32_000_000:
        raise CueError("The preview is larger than 32 megapixels. Reduce “Manim Cue: Preview Width”.")
    assets = config.get_dir("assets_dir", module_name=source.stem, scene_name=request["scene"])
    seed = config.seed if config.seed is not None else 0
    overrides = {
        "input_file": source, "output_file": run / "media" / "preview.mp4",
        "format": "mp4", "renderer": "cairo", "frame_rate": request["fps"],
        "pixel_width": width, "pixel_height": height,
        "frame_width": config.frame_width, "frame_height": config.frame_height,
        "seed": seed, "background_opacity": 1,
        "preview": False, "live_preview": False, "show_in_file_browser": False,
        "enable_gui": False, "fullscreen": False, "dry_run": False,
        "write_all": False, "save_sections": False, "log_to_file": False,
        "notify_outdated_version": False, "disable_caching": True,
        "from_animation_number": 0, "upto_animation_number": -1,
        "progress_bar": "none", "assets_dir": (assets or Path.cwd()).absolute(),
    }
    if export:
        overrides["frame_height"] = config.frame_width * height / width
    configs = {str(p): digest(p) if p.is_file() else None for p in (project, user)}
    # Reuse Manim's own content-addressed typesetting cache, not animation/media
    # caches. Configuration and Python/package environment changes get new roots.
    from importlib.metadata import PackageNotFoundError, version
    versions = {}
    for package in ("manim", "manimpango", "typst", "pycairo"):
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = None
    identity = json.dumps([configs, versions, str(Path(manim.__file__).resolve()), manim.__version__,
                           request["fps"], width, height, config.frame_width, config.frame_height, seed], sort_keys=True)
    assets_cache = Path(request["cache"]) / hashlib.sha256(identity.encode()).hexdigest()
    for key in ("media_dir", "video_dir", "images_dir", "sections_dir", "partial_movie_dir", "tex_dir", "text_dir", "log_dir"):
        overrides[key] = (assets_cache if key in ("tex_dir", "text_dir") else run / "work") / key
    for key, value in overrides.items():
        parser.set("CLI", key, str(value).replace("%", "%%"))
    # Reset codec-specific user options instead of applying (say) VP9 options to H.264.
    for section in ("video_encoder", "video_encoder.options"):
        if parser.has_section(section):
            parser.remove_section(section)
        parser.add_section(section)
    parser.set("video_encoder", "codec", "libx264")
    parser.set("video_encoder", "pixel_format", "yuv420p")
    options = {"crf": str(export["crf"]), "preset": export["preset"], **export["encoderOptions"]} if export else {"crf": "28", "preset": "veryfast"}
    for key, value in options.items():
        parser.set("video_encoder.options", key, value.replace("%", "%%"))
    with (run / "cue.cfg").open("w", encoding="utf-8") as stream:
        parser.write(stream)
    write_json(run / "profile.json", {
        "version": manim.__version__, "module": str(Path(manim.__file__).resolve()),
        "fps": request["fps"], "width": width, "height": height, "seed": seed,
        "frameWidth": config.frame_width, "frameHeight": config.frame_width * height / width,
        "configs": configs, "videoEncoder": report["video_encoder"],
    })


class FrameReady(BaseException):
    """Ends an evaluation that only needs its frame. Scene code rarely catches a BaseException."""


def inspect_scene(request):
    """Evaluate the scene once: write the frame at request["time"] and the timeline, if requested.

    The frame is announced with one ``[Cue frame] {json}`` line on stdout as soon as it is written.
    """
    prepare(request)
    from manim import Manager, config
    from manim.utils.module_ops import scene_classes_from_file
    check_source(request)
    config.digest_file(Path(request["run"]) / "cue.cfg")
    sys.path.insert(0, os.getcwd())
    matches = [cls for cls in scene_classes_from_file(Path(request["source"]), full_list=True) if cls.__name__ == request["scene"]]
    if len(matches) != 1:
        raise CueError(f"The file has no scene class named {request['scene']}.")
    scene = matches[0]()
    manager = scene.manager or Manager(scene)
    time, timeline = request.get("time"), request.get("timeline")
    sent = False

    def publish(image, frame=None):
        nonlocal sent
        check_source(request)
        image.save(request["frame"])
        print("[Cue frame] " + json.dumps({
            "requestedTime": time, "time": None if frame is None else frame.time,
            "frameIndex": None if frame is None else frame.frame_index}), flush=True)
        sent = True

    def on_frame(frame):
        publish(frame.image, frame)
        if not timeline:
            raise FrameReady

    with manager:
        try:
            manager.evaluate(capture_timeline=bool(timeline), frame_times=() if time is None else (time,),
                             on_frame=None if time is None else on_frame)
        except FrameReady:
            return
        if time is not None and not sent:
            publish(scene.get_image())  # The time is at or after the end: show the final state.
    if timeline:
        check_source(request)
        manager.timeline.write(timeline)


def render_scene(request):
    """Render the video with Manim's CLI and, if requested, the timeline of the same run."""
    prepare(request)
    check_source(request)
    sys.path.insert(0, os.getcwd())
    timeline = ["--timeline-output", request["timeline"]] if request.get("timeline") else []
    sys.argv = ["manim", "--config_file", str(Path(request["run"]) / "cue.cfg"), "--silent", "--progress_bar", "none",
                "-o", request["output"], *timeline, request["source"], request["scene"]]
    try:
        runpy.run_module("manim", run_name="__main__", alter_sys=True)
    except SystemExit as exit:
        if exit.code:
            raise
    check_source(request)


if __name__ == "__main__":
    command, argument = sys.argv[1:]
    if command == "diagnose":
        write_json(argument, diagnose())
    else:
        request = json.loads(Path(argument).read_text(encoding="utf-8"))
        try:
            {"inspect": inspect_scene, "render": render_scene}[command](request)
        except CueError as error:
            print(error, file=sys.stderr)
            sys.exit(1)
