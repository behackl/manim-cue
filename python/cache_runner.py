"""Fresh-process launcher with checked-hash bytecode in Cue-owned storage.

Never trust timestamp-only pycs for scene/helper/editable-library source. CPython
validates source hashes again when loading, including if a file changes during
cache preparation. No application modules or Scene state persist between runs.
"""
import importlib.machinery
import importlib.util
import os
import py_compile
import runpy
import sys


def install():
    if not sys.pycache_prefix or not os.path.isabs(sys.pycache_prefix):
        raise RuntimeError("Cue requires an absolute private bytecode cache directory.")
    prefix = sys.pycache_prefix
    original = importlib.machinery.SourceFileLoader.get_code

    def get_code(loader, fullname):
        if sys.pycache_prefix != prefix:
            return loader.source_to_code(loader.get_data(loader.path), loader.path)
        cache = importlib.util.cache_from_source(loader.path)
        try:
            source = loader.get_data(loader.path)
            expected = importlib.util.MAGIC_NUMBER + (3).to_bytes(4, "little") + importlib.util.source_hash(source)
            try:
                with open(cache, "rb") as stream:
                    matches = stream.read(16) == expected
            except OSError:
                matches = False
            if not matches:
                # Public stdlib compiler writes checked-hash pycs atomically. The
                # original loader then revalidates against current source bytes.
                py_compile.compile(loader.path, cfile=cache, doraise=True,
                                   invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH)
        except (OSError, py_compile.PyCompileError):
            # Read-only cache / invalid source: normal loader provides the error or
            # compiles source without writing (-B). Never fall back to project pycs.
            pass
        try:
            return original(loader, fullname)
        except (EOFError, ImportError, ValueError):
            # A damaged cache is disposable, never a reason to use stale code.
            try:
                os.unlink(cache)
            except OSError:
                pass
            return loader.source_to_code(loader.get_data(loader.path), loader.path)

    importlib.machinery.SourceFileLoader.get_code = get_code


if __name__ == "__main__":
    install()
    target, *arguments = sys.argv[1:]
    if target == "-m":
        module, *arguments = arguments
        sys.path.insert(0, os.getcwd())
        sys.argv = [module, *arguments]
        runpy.run_module(module, run_name="__main__", alter_sys=True)
    else:
        sys.argv = [target, *arguments]
        runpy.run_path(target, run_name="__main__")
