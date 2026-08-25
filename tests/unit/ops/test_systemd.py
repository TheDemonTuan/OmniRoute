"""Regression tests for the Telegram ops bot systemd unit."""

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
UNIT_PATH = ROOT / "infra" / "systemd" / "omniroute-ops-bot.service"


class TestOpsBotSystemd(unittest.TestCase):
    def test_sandbox_does_not_block_allowlisted_sudo_helper(self) -> None:
        unit = UNIT_PATH.read_text(encoding="utf-8")

        self.assertIn("NoNewPrivileges=no", unit)
        self.assertIn("RestrictSUIDSGID=no", unit)
        self.assertNotIn("SystemCallArchitectures=", unit)
        self.assertNotIn("RestrictAddressFamilies=", unit)

        for directive in (
            "PrivateDevices",
            "ProtectKernelTunables",
            "ProtectKernelModules",
            "ProtectKernelLogs",
            "ProtectClock",
            "ProtectHostname",
            "LockPersonality",
            "MemoryDenyWriteExecute",
            "RestrictRealtime",
            "RestrictNamespaces",
        ):
            self.assertIn(f"{directive}=no", unit)


if __name__ == "__main__":
    unittest.main()
