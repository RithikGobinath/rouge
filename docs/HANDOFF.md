# Development handoff

Recorded 2026-10-24.

## Repository history

main imports the current desktop source, then adds the Rouge product identity and sanitized context. Existing private runtime data is not part of this repository.

codex/audit-fixes preserves the candidate edits staged before publication. These edits are incomplete, unreviewed as a combined change, untested, and not deployed to the running application. They are a recovery point, not a finished patch.

## Audit work in progress

The full 16-item fix list is in AUDIT.md. All items remain open pending review and validation.

Candidate edits were divided across native privacy/control, helper recovery, document/calendar handling, and application integration. Partial application changes include placing panel routines in the cancellable request session, stricter confirmation responses, and verified legacy input targets. Candidate data changes include DOCX expansion bounds and preserving calendar time zones. Candidate native/runtime work includes private-field filtering, safer pointing captures, blocked-window transitions, helper timeout recovery and speech reinitialization.

Do not assume a candidate was finished because a file was copied into its stage. Some staged files are unchanged copies. The following integration patch was rejected before execution: destructive-key classification, hotkey parsing corrections, removal of the inactive search preference, and related settings changes. Completion-evidence enforcement and updated routing fixtures also still need work.

The last interruption came from automatic approval review being unable to complete after a usage limit was reached. It was not a finding that the code was unsafe. No workaround or partially reviewed install was performed.

## Resume procedure

1. Read this file, CONTEXT.md and AUDIT.md.
2. Compare codex/audit-fixes with main and inspect each candidate source with its callers.
3. Finish the open fixes without adding the planned browser integration or D watcher to the audit scope.
4. Check native helper/JavaScript compilation and author missing regression cases. Do not execute tests or desktop interactions unless the owner changes the testing instruction.
5. Review the complete change before applying it to the running application or merging it into main.

## Validation record

Before the audit, the computer-loop addition passed JavaScript syntax compilation and native C# compilation. The app and helper then started successfully. The flight scenario and tests were deliberately not run. Those checks do not validate the later audit candidates.

No tests, model requests, screenshots or desktop task trials were run as part of publishing this repository.
