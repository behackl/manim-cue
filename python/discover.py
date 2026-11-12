"""Parse editor text as data. Run with -I -S; never import the scene or Manim."""
import ast
import json
import sys

BASES = {"Scene", "ThreeDScene", "MovingCameraScene", "ZoomedScene", "VectorScene", "LinearTransformationScene"}


class State:
    """The names known as scene bases. Notebook cells share one state, in order."""

    def __init__(self):
        self.roots, self.modules = set(), set()


def discover_tree(tree, state):
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "manim":
            for alias in node.names:
                if alias.name == "*":
                    state.roots.update(BASES)
                elif alias.name in BASES:
                    state.roots.add(alias.asname or alias.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "manim":
                    state.modules.add(alias.asname or alias.name)
    candidates = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        known = any(
            (isinstance(base, ast.Name) and base.id in state.roots)
            or (isinstance(base, ast.Attribute) and isinstance(base.value, ast.Name)
                and base.value.id in state.modules and base.attr in BASES)
            for base in node.bases
        )
        if known:
            state.roots.add(node.name)
            candidates.append({"name": node.name, "line": node.lineno})
    return candidates


def discover(source):
    return discover_tree(ast.parse(source), State())


if __name__ == "__main__":
    try:
        result = {"scenes": discover(sys.stdin.read(2 * 1024 * 1024))}
    except SyntaxError as error:
        result = {"scenes": [], "error": f"Syntax error on line {error.lineno}: {error.msg}"}
    print(json.dumps(result, ensure_ascii=True))
