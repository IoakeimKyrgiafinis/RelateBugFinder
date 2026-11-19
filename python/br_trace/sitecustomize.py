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

How, so that it coexists with coverage tools (pytest --cov) and debuggers:
  * Python 3.12+: sys.monitoring, as its own tool. Library code is switched off per code location
    (DISABLE), so it costs almost nothing outside the project.
  * Older Pythons: sys.setprofile for calls and returns (coverage never touches it) and sys.settrace for
    lines (a function called more than 200 times is no longer line-traced: its lines are known by then).
    If another tool replaces the line tracer, calls and return values are still recorded and the
    output says `"lines": "replaced"`.

If the project has its own sitecustomize, it is still run (the next one on sys.path).
One JSON file per process is written to BR_TRACE_OUT at exit. BR_TRACE_LINES=0 records calls and
return values only. Python 3.6+.
"""
import os
import sys


def _chain_next_sitecustomize():
    """Run the sitecustomize this one shadows (the project's or the venv's), if there is one."""
    here = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
    for d in sys.path:
        try:
            if not d or os.path.normcase(os.path.abspath(d)) == here:
                continue
            f = os.path.join(d, "sitecustomize.py")
            if os.path.isfile(f):
                with open(f, "rb") as fh:
                    code = compile(fh.read(), f, "exec")
                exec(code, {"__name__": "sitecustomize", "__file__": f})
                return
        except Exception:
            return


_chain_next_sitecustomize()

_out = os.environ.get("BR_TRACE_OUT")
if _out:
    import atexit
    import json
    import threading

    _root = os.path.normcase(os.path.abspath(os.environ.get("BR_TRACE_ROOT", os.getcwd())))
    _skip = ("site-packages", "dist-packages", os.sep + ".venv" + os.sep, os.sep + "venv" + os.sep, os.sep + ".tox" + os.sep)
    _want_lines = os.environ.get("BR_TRACE_LINES", "1") != "0"
    _mine = {}  # code object -> bool (inside the project?)
    _count = {}  # code object -> calls
    _last = {}  # code object -> sequence number of its latest call
    _lines = {}  # code object -> set of line numbers that ran
    _rets = {}  # code object -> {summary: [count, first return order, last return order]}
    _seq = [0]  # project calls so far
    _rseq = [0]  # project returns so far
    _raising = set()  # ids of frames whose latest traced event was an exception (pre-3.12 path)
    _mode = ["none"]
    _lines_state = ["off" if not _want_lines else "on"]
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

    def _called(code):
        _seq[0] += 1
        _count[code] = _count.get(code, 0) + 1
        _last[code] = _seq[0]

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

    def _line(code, n):
        s = _lines.get(code)
        if s is None:
            s = _lines[code] = set()
        s.add(n)

    # ---- Python 3.12+: sys.monitoring --------------------------------------------------------------
    _tool = [None]

    def _start_monitoring():
        mon = getattr(sys, "monitoring", None)
        if mon is None:
            return False
        for tid in (mon.PROFILER_ID, 3, 4):
            try:
                mon.use_tool_id(tid, "blast-radius")
                _tool[0] = tid
                break
            except ValueError:
                continue
        if _tool[0] is None:
            return False
        E, DISABLE, tid = mon.events, mon.DISABLE, _tool[0]

        def on_start(code, offset):
            if not _inside(code):
                return DISABLE
            _called(code)

        def on_return(code, offset, value):
            if not _inside(code):
                return DISABLE
            _returned(code, value)  # PY_RETURN never fires when a function raises (that is PY_UNWIND)

        def on_line(code, n):
            # Only *which* lines ran matters, so each line is reported once, then switched off at that
            # location: a hot loop costs one callback, not one per iteration.
            if _inside(code):
                _line(code, n)
            return DISABLE

        mon.register_callback(tid, E.PY_START, on_start)
        mon.register_callback(tid, E.PY_RETURN, on_return)
        mask = E.PY_START | E.PY_RETURN
        if _want_lines:
            mon.register_callback(tid, E.LINE, on_line)
            mask |= E.LINE
        mon.set_events(tid, mask)
        _mode[0] = "monitoring"
        return True

    # ---- older Pythons: setprofile (calls, returns) + settrace (lines) -----------------------------
    def _profile(frame, event, arg):
        if event == "call":
            if _inside(frame.f_code):
                _called(frame.f_code)
        elif event == "return":
            if _inside(frame.f_code):
                if id(frame) in _raising:
                    _raising.discard(id(frame))  # left by an exception, not a return value
                else:
                    _returned(frame.f_code, arg)

    def _local(frame, event, arg):
        if event == "line":
            _line(frame.f_code, frame.f_lineno)
            if _raising:
                _raising.discard(id(frame))  # the exception was handled here; it goes on
        elif event == "exception":
            _raising.add(id(frame))
        return _local

    _HOT = 200  # after this many calls a function's lines are known; stop line-tracing it (cost)

    def _trace(frame, event, arg):
        if event != "call" or not _inside(frame.f_code):
            return None  # no line events for library code
        if _count.get(frame.f_code, 0) > _HOT:
            return None  # calls and return values are still recorded by the profiler
        return _local

    def _start_legacy():
        threading.setprofile(_profile)
        sys.setprofile(_profile)
        if _want_lines:
            threading.settrace(_trace)
            sys.settrace(_trace)
        _mode[0] = "profile"

    def _dump():
        if _tool[0] is not None:
            try:
                sys.monitoring.set_events(_tool[0], 0)
                sys.monitoring.free_tool_id(_tool[0])
            except Exception:
                pass
        else:
            if _want_lines and sys.gettrace() is not _trace:
                _lines_state[0] = "replaced"  # coverage or a debugger installed its own tracer
            sys.settrace(None)
            sys.setprofile(None)
        rows = []
        for c, n in _count.items():
            rets = [[s, e[0], e[1], e[2]] for s, e in _rets.get(c, {}).items()]
            rows.append([c.co_filename, c.co_firstlineno, c.co_name, n, _last[c], sorted(_lines.get(c, ())), rets])
        try:
            os.makedirs(_out, exist_ok=True)
            with open(os.path.join(_out, "py-%d.json" % os.getpid()), "w", encoding="utf-8") as fh:
                json.dump({"lang": "python", "pid": os.getpid(), "argv": sys.argv, "root": _root, "python": sys.executable,
                           "version": sys.version.split()[0], "mode": _mode[0], "lines": _lines_state[0],
                           "seq": _seq[0], "rseq": _rseq[0], "calls": rows}, fh)
        except Exception:
            pass

    atexit.register(_dump)
    # BR_TRACE_LEGACY=1 forces the pre-3.12 path (for tests on new Pythons).
    if os.environ.get("BR_TRACE_LEGACY") == "1" or not _start_monitoring():
        _start_legacy()
