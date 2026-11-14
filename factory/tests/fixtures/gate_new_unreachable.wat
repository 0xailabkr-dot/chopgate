;; Test-only gate double. The factory embeds this only with `--features test-gate-double`.
;; `new` traps immediately so a create batch fails inside `new` and reverts.
;; Bytes (hand-encoded, no wat2wasm) live in gate_new_unreachable.wasm.
(module
  (func (export "new")
    unreachable))
