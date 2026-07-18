#!/usr/bin/env bash

if command -v timeout >/dev/null 2>&1; then
	timeout() { command timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
	timeout() { command gtimeout "$@"; }
else
	timeout() {
		perl -e '$seconds = shift; $SIG{ALRM} = sub { exit 124 }; alarm $seconds; exec @ARGV' "$@"
	}
fi
