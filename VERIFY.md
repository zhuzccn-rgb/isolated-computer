# Linux validation · November 5, 2026

This development preview has a Linux baseline and a focused follow-up. **The follow-up did not rerun the complete suite.** Earlier failures were retained during development, and the test-result handling issue described below was fixed in source.

| Check | Observed result | Scope |
|---|---|---|
| Chrome live-tab handoff | Passed baseline fixtures | Existing window/tab, draft state and page memory; background edits and simulated concurrent input on a private display. |
| GTK3 / GTK4 | Passed baseline checks | Chinese/emoji entry, native actions, unavailable controls, and exceptional screenshot fallback against actual application state. |
| GNOME Settings | Passed real application navigation | Read-only System/About navigation, native Back, screenshot fallback, suspended batch and explicit pixel continuation. |
| Desktop takeover | 20 baseline checks passed | Exclusive ownership, pause/return, held-key release, disconnect/loss of focus/timeout and a second viewer. |
| Firefox focused follow-up | **11 checks passed** | Physical input precondition, verified time overlap with background Chinese/English edits, focus/pointer sampling, pause and take-back. |
| Test-result handling | Unit and negative checks passed | Individual failed cases are detected; deliberately failing the protocol experiment returns exit status 1. |
| Real Linux host via RDP | Controlled English observation | Six lines retained while the independent GTK counter increased 120 times. Sampled screenshots showed stable editor focus and pointer; the saved file had an unexplained extra terminal newline. This is not an exact-byte pass or a long-term human-use study. |

Environment: Ubuntu 26.04.1 x86_64, host Wayland with independent Xvfb/D-Bus test sessions, Firefox 158.0, Playwright Chromium, GNOME Settings 50.3, GTK3/GTK4, and Node.js 24.22.1. Firefox's system Snap binaries were invoked directly in the private session; the complete Snap launcher path was not validated. Agent-assisted validation used Terra with extra-high reasoning.

## What the follow-up fixed

The original Firefox test considered the window-manager active-window state sufficient, even when the page reported `document.hasFocus() === false`. Its simulated human keystrokes did not reach the input field before any agent action.

The focused test now resolves the human browser handle before handing over the agent tab, switches to the correct human window, clicks its input and verifies a real physical `q` first. During the measured concurrent section, it sends physical keys and plugin MCP operations without refocusing. The human field, background field and sampled focus/pointer state are checked afterward. The run recorded 156 focus samples; transients shorter than the sampling interval are not excluded.

A separate Firefox native-protocol experiment could previously record failed cases but return exit status zero. The experiment now fails its process on failed/fatal cases, and the aggregate runner checks case failures. The experiment remains separate from the Firefox extension's implemented DOM adapter.

The affected Firefox tests also accept explicit environment paths and an optional version pin instead of requiring the original developer's temporary Openbox directory or Firefox 156.0.1.

## Reproduce the focused checks

After installing the dependencies in the README and building extensions:

```bash
node --test tests/report-validation.test.mjs
node tests/firefox-scenarios.mjs --concurrent-only
```

Use `IC_TEST_XVFB`, `IC_TEST_OPENBOX`, `IC_TEST_OPENBOX_LIB`, `IC_TEST_OPENBOX_DATA`, `IC_TEST_FIREFOX_BINARY`, and `IC_TEST_GECKODRIVER` where your system requires overrides. The default Firefox scenario path retains its broader handoff/ownership/idle checks; the focused flag skips unrelated idle and other scenarios.

The follow-up modified test infrastructure only. Runtime server, extension, desktop bridge and viewer implementations were unchanged. This supports combining its focused results with the earlier baseline; it is not a claim that every baseline check was rerun on the final checkout.

## Limits

Firefox uses a DOM adapter; custom trusted-event widgets, system dialogs and arbitrary sites may require human takeover. Real OS Chinese IME acceptance was excluded from this run because no input method was installed; independent-desktop Unicode entry was tested separately. No claim is made about Safari, Windows UIA, macOS AX, all-day reliability, all desktop environments or end-to-end performance preservation.

A sanitized machine-readable follow-up summary is in [test-results/linux-focused-2026-11-05.json](test-results/linux-focused-2026-11-05.json). Private session data, browser profiles, access tokens and raw local logs are not included.
