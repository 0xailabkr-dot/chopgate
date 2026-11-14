#!/bin/sh
# Rust 1.86.0 and the wasm32-unknown-unknown target are required; no secrets.
# CARGO_HOME and CARGO_TARGET_DIR are left as the caller set them.
# If either is unset, this file does not assign a machine-local default.
# No toolchain file is sourced.
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_TEST_DEBUG=0
export CARGO_INCREMENTAL=0
unset TYPESAFE_API_KEY
unset JEV_KEY_FILE
