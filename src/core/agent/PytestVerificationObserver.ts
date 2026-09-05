/**
 * An inert, bounded pytest hook plugin carried with the extension bundle. Its
 * receipt corroborates a physical terminal outcome; it is not a security boundary
 * against tests or plugins that deliberately tamper with their own Python process.
 */
export function pythonVerificationObserverSource(identity: {
	executionId: string
	nonce: string
	commandDigest: string
	reportPath: string
}): string {
	const encodedIdentity = Buffer.from(JSON.stringify(identity), "utf8").toString("base64")
	return `import base64
import hashlib
import json
import os
import pytest

_identity = json.loads(base64.b64decode("${encodedIdentity}"))
_MAX_FILES = 256
_MAX_TEXT = 4096
_MAX_ITEMS = 16384
_MAX_NODE_BYTES = 1048576
_MAX_REPORT_BYTES = 262144
_MAX_COUNTER = 9007199254740991
_COLLECTION_HOOKS = frozenset((
    "pytest_collection", "pytest_collect_directory", "pytest_collect_file",
    "pytest_pycollect_makemodule", "pytest_pycollect_makeitem", "pytest_make_collect_report",
    "pytest_ignore_collect", "pytest_collectstart", "pytest_collectreport",
    "pytest_itemcollected", "pytest_generate_tests"))
_COLLECTION_WRAPPERS = frozenset(("pytest_collection_modifyitems", "pytest_collection_finish"))
_state = {"sessions": 0, "files": {}, "nodes": {}, "unsupported": None,
          "collectionCompleted": False, "selectionFingerprint": None, "nodeBytes": 0}


def _unsupported(reason):
    if _state["unsupported"] is None:
        _state["unsupported"] = reason


@pytest.hookimpl
def pytest_plugin_registered(plugin, plugin_name, manager):
    try:
        # Registration is historic and includes conftests discovered during
        # collection. Remember unsupported hooks even if subsequently unregistered.
        for caller in manager.get_hookcallers(plugin) or ():
            if caller.name not in _COLLECTION_HOOKS and caller.name not in _COLLECTION_WRAPPERS:
                continue
            for implementation in caller.get_hookimpls():
                if implementation.plugin is not plugin:
                    continue
                function = implementation.function
                if (getattr(function, "__globals__", None) is globals() or
                        getattr(function, "__module__", "").startswith("_pytest.")):
                    continue
                if caller.name in _COLLECTION_HOOKS:
                    _unsupported("custom_collection_hook:" + caller.name)
                elif (getattr(implementation, "hookwrapper", False) or
                        getattr(implementation, "wrapper", False)):
                    _unsupported("custom_collection_wrapper:" + caller.name)
    except Exception:
        _unsupported("observer_hook_inspection_failed")


@pytest.hookimpl(tryfirst=True)
def pytest_generate_tests(metafunc):
    try:
        # Pytest invokes module/class generation callbacks through call_extra,
        # without registering them as plugins. Builtin mark.parametrize and
        # fixture parametrization remain eligible; custom generators need a
        # collector-specific contract to establish what they omitted.
        module = vars(metafunc.module)
        class_namespaces = (() if metafunc.cls is None else
                            (vars(base) for base in metafunc.cls.__mro__))
        if ("pytest_generate_tests" in module or "__getattr__" in module or
                any("pytest_generate_tests" in namespace or "__getattr__" in namespace
                    for namespace in class_namespaces)):
            _unsupported("custom_test_generation")
    except Exception:
        _unsupported("observer_hook_inspection_failed")


def _text(value):
    if (not isinstance(value, str) or len(value) > _MAX_TEXT or
            any(character in value for character in ("\\x00", "\\r", "\\n"))):
        _unsupported("unsupported_text")
        return ""
    return value


def _path(value):
    candidate = _text(os.fspath(value))
    if not candidate:
        _unsupported("unsupported_path")
        return None
    result = _text(os.path.abspath(candidate))
    return result or None


def _increment(record, name):
    if record[name] >= _MAX_COUNTER:
        _unsupported("counter_overflow")
    else:
        record[name] += 1


def _selection(config):
    option = config.option

    def option_list(name):
        value = getattr(option, name, None)
        if value is None:
            return []
        if not isinstance(value, (list, tuple)) or len(value) > _MAX_FILES:
            _unsupported("selection_overflow")
            return []
        result = [_text(item) for item in value]
        if sum(len(item) for item in result) > 16384:
            _unsupported("selection_overflow")
            return []
        return result

    return {"keyword": _text(getattr(option, "keyword", "")),
            "markexpr": _text(getattr(option, "markexpr", "")),
            "collectonly": bool(getattr(option, "collectonly", False)),
            "lf": bool(getattr(option, "lf", False)),
            "stepwise": bool(getattr(option, "stepwise", False)),
            "ignore": option_list("ignore"),
            "ignoreGlob": option_list("ignore_glob"),
            "deselect": option_list("deselect")}


def _snapshot(items):
    if len(items) > _MAX_ITEMS:
        _unsupported("item_overflow")
        return None
    total = 0
    size = 0
    for item in items:
        nodeid = _text(item.nodeid)
        encoded = nodeid.encode("utf-8")
        size += len(encoded)
        if size > _MAX_NODE_BYTES:
            _unsupported("item_overflow")
            return None
        total = (total + int.from_bytes(hashlib.sha256(encoded).digest(), "big")) % (1 << 256)
    # A commutative digest detects selection changes without rejecting reordering.
    return (len(items), total)


def _distributed(config):
    if (hasattr(config, "workerinput") or
            getattr(config.option, "numprocesses", None) not in (None, 0) or
            getattr(config.option, "dist", "no") not in (None, "no")):
        _unsupported("distributed_execution")


def _write_receipt(session, exitstatus):
    temporary = _identity["reportPath"] + ".tmp"
    created = False
    try:
        config = session.config
        _distributed(config)
        selection = _selection(config)
        files = []
        for file in sorted(_state["files"]):
            record = dict(_state["files"][file])
            record.update({"passed": 0, "skipped": 0, "failed": 0})
            files.append(record)
        by_path = {record["path"]: record for record in files}
        for node in _state["nodes"].values():
            record = by_path[node["path"]]
            if node["failed"]:
                _increment(record, "failed")
            elif node["skipped"]:
                _increment(record, "skipped")
            elif node["passed"]:
                _increment(record, "passed")
        receipt = {"schemaVersion": 1, "executionId": _identity["executionId"],
                   "nonce": _identity["nonce"], "commandDigest": _identity["commandDigest"],
                   "cwd": _path(os.getcwd()), "rootPath": _path(config.rootpath),
                   "configPath": _path(config.inipath) if config.inipath is not None else None,
                   "pytestVersion": _text(pytest.__version__),
                   "collectionCompleted": _state["collectionCompleted"],
                   "selection": selection, "files": files, "exitStatus": int(exitstatus)}
        if _state["unsupported"] is not None:
            receipt["unsupported"] = _state["unsupported"]
        payload = json.dumps(receipt, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > _MAX_REPORT_BYTES:
            receipt["unsupported"] = "receipt_overflow"
            receipt["files"] = []
            payload = json.dumps(receipt, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > _MAX_REPORT_BYTES:
            return
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, _identity["reportPath"])
        created = False
    except Exception:
        # An unavailable receipt is unverified. Observation must not turn a passing
        # test run into a pytest infrastructure failure or expose test contents.
        _unsupported("observer_write_failed")
    finally:
        if created:
            try:
                os.unlink(temporary)
            except OSError:
                pass


@pytest.hookimpl(tryfirst=True)
def pytest_sessionstart(session):
    try:
        _state["sessions"] += 1
        _distributed(session.config)
        if _state["sessions"] != 1:
            _unsupported("repeated_sessions")
            _state["collectionCompleted"] = False
            # Invalidate the earlier session's receipt before another session runs.
            try:
                os.unlink(_identity["reportPath"])
            except FileNotFoundError:
                pass
            _write_receipt(session, -1)
    except Exception:
        _unsupported("observer_session_failed")


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_collection_modifyitems(session, config, items):
    before = None
    try:
        before = _snapshot(items)
    except Exception:
        _unsupported("observer_collection_failed")
    yield
    try:
        after = _snapshot(items)
        if before != after:
            _unsupported("collection_selection_changed")
        _state["selectionFingerprint"] = after
    except Exception:
        _unsupported("observer_collection_failed")


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_collection_finish(session):
    yield
    try:
        if _snapshot(session.items) != _state["selectionFingerprint"]:
            _unsupported("collection_selection_changed")
        if len(session.items) > _MAX_ITEMS:
            _unsupported("item_overflow")
            return
        for item in session.items:
            file = _path(item.path)
            if file is None:
                continue
            if file not in _state["files"]:
                if len(_state["files"]) >= _MAX_FILES:
                    _unsupported("file_overflow")
                    break
                _state["files"][file] = {"path": file, "collected": 0}
            nodeid = _text(item.nodeid)
            _state["nodeBytes"] += len(nodeid.encode("utf-8"))
            if _state["nodeBytes"] > _MAX_NODE_BYTES:
                _unsupported("item_overflow")
                break
            if nodeid in _state["nodes"]:
                _unsupported("repeated_test_identity")
                continue
            _increment(_state["files"][file], "collected")
            _state["nodes"][nodeid] = {"path": file, "phases": set(),
                                     "passed": False, "skipped": False, "failed": False}
        _state["collectionCompleted"] = True
    except Exception:
        _unsupported("observer_collection_failed")


@pytest.hookimpl(trylast=True)
def pytest_runtest_logreport(report):
    try:
        node = _state["nodes"].get(report.nodeid)
        if node is None:
            _unsupported("uncollected_test_report")
            return
        if report.when not in ("setup", "call", "teardown") or report.when in node["phases"]:
            _unsupported("repeated_or_custom_test_report")
            return
        node["phases"].add(report.when)
        if report.failed:
            node["failed"] = True
        elif report.skipped:
            node["skipped"] = True
        elif report.when == "call" and report.passed:
            node["passed"] = True
    except Exception:
        _unsupported("observer_report_failed")


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_sessionfinish(session, exitstatus):
    yield
    _write_receipt(session, session.exitstatus)
`
}
