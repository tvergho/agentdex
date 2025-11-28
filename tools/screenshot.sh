#!/bin/bash
#
# screenshot.sh - Capture terminal screenshots of dex commands
#
# Uses vhs (https://github.com/charmbracelet/vhs) to run dex commands
# in a virtual terminal and capture PNG screenshots.
#
# INSTALLATION:
#   brew install vhs
#
# USAGE:
#   ./tools/screenshot.sh <command> [output.png]
#
# EXAMPLES:
#   ./tools/screenshot.sh "search test"              # Screenshot search results
#   ./tools/screenshot.sh "list" list.png            # Screenshot list view
#   ./tools/screenshot.sh "search api" api-search.png
#
# OPTIONS:
#   command   - The dex subcommand to run (e.g., "search test", "list", "show <id>")
#   output    - Output PNG path (default: /tmp/dex-screenshot.png)
#
# The script will:
#   1. Run the command in a virtual terminal
#   2. Wait for it to render
#   3. Capture a screenshot
#   4. Send 'q' to quit
#   5. Open the screenshot (macOS only)

set -e

# Configuration
DEX_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_OUTPUT="/tmp/dex-screenshot.png"
WAIT_TIME="7s"
WIDTH=1200
HEIGHT=800
FONT_SIZE=14

# Parse arguments
COMMAND="${1:-}"
OUTPUT="${2:-$DEFAULT_OUTPUT}"

if [ -z "$COMMAND" ]; then
    echo "Usage: $0 <command> [output.png]"
    echo ""
    echo "Examples:"
    echo "  $0 \"search test\"           # Screenshot search results"
    echo "  $0 \"list\"                   # Screenshot list view"
    echo "  $0 \"search api\" api.png     # Custom output path"
    exit 1
fi

# Check for vhs
if ! command -v vhs &> /dev/null; then
    echo "Error: vhs is not installed"
    echo "Install with: brew install vhs"
    exit 1
fi

# Create temporary tape file
TAPE=$(mktemp /tmp/dex-tape-XXXXXX.tape)
GIF_OUTPUT=$(mktemp /tmp/dex-gif-XXXXXX.gif)

cleanup() {
    rm -f "$TAPE" "$GIF_OUTPUT"
}
trap cleanup EXIT

cat > "$TAPE" << EOF
Output "$GIF_OUTPUT"
Set Width $WIDTH
Set Height $HEIGHT
Set FontSize $FONT_SIZE

Type "cd $DEX_DIR && bun run dev $COMMAND"
Enter
Sleep $WAIT_TIME
Screenshot "$OUTPUT"
Type "q"
Sleep 500ms
EOF

echo "Capturing: bun run dev $COMMAND"
echo "Output: $OUTPUT"
echo ""

vhs "$TAPE" 2>&1 | grep -v "^Host your GIF" || true

if [ -f "$OUTPUT" ]; then
    echo ""
    echo "Screenshot saved: $OUTPUT"

    # Open in Preview on macOS
    if [ "$(uname)" = "Darwin" ]; then
        open "$OUTPUT" 2>/dev/null || true
    fi
else
    echo "Error: Failed to create screenshot"
    exit 1
fi
