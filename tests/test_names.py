"""Every name a pipeline function uses must exist where it runs.

The unit tests can't run every function on real data, so a missing import (a module imported inside one
function and used in another) can reach the weekly update and crash it. This reads each module's symbol
table: a name a function treats as global must be defined at module level or be a builtin.
"""
import builtins
import importlib
import symtable
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULES = sorted(p.stem for p in (ROOT / "pipeline").glob("*.py") if p.stem != "__init__") + ["tools.announce", "tools.colours"]


def functions(table):
    for child in table.get_children():
        if child.get_type() == "function":
            yield child
        yield from functions(child)


class UndefinedNameTests(unittest.TestCase):
    def test_every_global_a_function_uses_exists(self):
        problems = []
        for name in MODULES:
            dotted = name if "." in name else f"pipeline.{name}"
            path = ROOT / (dotted.replace(".", "/") + ".py")
            module = importlib.import_module(dotted)
            table = symtable.symtable(path.read_text(), str(path), "exec")
            for fn in functions(table):
                for sym in fn.get_globals():
                    if not hasattr(module, sym) and not hasattr(builtins, sym):
                        problems.append(f"{path.relative_to(ROOT)}: {fn.get_name()}() uses '{sym}', which isn't defined there")
        self.assertEqual(problems, [], "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
