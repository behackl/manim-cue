"""File-based capture, evaluation and verification using public Manim/PyAV APIs."""
import configparser
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import sys

LIMIT = 16 * 1024 * 1024


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=True, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def diagnose():
    report = {
        "python": sys.executable, "python_version": sys.version.split()[0],
        "prefix": sys.prefix, "base_prefix": sys.base_prefix, "cwd": str(Path.cwd()),
        "manim_module": None, "manim_version": None, "status": "import-error", "error": None,
    }
    try:
        import manim
    except Exception as error:
        report["status"] = "missing-manim" if isinstance(error, ModuleNotFoundError) and error.name == "manim" else "import-error"
        report["error"] = f"{type(error).__name__}: {error}"
        return report
    report["manim_module"] = getattr(manim, "__file__", None)
    report["manim_version"] = getattr(manim, "__version__", None)
    try:
        supported = "capture_timeline" in inspect.signature(manim.Manager.evaluate).parameters
    except (AttributeError, TypeError, ValueError):
        supported = False
    report["capture_frame"] = callable(getattr(getattr(manim, "Manager", None), "capture_frame_at", None))
    report["status"] = "ready" if supported or report["capture_frame"] else "unsupported-manim"
    report["timeline"] = supported
    if not supported:
        report["error"] = "This Manim build lacks Manager.evaluate(capture_timeline=True). Select a timeline-capable Manim build for timeline evaluation."
    return report


def prepare(request):
    report = diagnose()
    if report["status"] != "ready":
        raise RuntimeError(
            f"Manim Cue environment check: {report['status']}\n"
            f"Python: {report['python']}\nWorking directory: {report['cwd']}\n"
            f"Manim module: {report['manim_module'] or '(not imported)'}\n{report['error']}\n"
            "Run Manim Cue: Check Python Environment or Select Python for Manim Cue. "
            "The scene file's environment may differ from another editor's status-bar selection."
        )
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
    export = request.get("export")
    if export and not all(hasattr(config, key) for key in ("video_codec", "pixel_format", "video_encoder_options")):
        raise RuntimeError("New video exports require Manim's public video encoder profile support.")
    height = export["height"] if export else max(2, round(width * config.pixel_height / config.pixel_width / 2) * 2)
    if export and (width != export["width"] or request["fps"] != export["fps"] or
                   not isinstance(height, int) or height < 64 or height > 8192 or height % 2):
        raise ValueError("Invalid export dimensions or frame rate.")
    if width * height > 32_000_000:
        raise ValueError("Preview exceeds the 32 megapixel limit.")
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
    assets_cache = Path(request.get("cache", run / "cache")) / hashlib.sha256(identity.encode()).hexdigest()
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
    return {
        "version": manim.__version__, "module": str(Path(manim.__file__).resolve()),
        "fps": request["fps"], "width": width, "height": height, "seed": seed,
        "frameWidth": config.frame_width, "frameHeight": config.frame_width * height / width,
        "configs": configs, "captureFrame": report["capture_frame"], "timeline": report["timeline"],
    }


def prepared(request):
    profile_path = Path(request["run"]) / "profile.json"
    if profile_path.is_file():
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
    else:
        profile = prepare(request)
        write_json(profile_path, profile)
    for file, expected in profile["configs"].items():
        if (digest(file) if Path(file).is_file() else None) != expected:
            raise ValueError("Manim configuration changed during the run. Refresh.")
    return profile


def capture(request, destination):
    profile = prepared(request)
    if not profile["captureFrame"]:
        return {"kind": "unsupported"}
    from manim import Manager, config
    from manim.utils.module_ops import scene_classes_from_file
    run = Path(request["run"])
    source = Path(request["source"])
    expected = request["sourceHash"]
    if digest(source) != expected:
        raise ValueError("Primary source changed before capture. Save and refresh.")
    config.digest_file(run / "cue.cfg")
    candidates = scene_classes_from_file(source, full_list=True)
    matches = [cls for cls in candidates if cls.__name__ == request["scene"]]
    if len(matches) != 1:
        raise ValueError("Select exactly one Scene class defined in the source file.")
    if digest(source) != expected:
        raise ValueError("Primary source changed during loading.")
    scene = matches[0]()
    manager = scene.manager or Manager(scene)
    with manager:
        if manager.session_spec.frame_rate != profile["fps"] or type(scene.renderer).__name__ != "CairoRenderer":
            raise ValueError("Scene changed the requested capture profile.")
        frame = manager.capture_frame_at(request["time"])
        image = frame.image if frame is not None else scene.get_image()
        if image.size != (profile["width"], profile["height"]):
            raise ValueError("Captured image dimensions differ from the requested profile.")
        image.save(Path(destination).with_suffix(".png"))
        result = {"kind": "frame" if frame is not None else "snapshot",
                  "requestedTime": request["time"], "time": frame.time if frame else None,
                  "frameIndex": frame.frame_index if frame else None,
                  "width": image.width, "height": image.height}
    if digest(source) != expected:
        raise ValueError("Primary source changed during capture or cleanup.")
    prepared(request)  # Check configuration again before publishing the result.
    return result


def verify(path):
    path = Path(path)
    if path.stat().st_size > LIMIT:
        raise ValueError("Timeline exceeds the 16 MiB viewer limit.")
    def reject_constant(value):
        raise ValueError(f"Non-finite JSON value: {value}")
    data = json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant)
    if not isinstance(data, dict) or data.get("schema") != "manim.execution-timeline" or type(data.get("version")) is not int or data["version"] != 1 or data.get("complete") is not True:
        raise ValueError("Unsupported or incomplete timeline.")
    revision = data.pop("revision", None)
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    if revision != hashlib.sha256(canonical.encode("utf-8")).hexdigest():
        raise ValueError("Timeline content revision does not match its document.")
    return {"revision": revision, "source": data.get("source")}


def probe(path, collect_times=True):
    import av
    with av.open(path) as container:
        if not collect_times and "mp4" not in container.format.name.split(","):
            raise ValueError("Export is not an MP4 container.")
        if not container.streams.video:
            raise ValueError("Preview has no video stream.")
        stream = container.streams.video[0]
        # Average rate is frames / container duration, not necessarily the encoder
        # cadence: sub-millisecond segment/mux timing can make 30 fps report 30.001.
        rate = float(stream.guessed_rate or stream.base_rate or stream.average_rate or 0)
        average_rate = float(stream.average_rate or 0)
        duration = float(stream.duration * stream.time_base) if stream.duration is not None else 0
        if not math.isfinite(duration) or duration <= 0 or not math.isfinite(rate) or rate <= 0:
            raise ValueError("Preview has no playable video time axis.")
        if stream.codec_context.name != "h264":
            raise ValueError("Preview is not the expected H.264 video.")
        # Decode in presentation order (packet order can differ for B-frames).
        # Retain only the worst offset; this checks the WHOLE video with bounded
        # memory, without assigning any frame to an event or changing timestamps.
        frames = 0
        max_error = 0.0
        previous = None
        frame_times = [] if collect_times else None
        for frame in container.decode(stream):
            if frame.pts is None or frame.time_base is None:
                raise ValueError("Preview has a frame without a presentation timestamp.")
            timestamp = float(frame.pts * frame.time_base)
            if not math.isfinite(timestamp) or (previous is not None and timestamp <= previous):
                raise ValueError("Preview has invalid or non-increasing presentation timestamps.")
            max_error = max(max_error, abs(timestamp - frames / rate))
            previous = timestamp
            if frame_times is not None:
                if len(frame_times) < 500_000:
                    frame_times.append(timestamp)
                else:
                    frame_times = None
            frames += 1
        if not frames:
            raise ValueError("Preview has no decoded video frames.")
        return {"duration": duration, "rate": rate, "averageRate": average_rate,
                "frames": frames, "maxFrameTimeError": max_error,
                "width": stream.width, "height": stream.height,
                "hasAudio": bool(container.streams.audio), "frameTimes": frame_times,
                "codec": stream.codec_context.name, "pixelFormat": stream.codec_context.format.name}


if __name__ == "__main__":
    command, source, destination = sys.argv[1:]
    if command == "evaluate":
        import runpy
        request = json.loads(Path(source).read_text(encoding="utf-8"))
        profile = prepared(request)
        if not profile["timeline"]:
            raise RuntimeError("This Manim build lacks timeline capture. Select a timeline-capable build.")
        print("[Cue phase] Evaluating scene", flush=True)
        # Public CLI, same import-time CWD/config as a normal invocation. No custom
        # Scene runner, persistent interpreter or private recorder hooks.
        sys.path.insert(0, os.getcwd())
        sys.argv = ["manim", "--config_file", str(Path(request["run"]) / "cue.cfg"),
                    "--silent", "--progress_bar", "none", "--timeline-output", destination,
                    request["source"], request["scene"]]
        runpy.run_module("manim", run_name="__main__", alter_sys=True)
        sys.exit(0)
    elif command == "capture":
        result = capture(json.loads(Path(source).read_text(encoding="utf-8")), destination)
    elif command == "prepare":
        result = prepared(json.loads(Path(source).read_text(encoding="utf-8")))
    elif command == "verify":
        result = verify(source)
    elif command in ("probe", "probe-export"):
        result = probe(source, collect_times=command == "probe")
    elif command == "diagnose":
        result = diagnose()
    else:
        raise ValueError("Unknown helper command")
    write_json(destination, result)
