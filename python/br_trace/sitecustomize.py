"""Blast Radius "Deep trace" recorder for Python.

Loaded automatically at interpreter startup when this folder is first on PYTHONPATH (Python imports any
`sitecustomize` module it finds). It does nothing unless BR_TRACE_OUT is set. Then it records which
functions *of the project* ran: how many times, and when each was last called (a global sequence number,
so "ran just before the crash" can be told apart from "ran during setup"). One JSON file per process is
written to BR_TRACE_OUT at exit.

Function-level only (sys.setprofile sees calls, not lines), so the overhead stays modest. Python 3.6+.
"""
import os

_out = os.environ.get("BR_TRACE_OUT")
if _out:
    import atexit
    import json
    import sys
    import threading

    _root = os.path.normcase(os.path.abspath(os.environ.get("BR_TRACE_ROOT", os.getcwd())))
    _skip = ("site-packages", "dist-packages", os.sep + ".venv" + os.sep, os.sep + "venv" + os.sep, os.sep + ".tox" + os.sep)
    _mine = {}  # code object -> bool (inside the project?)
    _count = {}  # code object -> calls
    _last = {}  # code object -> sequence number of its latest call
    _seq = [0]

    def _inside(code):
        r = _mine.get(code)
        if r is None:
            name = code.co_filename
            # "<frozen importlib._bootstrap>", "<string>": not files; abspath would put them inside the root.
            if not name or name.startswith("<"):
                r = False
            else:
                f = os.path.normcase(os.path.abspath(name))
                r = f.startswith(_root) and not any(s in f for s in _skip)
            _mine[code] = r
        return r

    def _profile(frame, event, arg):
        if event != "call":
            return
        code = frame.f_code
        if not _inside(code):
            return
        _seq[0] += 1
        _count[code] = _count.get(code, 0) + 1
        _last[code] = _seq[0]

    def _dump():
        sys.setprofile(None)
        rows = [[c.co_filename, c.co_firstlineno, c.co_name, n, _last[c]] for c, n in _count.items()]
        try:
            os.makedirs(_out, exist_ok=True)
            with open(os.path.join(_out, "py-%d.json" % os.getpid()), "w", encoding="utf-8") as fh:
                json.dump({"lang": "python", "pid": os.getpid(), "argv": sys.argv, "root": _root, "seq": _seq[0], "calls": rows}, fh)
        except Exception:
            pass

    atexit.register(_dump)
    threading.setprofile(_profile)
    sys.setprofile(_profile)
