# Firefox evaluation notes

The supported Firefox extension path uses DOM semantics on the same leased tab. It does not use the native WebDriver experiment as its runtime control path.

The November 5 baseline verified ordinary handoff, background form entry and a 45-second idle interval. The focused follow-up repaired the human-input test precondition and passed 11 handoff/concurrency/ownership checks. See [the validation record](VERIFY.md) for the exact boundary and reproduction commands.

The old native-protocol test's exit-status bug was fixed and checked with deliberately failing runs. Success in that experiment must not be presented as integrated native Firefox accessibility support.

This remains a temporary developer extension, not a signed store release. Arbitrary widgets, true system dialogs and long-duration behavior are outside the validated scope.
