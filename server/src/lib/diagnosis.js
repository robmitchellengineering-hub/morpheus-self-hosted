// Shared diagnosis utilities used by the unified Morpheus diagnosis agent.
// Categorizes errors, builds LLM prompts, and applies file fixes across
// all issue types (deploy, compile, github, build).

import { prisma } from '../db.js';

export function detectLanguage(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    sql: 'sql', toml: 'toml', yml: 'yaml', yaml: 'yaml', json: 'json',
    md: 'markdown', env: 'bash', dockerfile: 'dockerfile',
    py: 'python', html: 'html', css: 'css', sh: 'bash'
  };
  return map[ext] || 'text';
}

// Categorize a raw error message into credential vs code-level
export function isCredentialError(message) {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes('credentials not configured') ||
    m.includes('not configured') ||
    m.includes('project ref not configured') ||
    m.includes('access token not set') ||
    m.includes('api token') && m.includes('missing') ||
    m.includes('unauthorized') && m.includes('token');
}

export function isAuthError(message) {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes('github connection') ||
    m.includes('not connected') ||
    m.includes('not authenticated') ||
    m.includes('401') && m.includes('github') ||
    m.includes('connect your github');
}

// Build the standard action plan for credential gaps
export function buildCredentialAction(component, label) {
  return {
    component,
    label,
    issue: 'Missing credentials',
    steps: [
      'Go to Settings → Connections',
      `Find ${label} and enter your API credentials`,
      'Return here and retry the operation'
    ],
    link: '/settings',
    severity: 'credentials'
  };
}

// Apply regenerated files to the project, updating existing or creating new
export async function applyFileFixes(userId, projectId, existingFiles, fixes) {
  const autoFixed = [];
  const seenPaths = new Set(); // dedup within this call — LLM may return the same path twice
  for (const fix of (fixes || [])) {
    let fileCount = 0;
    for (const file of (fix.files || [])) {
      const fullPath = file.path.includes('/') ? file.path : `${fix.component || 'src'}/${file.path}`;
      if (seenPaths.has(fullPath)) continue; // skip duplicate path
      seenPaths.add(fullPath);
      const existing = existingFiles.find(f => f.path === fullPath);
      if (existing) {
        await prisma.projectFile.update({
          where: { id: existing.id },
          data: {
            content: file.content,
            language: detectLanguage(file.path)
          }
        });
      } else {
        await prisma.projectFile.create({
          data: {
            created_by_id: userId,
            project_id: projectId,
            path: fullPath,
            content: file.content,
            language: detectLanguage(file.path)
          }
        });
      }
      fileCount++;
    }
    autoFixed.push({
      component: fix.component || 'general',
      issue: fix.issue,
      fix: fix.fix,
      fileCount
    });
  }
  return autoFixed;
}

// The JSON schema for LLM fix responses
export const fixResponseSchema = {
  type: 'object',
  properties: {
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          component: { type: 'string' },
          issue: { type: 'string' },
          fix: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content']
            }
          }
        },
        required: ['component', 'issue', 'fix', 'files']
      }
    },
    summary: { type: 'string' }
  },
  required: ['fixes', 'summary']
};
