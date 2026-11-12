"""Turn the code cells of a Jupyter notebook into one Python file that runs a scene.

Standard library only. The extension runs this file with -I -S for the code hash and the
scene discovery; it never runs notebook code. support.py imports it for scene runs.

A run takes the cell with the scene class and, above it, the cells that the scene needs
("needed"), or all code cells above it ("allAbove"). A cell is needed when it:

- defines or changes a name that a needed cell uses;
- changes the global state of Manim, ``sys`` or ``os`` (``config.x = …``,
  ``Text.set_default(…)``, ``sys.path.append(…)``);
- has a star import; or
- starts with the line ``# cue: run``.
"""
import ast
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

MARKER = re.compile(r"#\s*cue:\s*run\s*$", re.IGNORECASE)
# Cell magics whose body is Python that runs once in Jupyter too.
PYTHON_CELL_MAGICS = {"manim", "time", "timeit", "capture"}
MAGIC_LINE = re.compile(r"^(\s*)[%!]")
MAGIC_ASSIGNMENT = re.compile(r"^(\s*)([A-Za-z_][\w, ]*?)\s*=\s*[%!]")
DYNAMIC_CALLS = {"exec", "eval", "globals", "setattr", "vars"}
# Modules whose state a configuration cell changes for the whole run.
STATE_MODULES = {"manim", "sys", "os"}
# Jupyter provides display(); outside Jupyter it shows nothing.
PREAMBLE = "def display(*objects, **options):\n    pass\n"


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class Cell:
    """One code cell: its Python text, with as many lines as the cell, and what it binds and uses."""

    def __init__(self, index, source):
        self.index = index
        self.source = source
        self.sha = _sha(source)
        self.kind = "python"  # "python", "other" (a cell magic that is not Python) or "invalid"
        self.marker = False
        self.star = False
        self.dynamic = False
        self.defines, self.uses, self.mutates = set(), set(), set()
        self.imported, self.state = set(), set()
        self.state_names = set()  # names bound to manim, sys or os, or imported from them
        self.calls = set()  # functions that the cell calls when it runs
        self.function_globals = {}  # function name -> the global names that it sets
        self.globals, self.magic_names, self.words = set(), set(), set()
        self.classes = []  # (name, line) of top-level scene class candidates
        self.code = self._translate()
        # The cell's name in messages: VS Code shows no cell numbers.
        lines = [line.strip() for line in source.split("\n")]
        self.first = next((line for line in lines if line and not line.startswith(("#", "%%"))), "")[:60]

    def _translate(self):
        lines = self.source.split("\n")
        first = next((line.strip() for line in lines if line.strip()), "")
        self.marker = bool(MARKER.fullmatch(first))
        if lines and lines[0].lstrip().startswith("%%"):
            magic = lines[0].lstrip()[2:].split(maxsplit=1)
            if not magic or magic[0] not in PYTHON_CELL_MAGICS:
                self.kind = "other"
                return ""
            lines[0] = "# " + lines[0]
        code = "\n".join(lines)
        try:
            tree = ast.parse(code)
        except SyntaxError:
            # IPython lines are not Python. Replace them only when the cell needs it, so
            # that a line starting with % inside a string (a TeX comment) stays as it is.
            for number, line in enumerate(lines):
                assignment = MAGIC_ASSIGNMENT.match(line)
                if assignment:
                    self.magic_names.update(n.strip() for n in assignment.group(2).split(",") if n.strip().isidentifier())
                elif not MAGIC_LINE.match(line):
                    continue
                if line.lstrip().startswith("%run"):
                    self.dynamic = True
                lines[number] = (assignment or MAGIC_LINE.match(line)).group(1) + "pass  # IPython: " + line.strip()
            code = "\n".join(lines)
            try:
                tree = ast.parse(code)
            except SyntaxError:
                self.kind = "invalid"
                return code
        self._analyze(tree)
        return code

    def _analyze(self, tree):
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                self.uses.add(node.id)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                self.words.update(re.findall(r"[A-Za-z_]\w*", node.value))
            elif isinstance(node, ast.Global):
                self.globals.update(node.names)
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id in DYNAMIC_CALLS:
                    self.dynamic = True
                elif isinstance(node.func, ast.Attribute) and node.func.attr == "set_default":
                    root = _root(node.func)
                    if root:
                        self.state.add(root)
        self._statements(tree.body)

    def _statements(self, body):
        """The code that runs when the cell runs: module level, with its loops and branches."""
        for node in body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self._calls([node])
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                module = node.module if isinstance(node, ast.ImportFrom) else None
                for alias in node.names:
                    if alias.name == "*":
                        self.star = True
                        continue
                    name = alias.asname or alias.name.split(".")[0]
                    self.defines.add(name)
                    self.imported.add(name)
                    top = (module or alias.name).split(".")[0]
                    if top in STATE_MODULES:
                        self.state_names.add(name)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self.defines.add(node.name)
                if not isinstance(node, ast.ClassDef):
                    names = {n for child in ast.walk(node) if isinstance(child, ast.Global) for n in child.names}
                    if names:
                        self.function_globals[node.name] = names
                if isinstance(node, ast.ClassDef) and node.bases:
                    self.classes.append((node.name, node.lineno))
                self._walrus(node.decorator_list)
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                    self._target(target)
                self._walrus([node.value] if node.value else [])
            elif isinstance(node, ast.Delete):
                for target in node.targets:
                    self._target(target)
            elif isinstance(node, ast.Expr):
                if isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute):
                    root = _root(node.value.func)
                    if root:
                        self.mutates.add(root)
                self._walrus([node.value])
            else:
                if isinstance(node, (ast.For, ast.AsyncFor)):
                    self._target(node.target)
                elif isinstance(node, (ast.With, ast.AsyncWith)):
                    for item in node.items:
                        if item.optional_vars is not None:
                            self._target(item.optional_vars)
                for handler in getattr(node, "handlers", []):
                    if handler.name:
                        self.defines.add(handler.name)
                for field in ("body", "orelse", "finalbody"):
                    self._statements(getattr(node, field, []))
                for handler in getattr(node, "handlers", []):
                    self._statements(handler.body)
                for case in getattr(node, "cases", []):
                    self._statements(case.body)
                self._walrus([value for key, value in ast.iter_fields(node) if key in ("test", "iter", "subject")])

    def _calls(self, nodes):
        for node in nodes:
            for child in ast.walk(node):
                if isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
                    self.calls.add(child.func.id)

    def _target(self, target):
        if isinstance(target, ast.Name):
            self.defines.add(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for element in target.elts:
                self._target(element)
        elif isinstance(target, ast.Starred):
            self._target(target.value)
        else:
            root = _root(target)
            if root:
                self.mutates.add(root)

    def _walrus(self, nodes):
        for node in nodes:
            for child in ast.walk(node):
                if isinstance(child, ast.NamedExpr):
                    self.defines.add(child.target.id)

    def changes_state(self, assigned, state_names):
        """The cell changes the state of Manim, sys or os (``state_names``: the names that
        any cell binds to them), or of a name that no cell assigns, from a star import."""
        changed = self.mutates | self.state
        return bool(changed & state_names) or "config" in changed and "config" not in assigned or bool(self.state - assigned)


def _root(node):
    while isinstance(node, (ast.Attribute, ast.Subscript, ast.Call)):
        node = node.func if isinstance(node, ast.Call) else node.value
    return node.id if isinstance(node, ast.Name) else None


def read(path):
    """The code cells of a saved notebook, as (index, source); the index counts all cells."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    cells = []
    for index, cell in enumerate(data.get("cells", [])):
        if cell.get("cell_type") != "code":
            continue
        source = cell.get("source", "")
        cells.append((index, "".join(source) if isinstance(source, list) else source))
    return cells


def analyze(sources):
    return [Cell(index, source) for index, source in sources]


def scene_cell(cells, scene):
    """The last cell that defines the scene class: Jupyter uses the last definition that ran."""
    matches = [cell for cell in cells if cell.kind != "other" and scene in (name for name, _ in cell.classes)]
    if not matches:
        # A scene cell with a syntax error: show its error, not "no scene".
        matches = [cell for cell in cells if cell.kind == "invalid" and re.search(rf"^class\s+{re.escape(scene)}\b", cell.code, re.M)]
    return matches[-1] if matches else None


def select(cells, scene_index, mode):
    """The cells that run, in notebook order."""
    above = [cell for cell in cells if cell.index < scene_index and cell.kind != "other"]
    scene = next(cell for cell in cells if cell.index == scene_index)
    if mode == "allAbove":
        return above + [scene]
    python = [cell for cell in above if cell.kind == "python"]
    assigned = set().union(*(cell.defines - cell.imported for cell in python + [scene]))
    state_names = set().union(*(cell.state_names for cell in python + [scene]))
    # A call of a function that declares `global x` sets x.
    function_globals = {}
    for cell in python:
        function_globals.update(cell.function_globals)
    sets = lambda cell: cell.defines | cell.mutates | {n for f in cell.calls for n in function_globals.get(f, ())}
    chosen, needed = {scene.index}, set(scene.uses)
    changed = True
    while changed:  # A cell further down can change a name that a cell further up uses.
        changed = False
        for cell in reversed(python):
            if cell.index in chosen:
                continue
            if cell.marker or cell.star or cell.changes_state(assigned, state_names) or sets(cell) & needed:
                chosen.add(cell.index)
                needed |= cell.uses
                changed = True
    return [cell for cell in python if cell.index in chosen] + [scene]


def build(sources, scene, mode="needed"):
    """The Python file for the scene, the map from its lines to cells, and its hash.

    Returns None when no cell defines the scene class.
    """
    cells = analyze(sources)
    target = scene_cell(cells, scene)
    if target is None:
        return None
    chosen = select(cells, target.index, mode)
    parts, segments, line = [PREAMBLE], [], PREAMBLE.count("\n") + 1
    for cell in chosen:
        code = cell.code + "\n"
        segments.append({"cell": cell.index, "sha": cell.sha, "first": cell.first, "start": line, "count": code.count("\n")})
        parts.append(code)
        line += code.count("\n")
    source = "".join(parts)
    return {"source": source, "hash": _sha(source), "scene": target.index, "cells": [cell.index for cell in chosen],
            "segments": segments, "mode": mode}


def locate(built, line):
    """The cell and the line in it for a line of the built file, or None for the preamble."""
    for segment in built["segments"]:
        if segment["start"] <= line < segment["start"] + segment["count"]:
            return {"index": segment["cell"], "sha": segment["sha"], "first": segment["first"], "line": line - segment["start"] + 1}
    return None


def explain(sources, built, name):
    """Why a cell of the notebook has no value for ``name``: the reason and the cell to show."""
    cells = analyze(sources)
    scene, chosen = built["scene"], set(built["cells"])
    ref = lambda cell: {"index": cell.index, "sha": cell.sha, "first": cell.first}
    above = [cell for cell in cells if cell.index < scene]
    binds = lambda cell: name in cell.defines or name in cell.mutates
    nearest = lambda test: next((cell for cell in reversed(above) if test(cell)), None)
    if not any(binds(cell) or name in cell.magic_names for cell in above):
        below = next((cell for cell in cells if cell.index > scene and cell.kind == "python" and binds(cell)), None)
        if below:
            return {"reason": "below", "cell": ref(below)}
    magic = nearest(lambda cell: name in cell.magic_names)
    if magic:
        return {"reason": "magic", "cell": ref(magic)}
    pattern = re.compile(rf"(^|\n)\s*({re.escape(name)}\b[^=\n]*=(?!=)|def\s+{re.escape(name)}\b|class\s+{re.escape(name)}\b|(from\s+\S+\s+)?import\s.*\b{re.escape(name)}\b)")
    other = nearest(lambda cell: cell.kind != "python" and pattern.search(cell.source))
    if other:
        return {"reason": "notPython", "cell": ref(other)}
    if built["mode"] == "needed":
        skipped = nearest(lambda cell: cell.kind == "python" and cell.index not in chosen and (
            binds(cell) or name in cell.globals or cell.dynamic and (name in cell.words or "%run" in cell.source)))
        if skipped:
            return {"reason": "skipped", "cell": ref(skipped)}
    return {"reason": "unknown", "cell": None}


def discover(sources, helper=None):
    """The scene classes of the notebook as {name, cell, line}; the bases can come from cells above."""
    spec = importlib.util.spec_from_file_location("cue_discover", helper or Path(__file__).with_name("discover.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    state = module.State()
    scenes = []
    for cell in analyze(sources):
        if cell.kind != "python":
            continue
        for scene in module.discover_tree(ast.parse(cell.code), state):
            scenes.append({**scene, "cell": cell.index})
    return scenes


if __name__ == "__main__":
    request = json.loads(sys.stdin.read(32 * 1024 * 1024))
    sources = read(request["path"]) if "path" in request else [tuple(cell) for cell in request["cells"]]
    if sys.argv[1] == "discover":
        print(json.dumps({"scenes": discover(sources)}, ensure_ascii=True))
    else:
        built = build(sources, request["scene"], request.get("mode", "needed"))
        print(json.dumps({"hash": built["hash"] if built else "missing", "found": built is not None}, ensure_ascii=True))
