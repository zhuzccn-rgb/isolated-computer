# Supported workflows

## Existing browser tab

The user explicitly leases a tab through the extension. The tab stays in its original window with its current form and page memory. The agent observes accessibility controls and applies semantic actions. Completion, unsupported operations or user return pause ownership; the extension provides take-back.

Chrome uses native AX with semantic DOM operations. Firefox uses a labelled DOM adapter. Live tabs reject pixel keyboard/mouse input because those operations can activate the user's window. A fresh `browser_*` task is a different, headless browser context and does not inherit a live tab's state.

## Independent native application

Launch applications inside the managed Linux Xvfb/D-Bus session. Use AT-SPI references where possible. A missing native click action can return `needs_pixel_action` and a screenshot; the click has not happened. Inspect the image, explicitly act inside the independent display, and observe again before resuming pending actions.

The local viewer supports exclusive human keyboard/mouse takeover. It pauses agent actions first; normal hand-back resumes them. Disconnect, hidden/lost focus and timeout release held keys but keep the agent paused.

This isolates display and input. It is not a filesystem/network sandbox. Arbitrary existing host application windows cannot be migrated into the independent session.

## Evidence

See [validation](VERIFY.md), [manual acceptance steps](ACCEPTANCE.md), and the [README](README.md) for installation and platform limits.
