#!/usr/bin/env python3
"""Show deploy vs test-wasm hashes and prove the test double is not in the deploy wasm."""
import hashlib
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parents[1]
paths = {
    "deploy_wasm": root / "out" / "chopgate_factory.wasm",
    "test_double_wasm": root / "out-test" / "chopgate_factory_test_double.wasm",
    "test_force_retry_wasm": root / "out-test" / "chopgate_factory_test_force_retry.wasm",
    "fixture": root / "tests" / "fixtures" / "gate_new_unreachable.wasm",
    "gate_wasm": root / "res" / "chopgate.wasm",
}
blobs = {name: path.read_bytes() for name, path in paths.items()}
expected_gate = "6e20ac13c62f77ecec9b6adbc48bf6cb52d818f9251ac797fc6581a0b18c1c1e"
expected_code_hash = "8Qtk3jf4RLpfiB7PeXeuPGYcp4USV2yeN5Zn3d5NpAMj"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    deploy = blobs["deploy_wasm"]
    double = blobs["test_double_wasm"]
    retry = blobs["test_force_retry_wasm"]
    fixture = blobs["fixture"]
    gate = blobs["gate_wasm"]
    fixture_in_deploy = fixture in deploy
    real_gate_in_deploy = gate in deploy
    print(f"deploy_wasm bytes={len(deploy)} sha256={sha(deploy)}")
    print(f"test_double_wasm bytes={len(double)} sha256={sha(double)}")
    print(f"test_force_retry_wasm bytes={len(retry)} sha256={sha(retry)}")
    print(f"fixture bytes={len(fixture)} sha256={sha(fixture)}")
    print(f"gate_wasm bytes={len(gate)} sha256={sha(gate)}")
    print(f"fixture_in_deploy={str(fixture_in_deploy).lower()}")
    print(f"real_gate_in_deploy={str(real_gate_in_deploy).lower()}")
    print(f"fixture_in_test_double={str(fixture in double).lower()}")
    print(f"real_gate_in_test_double={str(gate in double).lower()}")
    print(f"fixture_in_force_retry={str(fixture in retry).lower()}")
    print(f"real_gate_in_force_retry={str(gate in retry).lower()}")
    print(f"gate_sha256_ok={str(sha(gate) == expected_gate).lower()}")
    print(f"expected_gate_code_hash={expected_code_hash}")
    ok = (
        not fixture_in_deploy
        and real_gate_in_deploy
        and fixture in double
        and gate not in double
        and fixture not in retry
        and gate in retry
        and sha(gate) == expected_gate
        and sha(deploy) != sha(double)
        and sha(deploy) != sha(retry)
    )
    print(f"double_check_ok={str(ok).lower()}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
