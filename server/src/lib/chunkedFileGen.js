// Shared multi-file chunked generation helper.
//
// 2026-09-03 postmortem (see chatWithMorpheus.js's Coder/Planner comments):
// a single invokeAI call asked to emit FULL content for an open-ended number
// of files is exactly the failure mode that caused three straight rounds of
// OUTPUT_TRUNCATED reports from Rob — first the Coder's cap, then (the real
// cause) the Planner's. chatWithMorpheus.js was fixed by having the Planner
// enumerate a `plannedFiles` list, then having the Coder implement it a few
// files at a time across several smaller calls instead of one big one.
//
// Auditing the rest of the AI pipeline (2026-09-03) turned up the same
// "generate every file in one shot" shape in generateTests.js and
// generateBackend.js, with no chunking and no explicit maxTokens at all —
// meaning they were relying on the provider's undocumented default the
// whole time, same as the bug that was just fixed. This module pulls the
// chunking logic out of chatWithMorpheus.js into something reusable so
// those call sites (and any future one) get the same protection without
// re-deriving the loop each time.
import { invokeAI } from '../ai.js';
import { isTruncation, truncationPlan, truncationOutcome } from './generationTruncation.js';

export const DEFAULT_FILES_PER_STEP = 3;
export const DEFAULT_STEP_MAX_TOKENS = 24000; // generous for 1-3 files' full content
export const DEFAULT_FALLBACK_MAX_TOKENS = 64000; // used only when plannedFiles is empty

/**
 * Generate `fileOperations` for a set of planned files, a few at a time, so
 * no single completion has to hold more than `filesPerStep` files' worth of
 * content. Falls back to one unscoped call (still with an explicit cap,
 * never omitted) when the caller has no file list to chunk by.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string[]} [opts.plannedFiles] — file paths to implement. Empty/absent -> single fallback call.
 * @param {(filesForThisStep: string[]|null, allPlannedFiles: string[], writtenSoFar: object[]) => string} opts.buildPrompt
 *   Returns the prompt for one call. Called once per chunk with that chunk's file list (plus the
 *   full planned list for context), or once with `null` when there's no plannedFiles to chunk by.
 *
 *   `writtenSoFar` is the third argument and is ADDITIVE (2026-09-29): the operations produced by all
 *   previous chunks, in order. It exists because chunking introduced a defect nobody had noticed — the
 *   model was asked for `server/db.js` in one call and `server/routes/tasks.js` in the next with no way
 *   to see the first, so a generated backend routinely disagreed with itself (three files, three ideas
 *   of what `db` was, measured on a real run). A caller that ignores the argument behaves exactly as
 *   before, which is why existing call sites needed no change.
 * @param {object} [opts.schema] — JSON schema for the response. Defaults to the standard
 *   `{ fileOperations: [{ path, content, action }] }` shape used across the codebase.
 * @param {string[]} [opts.fileUrls]
 * @param {string} [opts.role='coder']
 * @param {number} [opts.filesPerStep]
 * @param {number} [opts.stepMaxTokens]
 * @param {number} [opts.fallbackMaxTokens]
 * @returns {Promise<{fileOps: object[], model: string|undefined, provider: string|undefined, chunked: boolean,
 *   unwritten?: string[], truncationNote?: string|null}>}
 *   `unwritten` (additive) names files the model could not finish even one at a time — report them, never
 *   drop them silently. Absent on the fallback path, which has no file list to attribute a failure to.
 */
export async function generateFilesChunked({
  userId,
  plannedFiles,
  buildPrompt,
  schema,
  fileUrls,
  role = 'coder',
  filesPerStep = DEFAULT_FILES_PER_STEP,
  stepMaxTokens = DEFAULT_STEP_MAX_TOKENS,
  fallbackMaxTokens = DEFAULT_FALLBACK_MAX_TOKENS,
}) {
  const fileOpsSchema = schema || {
    type: 'object',
    properties: {
      fileOperations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            action: { type: 'string', enum: ['create', 'update', 'delete'] },
          },
        },
      },
    },
  };

  const cleanPlanned = Array.isArray(plannedFiles)
    ? plannedFiles.filter((p) => typeof p === 'string' && p)
    : [];

  const fileOps = [];
  let model;
  let provider;

  if (cleanPlanned.length > 0) {
    const chunks = [];
    for (let i = 0; i < cleanPlanned.length; i += filesPerStep) {
      chunks.push(cleanPlanned.slice(i, i + filesPerStep));
    }
    // Files whose completion was cut off even when asked for on their own. Reported to the caller rather
    // than dropped: a backend missing one file, and saying which, is usable and fixable; one that reports
    // success over a missing file is the failure this whole area keeps producing.
    const unwritten = [];

    for (const chunk of chunks) {
      const send = async (paths) => {
        const response = await invokeAI({
          userId,
          // The operations from every earlier chunk. A prompt builder that does not want them ignores the
          // third argument; one that does can keep the backend from contradicting itself.
          prompt: buildPrompt(paths, cleanPlanned, fileOps.slice()),
          schema: fileOpsSchema,
          fileUrls,
          role,
          maxTokens: stepMaxTokens,
        });
        model = response.model;
        provider = response.provider;
        return Array.isArray(response.result.fileOperations) ? response.result.fileOperations : [];
      };

      try {
        fileOps.push(...await send(chunk));
      } catch (err) {
        // An anticipated, recoverable condition — the pipeline has answered it this way since
        // 2026-09-29's measurement showed a chunk hitting the step cap exactly. Before this, the throw
        // propagated and the whole generation was lost, five successful calls included, because nothing
        // is persisted until the end. See lib/generationTruncation.js.
        if (!isTruncation(err)) throw err;
        const plan = truncationPlan(chunk);
        for (const onePath of plan.retry) {
          try {
            fileOps.push(...await send([onePath]));
          } catch (oneErr) {
            if (!isTruncation(oneErr)) throw oneErr;
            unwritten.push(onePath);
          }
        }
      }
    }
    const outcome = truncationOutcome({ unwritten });
    return { fileOps, model, provider, chunked: true, unwritten, truncationNote: outcome.note };
  }

  // No plannedFiles to chunk by — one unscoped call, still with an explicit
  // generous cap rather than omitting maxTokens (see ai.js's JSDoc).
  const response = await invokeAI({
    userId,
    prompt: buildPrompt(null, []),
    schema: fileOpsSchema,
    fileUrls,
    role,
    maxTokens: fallbackMaxTokens,
  });
  return {
    fileOps: Array.isArray(response.result.fileOperations) ? response.result.fileOperations : [],
    model: response.model,
    provider: response.provider,
    chunked: false,
  };
}
