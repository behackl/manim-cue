import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("cue_notebook", ROOT / "python" / "cue_notebook.py")
nb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nb)

SCENE = "class Orbit(Scene):\n    def construct(self):\n        self.play(Create(Circle(radius=RADIUS, color=COLORS[-1])))\n"


def cells(*sources):
    return list(enumerate(sources))


def chosen(sources, scene="Orbit", mode="needed"):
    return nb.build(cells(*sources), scene, mode)["cells"]


class SelectionTests(unittest.TestCase):
    def test_runs_the_cells_that_the_scene_needs_and_skips_others(self):
        sources = ("from manim import *\nimport numpy as np", "data = np.load('huge.npy')\nmodel = train(data)",
                   "RADIUS = 2\nCOLORS = [BLUE]", "unused = 3", SCENE)
        self.assertEqual(chosen(sources), [0, 2, 4])
        self.assertEqual(chosen(sources, mode="allAbove"), [0, 1, 2, 3, 4])

    def test_follows_names_through_cells_and_later_changes(self):
        sources = ("from manim import Scene, Circle, Create", "import math\nBASE = 1", "RADIUS = math.sqrt(BASE)",
                   "COLORS = []", "COLORS.append('RED')", "COLORS[0] = 'BLUE'", "other = 1", SCENE)
        self.assertEqual(chosen(sources), [0, 1, 2, 3, 4, 5, 7])

    def test_a_change_further_down_reaches_a_cell_further_up(self):
        # Cell 2 changes `settings`, which cell 1 uses to make RADIUS: all of them run.
        sources = ("settings = {}", "RADIUS = settings.get('r', 1)\nCOLORS = ['RED']", "settings['r'] = 2", SCENE)
        self.assertEqual(chosen(sources), [0, 1, 2, 3])

    def test_star_imports_global_state_and_markers_always_run(self):
        sources = ("from manim import *", "config.background_color = WHITE", "Text.set_default(font='Inter')",
                   "import sys\nsys.path.append('lib')", "# cue: run\nregister_fonts()", "register_other()",
                   "RADIUS = 1\nCOLORS = [RED]", SCENE)
        self.assertEqual(chosen(sources), [0, 1, 2, 3, 4, 6, 7])

    def test_own_config_is_an_ordinary_name(self):
        sources = ("from manim import Scene, Circle, Create", "config = {}", "config['x'] = 1", "RADIUS = 1\nCOLORS = ['RED']", SCENE)
        self.assertEqual(chosen(sources), [0, 3, 4])

    def test_the_last_definition_of_the_scene_is_the_scene_cell(self):
        sources = ("from manim import *", "RADIUS = 1\nCOLORS = [RED]", SCENE, "RADIUS = 5", SCENE.replace("RADIUS", "3"))
        built = nb.build(cells(*sources), "Orbit")
        # The last scene cell uses COLORS from cell 1, not RADIUS from cell 3.
        self.assertEqual((built["scene"], built["cells"]), (4, [0, 1, 4]))
        self.assertIsNone(nb.build(cells(*sources), "Missing"))

    def test_state_through_a_module_imported_in_another_cell(self):
        sources = ("import manim as mn\nfrom manim import Scene, Create, Circle", "mn.config.background_color = 'WHITE'", "RADIUS = 1", SCENE.replace(", color=COLORS[-1]", ""))
        self.assertEqual(chosen(sources), [0, 1, 2, 3])

    def test_a_call_of_a_function_that_sets_a_global(self):
        sources = ("from manim import *", "def setup():\n    global RADIUS, COLORS\n    RADIUS, COLORS = 1, [RED]", "setup()", "other()", SCENE)
        self.assertEqual(chosen(sources), [0, 1, 2, 4])

    def test_definitions_inside_branches_and_loops_count(self):
        sources = ("from manim import *", "if True:\n    RADIUS = 1\nfor COLORS in [[RED]]:\n    pass", "with open('x') as handle:\n    pass", SCENE)
        self.assertEqual(chosen(sources), [0, 1, 3])


class TranslationTests(unittest.TestCase):
    def test_ipython_syntax_becomes_comments_and_line_numbers_stay(self):
        sources = ("%matplotlib inline\nfrom manim import *\n!pip install x", "%%bash\necho RADIUS=1",
                   "%%manim -qm Orbit\nRADIUS = 1\nCOLORS = [RED]\n" + SCENE)
        built = nb.build(cells(*sources), "Orbit")
        self.assertEqual(built["cells"], [0, 2])
        lines = built["source"].split("\n")
        first = built["segments"][0]["start"]
        self.assertEqual(lines[first - 1:first + 2], ["pass  # IPython: %matplotlib inline", "from manim import *", "pass  # IPython: !pip install x"])
        scene = built["segments"][1]
        self.assertEqual(lines[scene["start"] - 1], "# %%manim -qm Orbit")
        self.assertEqual(nb.locate(built, scene["start"] + 5)["line"], 6)
        self.assertEqual(nb.locate(built, scene["start"] + 5)["index"], 2)
        self.assertIsNone(nb.locate(built, 1), "the preamble is no cell")
        compile(built["source"], "x.py", "exec")

    def test_percent_signs_in_python_stay(self):
        source = "from manim import *\nRADIUS = 1\nCOLORS = [RED]\nlabel = r'''\n% a TeX comment\n'''"
        built = nb.build(cells(source, SCENE), "Orbit")
        self.assertIn("\n% a TeX comment\n", built["source"])

    def test_outputs_and_execution_counts_do_not_change_the_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "n.ipynb"
            def write(outputs, count, extra=""):
                code = [{"cell_type": "code", "source": ["from manim import *\n", "RADIUS = 1\n", "COLORS = [RED]"], "outputs": outputs, "execution_count": count, "metadata": {}},
                        {"cell_type": "markdown", "source": "# Title" + extra, "metadata": {}},
                        {"cell_type": "code", "source": "slow = 1" + extra, "outputs": [], "execution_count": None, "metadata": {}},
                        {"cell_type": "code", "source": SCENE, "outputs": [], "execution_count": None, "metadata": {}}]
                path.write_text(json.dumps({"cells": code, "metadata": {}, "nbformat": 4, "nbformat_minor": 5}))
                return nb.build(nb.read(path), "Orbit")["hash"]
            first = write([], None)
            self.assertEqual(write([{"output_type": "stream", "name": "stdout", "text": "x"}], 3), first)
            self.assertEqual(write([], None, extra=" changed"), first, "markdown and skipped cells")
            self.assertEqual(nb.read(path)[1], (2, "slow = 1 changed"), "the index counts all cells")

    def test_the_helper_hashes_editor_cells_like_the_saved_file(self):
        request = {"cells": [[0, "from manim import *\nRADIUS = 1\nCOLORS = [RED]"], [2, SCENE]], "scene": "Orbit", "mode": "needed"}
        out = subprocess.run([sys.executable, "-I", "-S", str(ROOT / "python" / "cue_notebook.py"), "hash"],
                             input=json.dumps(request), capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(out.stdout)["hash"], nb.build([(0, request["cells"][0][1]), (2, SCENE)], "Orbit")["hash"])


class DiscoveryTests(unittest.TestCase):
    def test_scene_bases_carry_over_from_cells_above(self):
        sources = ("from manim import Scene as Base", "class One(Base): pass", "%%bash\nclass Two(Base): pass", "class Three(One): pass", "class (")
        self.assertEqual(nb.discover(cells(*sources)), [{"name": "One", "line": 1, "cell": 1}, {"name": "Three", "line": 1, "cell": 3}])

    def test_manim_magic_cells_report_lines_of_the_cell(self):
        self.assertEqual(nb.discover(cells("from manim import *", "%%manim Demo\nclass Demo(Scene): pass")), [{"name": "Demo", "line": 2, "cell": 1}])


class ExplanationTests(unittest.TestCase):
    def explain(self, sources, name, mode="needed"):
        built = nb.build(cells(*sources), "Orbit", mode)
        result = nb.explain(cells(*sources), built, name)
        return result["reason"], result["cell"] and result["cell"]["index"]

    def test_a_name_set_only_below_the_scene(self):
        self.assertEqual(self.explain(("from manim import *", SCENE, "RADIUS = 1"), "RADIUS"), ("below", 2))

    def test_a_skipped_cell_that_may_set_the_name(self):
        sources = ("from manim import *", "exec('RADIUS = 1')", SCENE)
        self.assertEqual(self.explain(sources, "RADIUS"), ("skipped", 1))
        self.assertEqual(self.explain(("from manim import *", "globals()['RADIUS'] = 1", SCENE), "RADIUS"), ("skipped", 1))
        self.assertEqual(self.explain(sources, "RADIUS", mode="allAbove"), ("unknown", None))

    def test_magics_and_cells_that_are_not_python(self):
        self.assertEqual(self.explain(("from manim import *", "RADIUS = %time compute()", SCENE), "RADIUS"), ("magic", 1))
        self.assertEqual(self.explain(("from manim import *", "%%time\nRADIUS = (", SCENE), "RADIUS"), ("notPython", 1))
        self.assertEqual(self.explain(("from manim import *", "%%bash\nRADIUS=1", SCENE), "RADIUS"), ("notPython", 1))

    def test_no_cell_mentions_the_name(self):
        self.assertEqual(self.explain(("from manim import *", SCENE), "RADIUS"), ("unknown", None))

    def test_cells_are_named_by_their_first_line_of_code(self):
        cell = nb.Cell(0, "# cue: run\n\n# Setup\nRADIUS = 1")
        self.assertEqual((cell.first, cell.marker), ("RADIUS = 1", True))
        self.assertEqual(nb.Cell(0, "%%manim -qm Demo\nclass Demo(Scene): pass").first, "class Demo(Scene): pass")


if __name__ == "__main__":
    unittest.main()
