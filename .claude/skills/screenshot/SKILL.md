---
name: screenshot
description: Capture PNG screenshots of dex TUI commands for debugging UI layout issues. Use when iterating on CLI interface code or debugging rendering problems.
---

# Screenshot Tool

Capture screenshots of dex TUI commands using vhs.

## Instructions

1. Run the screenshot tool with a dex command:
   ```bash
   ./tools/screenshot.sh "<command>"
   ```

2. Read the output file to view the captured TUI:
   ```bash
   # Default output is /tmp/dex-screenshot.png
   ```

3. Use the Read tool on the PNG file to see the rendered UI.

## Examples

```bash
# Screenshot search results
./tools/screenshot.sh "search test"

# Screenshot list view
./tools/screenshot.sh "list"

# Custom output path
./tools/screenshot.sh "search api" /tmp/api-search.png
```

## Workflow

1. Make changes to TUI code in `src/cli/commands/`
2. Run screenshot tool to capture the result
3. Read the PNG to view the rendered UI
4. Iterate based on what you see

## Requirements

Requires vhs: `brew install vhs`
