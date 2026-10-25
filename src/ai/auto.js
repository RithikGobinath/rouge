'use strict';
// Cursor-style Auto for the Claude pool. A local check picks one role before
// any model call, the way Cursor Router classifies a request and sends it once.
// Cost bias: Haiku when it can finish, Sonnet for ordinary or live work,
// Opus only for unusually hard reasoning. D is not part of this pool.

const HARD = /\b(prove|formal proof|root cause|security review|trade-?offs?)\b/i;
const LIVE = /\b(https?:\/\/|www\.|latest|current news|price|who is the|look up|search the web|verify online)\b/i;
const SCREEN = /\b(chrome|edge|firefox|brave|browser|google flights|on (?:the |my )?(?:screen|computer)|desktop)\b/i;
const INTERACTIVE = /\b(flight|flights|compare|search|fill|click|check|results|form|fare|website|webpage)\b/i;
// Multi-step desktop navigation: 'open X and do Y', 'show me where', 'navigate to', 'go to [setting]', 'find X in [app]'.
// Deliberately excludes single-step commands like 'open notepad' (no 'and verb' or 'show me where').
const NAVIGATE = /(?:open\b.{1,80}\band\s+(?:show|go|navigate|find|change|enable|disable|update|set|do|configure|adjust|toggle|turn)\b)|\bshow\s+me\s+(?:where|how\s+to)\b|\bshow\s+me\s+the\b|\bnavigate\s+to\b|\bgo\s+to\b.{0,60}\b(?:settings?|control\s+panel|panel|section|menu|preference|option)\b|\bfind\b.{1,60}\bin\b.{1,40}\b(?:settings?|app|control\s+panel|system)\b|\bpoint\s+(?:to|at)\b|\bwhere\s+is\s+(?:the\s+)?\b|\bhighlight\b/i;

/**
 * @param {{task:string, user?:string, goal?:string, webAccess?:boolean}} input
 * @returns {{role:'A'|'B'|'C', mode:'reply'|'computer'}}
 */
function pickAuto({ task, user = '', goal = '', webAccess = true }) {
  // Intent is read from the user's actual utterance (goal) only.
  // The full `user` string includes front-window names, app lists, and folder
  // context that falsely trigger SCREEN/INTERACTIVE — e.g. "Front window: Chrome"
  // makes every request look like a browser task.
  const intent = String(goal || user).slice(0, 2000);
  const hard = HARD.test(intent);
  const interactive = task === 'plan' && SCREEN.test(intent) && INTERACTIVE.test(intent);
  const navigate = task === 'plan' && NAVIGATE.test(intent);
  if (interactive || navigate) return { role: hard ? 'C' : 'B', mode: 'computer' };
  if (task !== 'explain' && webAccess && LIVE.test(intent)) return { role: hard ? 'C' : 'B', mode: 'reply' };
  if (hard) return { role: 'C', mode: 'reply' };
  return { role: 'A', mode: 'reply' };
}

module.exports = { pickAuto };
