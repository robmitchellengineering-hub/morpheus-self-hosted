// Shared diagnosis utilities used by the unified Morpheus diagnosis agent.
// Categorizes errors, builds LLM prompts, and applies file fixes across
// all issue types (deploy, compile, github, build).

export interface NeedsAction {
  component: string;
  label: string;
  issue: string;
  steps: string[];
  link?: string;
  severity: 'credentials' | 'manual' | 'config' | 'external';
}

export interface AutoFix {
  component: string;
  issue: string;
  fix: string;
  fileCount: number;
}

export interface Diagnosis {
  summary: string;
  autoFixed: AutoFix[];
  needsUserAction: NeedsAction[];
  totalErrors: number;
  allClear: boolean;
}

export function detectLanguage(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    sql: 'sql', toml: 'toml', yml: 'yaml', yaml: 'yaml', json: 'json',
    md: 'markdown', env: 'bash', dockerfile: 'dockerfile',
    py: 'python', html: 'html', css: 'css', sh: 'bash'
  };
  return map[ext] || 'text';
}

// Categorize a raw error message into credential vs code-level
export function isCredentialError(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes('credentials not configured') ||
    m.includes('not configured') ||
    m.includes('project ref not configured') ||
    m.includes('access token not set') ||
    m.includes('api token') && m.includes('missing') ||
    m.includes('unauthorized') && m.includes('token');
}

export function isAuthError(message: string | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes('github connection') ||
    m.includes('not connected') ||
    m.includes('not authenticated') ||
    m.includes('401') && m.includes('github') ||
    m.includes('connect your github');
}

// Build the standard action plan for credential gaps
export function buildCredentialAction(component: string, label: string): NeedsAction {
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
export async function applyFileFixes(base44: any, projectId: string, existingFiles: any[], fixes: any[]): Promise<AutoFix[]> {
  const autoFixed: AutoFix[] = [];
  const seenPaths = new Set<string>(); // dedup within this call — LLM may return the same path twice
  for (const fix of (fixes || [])) {
    let fileCount = 0;
    for (const file of (fix.files || [])) {
      const fullPath = file.path.includes('/') ? file.path : `${fix.component || 'src'}/${file.path}`;
      if (seenPaths.has(fullPath)) continue; // skip duplicate path
      seenPaths.add(fullPath);
      const existing = existingFiles.find(f => f.path === fullPath);
      if (existing) {
        await base44.entities.ProjectFile.update(existing.id, {
          content: file.content,
          language: detectLanguage(file.path)
        });
      } else {
        await base44.entities.ProjectFile.create({
          project_id: projectId,
          path: fullPath,
          content: file.content,
          language: detectLanguage(file.path)
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