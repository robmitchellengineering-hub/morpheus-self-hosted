// Ported from base44/shared/buildLogs.ts.
// Aggregates build log data from multiple entities for a project.
// Used by getBuildLogs backend function and uploadToGithub (to include BUILD_LOG.md in repos).
//
// Original signature was aggregateBuildLogs(base44, projectId) — the base44
// client carried the caller's auth context implicitly. Per PORTING_GUIDE.md's
// ownership-scoping rule (this wasn't an asServiceRole call in the original,
// so results must stay scoped to the requesting user), the signature here
// takes an explicit userId: aggregateBuildLogs(userId, projectId). Callers
// (getBuildLogs.js, uploadToGithub.js) should pass ctx.user.id.
import { prisma } from '../db.js';

// parseToolchain, ported from base44/shared/toolchain.ts. Inlined here
// (rather than imported from ./toolchain.js) because the already-ported
// lib/toolchain.js only exports buildToolchain, not parseToolchain.
function parseToolchain(metadata) {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed && parsed.sdk) {
      return {
        sdk: parsed.sdk,
        runtime: parsed.runtime,
        provider: parsed.provider,
        planner_model: parsed.planner_model,
        coder_model: parsed.coder_model,
        reviewer_model: parsed.reviewer_model,
        client_tools: parsed.client_tools,
      };
    }
  } catch {
    // metadata might be a plain string, not JSON
  }
  return null;
}

export async function aggregateBuildLogs(userId, projectId) {
  const [messages, snapshots, usageRecords] = await Promise.all([
    prisma.chatMessage.findMany({
      where: { project_id: projectId, created_by_id: userId },
      orderBy: { created_date: 'asc' },
      take: 500,
    }),
    prisma.fileSnapshot.findMany({
      where: { project_id: projectId, created_by_id: userId },
      orderBy: { created_date: 'asc' },
      take: 100,
    }),
    prisma.usageRecord.findMany({
      where: { project_id: projectId, created_by_id: userId },
      orderBy: { created_date: 'asc' },
      take: 500,
    }),
  ]);

  const logs = [];

  for (const m of messages) {
    logs.push({
      timestamp: m.created_date,
      type: 'chat',
      tool: m.role === 'user' ? 'operator_input' : 'morpheus_ai',
      role: m.role,
      details: m.content,
      credits: 0,
      toolchain: null,
    });
  }

  for (const s of snapshots) {
    let fileCount = 0;
    try { fileCount = s.files ? JSON.parse(s.files).length : 0; } catch {}
    logs.push({
      timestamp: s.created_date,
      type: 'snapshot',
      tool: 'file_snapshot',
      role: 'system',
      details: `Snapshot "${s.label}" captured — ${fileCount} files archived`,
      credits: 0,
      toolchain: null,
    });
  }

  for (const u of usageRecords) {
    // Diagnosis events get their own log type with rich structured details
    if (u.action_type === 'diagnosis') {
      logs.push({
        timestamp: u.created_date,
        type: 'diagnosis',
        tool: 'diagnosis',
        role: 'system',
        details: formatDiagnosisDetails(u.metadata),
        credits: u.credits || 0,
        toolchain: null,
      });
      continue;
    }

    // Parse toolchain manifest from metadata (SDK version, AI models, provider)
    const toolchain = parseToolchain(u.metadata);
    // Build a human-readable details string; if toolchain info is present,
    // surface it so the operator can see exactly what produced the output.
    let details = u.metadata || u.action_type;
    if (toolchain) {
      const models = [
        toolchain.planner_model && `planner: ${toolchain.planner_model}`,
        toolchain.coder_model && `coder: ${toolchain.coder_model}`,
        toolchain.reviewer_model && `reviewer: ${toolchain.reviewer_model}`,
      ].filter(Boolean).join(', ');
      details = `${u.action_type} | ${toolchain.sdk} | ${toolchain.provider}${models ? ' | ' + models : ''}`;
    }
    logs.push({
      timestamp: u.created_date,
      type: 'tool',
      tool: u.action_type,
      role: 'system',
      details,
      credits: u.credits || 0,
      toolchain,
    });
  }

  logs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return logs;
}

// Formats diagnosis metadata into a human-readable multi-line details string
// showing what was auto-fixed and what still needs user action.
function formatDiagnosisDetails(metadataStr) {
  try {
    const m = JSON.parse(metadataStr || '{}');
    const lines = [];
    const dtype = m.diagnosisType || m.phase || 'unknown';
    lines.push(`AI Diagnosis (${dtype})`);
    if (m.summary) lines.push(m.summary);
    if (m.allClear) lines.push('✓ All clear — safe to retry.');

    if (Array.isArray(m.autoFixed) && m.autoFixed.length > 0) {
      lines.push('');
      lines.push('AUTO-FIXED:');
      for (const f of m.autoFixed) {
        lines.push(`  [${f.component}] ${f.issue}`);
        lines.push(`    → ${f.fix} (${f.fileCount} file(s) regenerated)`);
      }
    }

    if (Array.isArray(m.needsAction) && m.needsAction.length > 0) {
      lines.push('');
      lines.push('NEEDS YOUR ACTION:');
      for (const a of m.needsAction) {
        lines.push(`  [${a.component}] ${a.issue} — ${a.label} (${a.severity})`);
      }
    }

    return lines.join('\n');
  } catch {
    return metadataStr || 'AI Diagnosis completed';
  }
}

export function generateBuildLogMarkdown(projectName, logs) {
  let md = `# Build Log — ${projectName}\n\n`;
  md += `> Auto-generated by Morpheus on ${new Date().toISOString()}\n`;
  md += `> Total build events: ${logs.length}\n\n`;
  md += `---\n\n`;
  for (const log of logs) {
    const ts = new Date(log.timestamp).toISOString();
    md += `## [${ts}] ${log.type.toUpperCase()} — ${log.tool}\n\n`;
    if (log.credits > 0) md += `**Credits used:** ${log.credits}\n\n`;
    if (log.toolchain) {
      md += `**Toolchain:**\n`;
      md += `- SDK: ${log.toolchain.sdk}\n`;
      md += `- Runtime: ${log.toolchain.runtime}\n`;
      md += `- Provider: ${log.toolchain.provider}\n`;
      if (log.toolchain.planner_model) md += `- Planner model: ${log.toolchain.planner_model}\n`;
      if (log.toolchain.coder_model) md += `- Coder model: ${log.toolchain.coder_model}\n`;
      if (log.toolchain.reviewer_model) md += `- Reviewer model: ${log.toolchain.reviewer_model}\n`;
      if (log.toolchain.client_tools) {
        md += `- Client tools: ${Object.entries(log.toolchain.client_tools).map(([k, v]) => `${k}@${v}`).join(', ')}\n`;
      }
      md += `\n`;
    }
    md += `### Details\n\n\`\`\`\n${log.details}\n\`\`\`\n\n---\n\n`;
  }
  return md;
}
