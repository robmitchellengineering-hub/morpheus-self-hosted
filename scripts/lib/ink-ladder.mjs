// MOVED to server/src/lib/inkLadder.js — see that file for the rules and the reasoning.
//
// This stays as a re-export so every existing caller keeps working unchanged, and
// so there is still exactly ONE copy of each rule. A second copy would be a rule
// that drifts from the one CI enforces, which is the failure this repo keeps
// refusing to accept.
export * from '../../server/src/lib/inkLadder.js';
