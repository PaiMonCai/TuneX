"""Cheap helper contracts, NOT a substitute for the real network acceptance."""
import ast
from pathlib import Path
import re
import types
import unittest
from unittest.mock import Mock


SOURCE = Path(__file__).resolve().parents[1] / "native-both.py"


class NativeBothHarnessContracts(unittest.TestCase):
    def setUp(self):
        # Execute the actual helpers without importing the Linux/Docker harness
        # (which is intentionally unavailable on the Windows developer host).
        tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
        definitions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                       and node.name in ("agent_sh", "safe_code", "request")]
        self.harness = types.SimpleNamespace(INGRESS_CONTAINER="fixture-ingress", docker=Mock(return_value="socket facts"),
                                             req=Mock(), unwrap=lambda obj: obj.get("data", obj))
        self.ns = {"H": self.harness, "re": re}
        exec(compile(ast.Module(body=definitions, type_ignores=[]), str(SOURCE), "exec"), self.ns)

    def test_shell_uses_existing_docker_contract_and_targets_ingress(self):
        self.assertEqual(self.ns["agent_sh"]("netstat -uln"), "socket facts")
        self.harness.docker.assert_called_once_with(
            ["exec", "fixture-ingress", "sh", "-c", "netstat -uln"], allow=False)

    def test_fault_cleanup_forwards_allow_flag(self):
        self.ns["agent_sh"]("cleanup-known-fixture", allow=True)
        self.harness.docker.assert_called_once_with(
            ["exec", "fixture-ingress", "sh", "-c", "cleanup-known-fixture"], allow=True)
        self.assertNotIn("H.agent_sh", SOURCE.read_text(encoding="utf-8"))

    def test_failed_request_retains_codes_without_publishing_raw_error(self):
        self.harness.req.return_value = (502, {"code": "apply_failed", "apply_error_code": "agent_rejected",
                                              "error": "private-host address already in use credential-value"}, None)
        with self.assertRaises(RuntimeError) as caught:
            self.ns["request"]("PATCH", "/api/forwards/1", {})
        self.assertIn("agent_rejected", str(caught.exception))
        self.assertIn("address already in use", str(caught.exception))
        self.assertNotIn("private-host", str(caught.exception))
        self.assertNotIn("credential-value", str(caught.exception))
        self.assertEqual(self.ns["safe_code"]("raw error\ncredential"), "unknown")


if __name__ == "__main__":
    unittest.main()
