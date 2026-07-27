#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 vX.Y.Z [CHANGELOG.md]" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

version="${1#v}"
release_file="${2:-CHANGELOG.md}"

if [[ ! -f "${release_file}" ]]; then
  echo "release notes file not found: ${release_file}" >&2
  exit 1
fi

awk -v version="${version}" '
  # Headings look like "## X.Y.Z — YYYY-MM-DD"; match on the version prefix.
  BEGIN {
    plain_heading = "## " version
    tagged_heading = "## v" version
  }

  $0 == plain_heading || $0 == tagged_heading ||
  index($0, plain_heading " ") == 1 || index($0, tagged_heading " ") == 1 {
    capture = 1
    found = 1
    print
    next
  }

  capture && /^## / {
    exit
  }

  capture {
    print
  }

  END {
    if (!found) {
      printf "release notes not found for v%s\n", version > "/dev/stderr"
      exit 1
    }
  }
' "${release_file}"
