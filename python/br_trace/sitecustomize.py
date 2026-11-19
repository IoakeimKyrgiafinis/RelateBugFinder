"""Blast Radius "Deep trace" recorder for Python.

Loaded automatically at interpreter startup when this folder is first on PYTHONPATH (Python imports any
`sitecustomize` module it finds). It does nothing unless BR_TRACE_OUT is set. Then, for functions *of the
project* only, it records:

  * how many times each ran, and when it was last called (a global call sequence number, so "ran just
    before the crash" can be told apart from "ran during setup");
  * which of its lines ran;
  * a small summary of what it returned: the value itself for None, booleans, numbers and short strings,
    and only the type (plus length) for anything else, so no object's __repr__ is ever called. Up to 8
    distinct values per function, each with the order of its first and last return.

One JSON file per process is written to BR_TRACE_OUT at exit. Library code is never traced line by line
(its frames get no local trace function). BR_TRACE_LINES=0 falls back to calls only (sys.setprofile).
Python 3.6+.
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
    _lines = {}  # code object -> set of line numbers that ran
    _rets = {}  # code object -> {summary: [count, first return order, last return order]}
    _seq = [0]  # project calls so far
    _rseq = [0]  # project returns so far
    _raising = set()  # ids of frames whose latest event was an exception (a "return" then means it raised)
    _MAX_VALUES = 8

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

    _SCALARS = (bool, int, float)
    _EMPTY = {list: "[]", tuple: "()", dict: "{}", set: "set()", frozenset: "frozenset()"}

    def _summary(v):
        """A short, side-effect-free description of a returned value."""
        if v is None:
            return "None"
        t = type(v)
        if t in _SCALARS:
            r = repr(v)
            return r if len(r) <= 60 else None
        if t is str:
            return repr(v) if len(v) <= 60 else "<str len=%d>" % len(v)
        if t is bytes:
            return repr(v) if len(v) <= 40 else "<bytes len=%d>" % len(v)
        if t in _EMPTY:
            try:
                n = len(v)
            except Exception:
                return "<%s>" % t.__name__
            return _EMPTY[t] if n == 0 else "<%s len=%d>" % (t.__name__, n)
        return "<%s>" % getattr(t, "__name__", "object")

    def _returned(code, v):
        _rseq[0] += 1
        s = _summary(v)
        if s is None:
            return
        d = _rets.get(code)
        if d is None:
            d = _rets[code] = {}
        e = d.get(s)
        if e is not None:
            e[0] += 1
            e[2] = _rseq[0]
        elif len(d) < _MAX_VALUES:
            d[s] = [1, _rseq[0], _rseq[0]]

    def _called(code):
        _seq[0] += 1
        _count[code] = _count.get(code, 0) + 1
        _last[code] = _seq[0]

    def _local(frame, event, arg):
        if event == "line":
            _lines[frame.f_code].add(frame.f_lineno)
            if _raising:
                _raising.discard(id(frame))  # the exception was handled here; it goes on
        elif event == "return":
            if id(frame) in _raising:
                _raising.discard(id(frame))  # left by an exception, not a return value
            else:
                _returned(frame.f_code, arg)
        elif event == "exception":
            _raising.add(id(frame))
        return _local

    def _trace(frame, event, arg):
        if event != "call":
            return None
        code = frame.f_code
        if not _inside(code):
            return None  # no line events for library code
        _called(code)
        if code not in _lines:
            _lines[code] = set()
        return _local

    def _profile(frame, event, arg):
        if event == "call":
            if _inside(frame.f_code):
                _called(frame.f_code)
        elif event == "return" and _inside(frame.f_code):
            _returned(frame.f_code, arg)

    def _dump():
        sys.settrace(None)
        sys.setprofile(None)
        rows = []
        for c, n in _count.items():
            rets = [[s, e[0], e[1], e[2]] for s, e in _rets.get(c, {}).items()]
            rows.append([c.co_filename, c.co_firstlineno, c.co_name, n, _last[c], sorted(_lines.get(c, ())), rets])
        try:
            os.makedirs(_out, exist_ok=True)
            with open(os.path.join(_out, "py-%d.json" % os.getpid()), "w", encoding="utf-8") as fh:
                json.dump({"lang": "python", "pid": os.getpid(), "argv": sys.argv, "root": _root, "seq": _seq[0], "rseq": _rseq[0], "calls": rows}, fh)
        except Exception:
            pass

    atexit.register(_dump)
    if os.environ.get("BR_TRACE_LINES", "1") == "0":
        threading.setprofile(_profile)
        sys.setprofile(_profile)
    else:
        threading.settrace(_trace)
        sys.settrace(_trace)
