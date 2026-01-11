#!/bin/bash

# Sample Backfill Script
#
# Quick helper to backfill a small sample of files for local development.
# This is useful when you just need a tiny dataset to code against.
#
# Usage:
#   ./scripts/sample-backfill.sh [prefix] [count]
#
# Examples:
#   ./scripts/sample-backfill.sh github/ 5
#   ./scripts/sample-backfill.sh cursor/ 3

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PREFIX="${1:-github/}"
COUNT="${2:-5}"

echo "Sample Backfill - Quick Local Data Population"
echo "=============================================="
echo "Prefix: $PREFIX"
echo "Sample size: $COUNT files"
echo ""
echo "This will help you select $COUNT files to index locally."
echo ""

# Use manual-index to let user select files
echo "Opening file selector. Please select $COUNT files:"
echo ""

# For now, just use the local-backfill script with instructions
echo "Option 1: Use manual-index to select specific files:"
echo "  ./scripts/manual-index.mjs $PREFIX"
echo ""
echo "Then use local-backfill with --keys:"
echo "  ./scripts/local-backfill.sh --keys KEY1,KEY2,KEY3"
echo ""
echo "Option 2: Use local-backfill with a prefix (will process all, but you can stop early):"
echo "  ./scripts/local-backfill.sh $PREFIX"
echo ""
