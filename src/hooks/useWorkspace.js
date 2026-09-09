import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import JSZip from 'jszip';

export function useWorkspace() {
  const [projects, setProjects] = useState([]);
  const [currentProject, setCurrentProject] = useState(null);
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  // Self-dev's scoped preview needs to know which files the MOST RECENT turn
  // actually touched (not every file in the project — see PreviewPanel's
  // self-dev mode / generateSelfDevPrototype.js). `rev` increments on every
  // turn so a re-edit of the exact same path(s) still re-triggers the
  // preview effect (which keys off paths+rev, not just paths). Harmless,
  // unused by every non-self-dev project.
  const [lastTouched, setLastTouched] = useState({ paths: [], rev: 0 });
  // 2026-09-03 (Rob: stream progress + an ETA in the chat window) — the
  // ordered list of pipeline stages for the in-flight chat turn, fed by
  // base44.functions.invokeStream's onStage callback in sendMessage below.
  // Each entry: { stage, label, status: 'active'|'done', etaSeconds,
  // elapsedSeconds, startedAt } — startedAt is a client-side Date.now(),
  // used only to tick a live "~Ns remaining" countdown while status is
  // 'active' (see MorpheusPipelineStatus.jsx). Empty whenever no chat turn
  // is in flight, or during the brief moment before the first real stage
  // event arrives (ChatPanel falls back to the old decorative spinner then).
  const [pipelineStages, setPipelineStages] = useState([]);
  // CONTEXT ⇄ BUILD mode (2026-09-08). 'context' = Morpheus discusses and
  // plans in one fast pass, never runs the build pipeline or touches files;
  // 'build' = the full planner→coder→reviewer flow (the existing default,
  // so anyone who never touches the toggle is unaffected). Persisted
  // per-project in localStorage — a workflow preference, not project data,
  // so it deliberately doesn't need a DB column or migration.
  const [chatMode, setChatModeState] = useState('build');
  // WEB toggle (2026-09-09) — let Morpheus search the web + read pasted URLs
  // before planning a build. Persisted per-project like chatMode; the backend
  // no-ops it unless TAVILY_API_KEY is set. Default off.
  const [webAccess, setWebAccessState] = useState(false);

  const loadProjects = useCallback(async () => {
    const data = await base44.entities.Project.list('-created_date', 50);
    setProjects(data);
  }, []);

  const loadFiles = useCallback(async (projectId) => {
    const data = await base44.entities.ProjectFile.filter({ project_id: projectId }, 'path');
    setFiles(data.filter(f => !f.path.startsWith('backend/') && !f.path.startsWith('external/')));
  }, []);

  const loadMessages = useCallback(async (projectId) => {
    const data = await base44.entities.ChatMessage.filter({ project_id: projectId }, 'created_date', 100);
    setMessages(data);
  }, []);

  const loadSnapshots = useCallback(async (projectId) => {
    const data = await base44.entities.FileSnapshot.filter({ project_id: projectId }, '-created_date', 50);
    setSnapshots(data);
  }, []);

  const selectProject = useCallback(async (project) => {
    setCurrentProject(project);
    setSelectedFile(null);
    setMessages([]);
    setFiles([]);
    setLastTouched({ paths: [], rev: 0 });
    try {
      const saved = localStorage.getItem(`morpheus_chat_mode_${project.id}`);
      setChatModeState(saved === 'context' || saved === 'build' ? saved : 'build');
      setWebAccessState(localStorage.getItem(`morpheus_web_access_${project.id}`) === '1');
    } catch { setChatModeState('build'); setWebAccessState(false); }
    await Promise.all([loadFiles(project.id), loadMessages(project.id), loadSnapshots(project.id)]);
  }, [loadFiles, loadMessages, loadSnapshots]);

  const setChatMode = useCallback((m) => {
    const next = m === 'context' ? 'context' : 'build';
    setChatModeState(next);
    setCurrentProject((proj) => {
      if (proj) { try { localStorage.setItem(`morpheus_chat_mode_${proj.id}`, next); } catch { /* storage unavailable */ } }
      return proj;
    });
  }, []);

  const setWebAccess = useCallback((on) => {
    setWebAccessState(!!on);
    setCurrentProject((proj) => {
      if (proj) { try { localStorage.setItem(`morpheus_web_access_${proj.id}`, on ? '1' : '0'); } catch { /* storage unavailable */ } }
      return proj;
    });
  }, []);

  const deselectProject = useCallback(() => {
    setCurrentProject(null);
    setFiles([]);
    setSelectedFile(null);
    setMessages([]);
    setSnapshots([]);
    setLastTouched({ paths: [], rev: 0 });
  }, []);

  const deleteProject = useCallback(async (project) => {
    // Optimistically remove the project from the list immediately for a snappy
    // UI, then persist the deletions. On any failure, roll back to the full
    // previous list state and rethrow so the caller can surface the error.
    const snapshot = projects;
    setProjects(prev => prev.filter(p => p.id !== project.id));
    try {
      await base44.entities.ProjectFile.deleteMany({ project_id: project.id });
      await base44.entities.ChatMessage.deleteMany({ project_id: project.id });
      await base44.entities.FileSnapshot.deleteMany({ project_id: project.id });
      await base44.entities.Project.delete(project.id);
    } catch (e) {
      setProjects(snapshot);
      throw e;
    }
  }, [projects]);

  const createProject = useCallback(async (name, description, compileTarget) => {
    const project = await base44.entities.Project.create({ name, description, status: 'init', compile_target: compileTarget || 'source' });
    setProjects(prev => [project, ...prev]);
    await selectProject(project);
    return project;
  }, [selectProject]);

  const updateCompileTarget = useCallback(async (target) => {
    if (!currentProject) return;
    await base44.entities.Project.update(currentProject.id, { compile_target: target });
    setCurrentProject(prev => ({ ...prev, compile_target: target }));
  }, [currentProject]);

  const togglePolishUi = useCallback(async () => {
    if (!currentProject) return;
    const next = !currentProject.polish_ui;
    await base44.entities.Project.update(currentProject.id, { polish_ui: next });
    setCurrentProject(prev => ({ ...prev, polish_ui: next }));
  }, [currentProject]);

  const sendMessage = useCallback(async (text, fileUrls, forceSend, focusPaths) => {
    if (!currentProject || !text.trim() || (loading && !forceSend)) return;
    const displayContent = fileUrls && fileUrls.length > 0
      ? `${text}\n\n[Attached: ${fileUrls.length} reference file(s)]`
      : text;
    const userMsg = { id: 'temp-' + Date.now(), role: 'user', content: displayContent, project_id: currentProject.id };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    setPipelineStages([]);
    try {
      // focusPaths: only meaningful for self-dev projects (which files' full
      // content chatWithMorpheus should show the AI, on top of a whole-repo
      // path listing) — see chatWithMorpheus.js. Harmless no-op for every
      // other project type, which still gets full content for all files.
      //
      // invokeStream (not invoke) — chatWithMorpheus.js streams real
      // {type:'stage',...} progress events for each pipeline phase as they
      // actually happen, which onStage below turns into pipelineStages for
      // ChatPanel/MorpheusPipelineStatus to render as a step list with a
      // live ETA. See base44Client.js's invokeStream for the wire format.
      const onStage = (evt) => {
        setPipelineStages(prev => {
          if (evt.status === 'start') {
            return [...prev, { stage: evt.stage, label: evt.label, status: 'active', etaSeconds: evt.etaSeconds, startedAt: Date.now() }];
          }
          // 'done' — flip the matching active entry; leave completed ones as-is.
          return prev.map(s => (s.stage === evt.stage && s.status === 'active')
            ? { ...s, status: 'done', elapsedSeconds: evt.elapsedSeconds }
            : s);
        });
      };
      const res = await base44.functions.invokeStream('chatWithMorpheus', { projectId: currentProject.id, message: text, fileUrls: fileUrls || [], focusPaths: focusPaths || [], mode: chatMode, webAccess }, onStage);
      const morpheusMsg = { id: 'm-' + Date.now(), role: 'morpheus', content: res.data.reply, project_id: currentProject.id };
      setMessages(prev => [...prev, morpheusMsg]);
      if (res.data.fileOperations?.length > 0) {
        await loadFiles(currentProject.id);
        setLastTouched(prev => ({ paths: res.data.fileOperations.map(op => op.path).filter(Boolean), rev: prev.rev + 1 }));
      }
    } catch (e) {
      setMessages(prev => [...prev, { id: 'e-' + Date.now(), role: 'morpheus', content: '// SYSTEM FAILURE: ' + e.message, project_id: currentProject.id }]);
    } finally {
      setLoading(false);
      setPipelineStages([]);
    }
  }, [currentProject, loading, loadFiles, chatMode]);

  const exportProject = useCallback(async () => {
    if (!currentProject) return;
    const allFiles = await base44.entities.ProjectFile.filter({ project_id: currentProject.id });
    const zip = new JSZip();
    allFiles.forEach(f => zip.file(f.path, f.content));
    const slug = currentProject.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!allFiles.find(f => f.path === 'package.json')) {
      zip.file('package.json', JSON.stringify({ name: slug, version: '1.0.0', description: currentProject.description || '', scripts: { start: 'node index.js' } }, null, 2));
    }
    if (!allFiles.find(f => f.path === 'README.md')) {
      zip.file('README.md', `# ${currentProject.name}\n\n${currentProject.description || 'Generated by Morpheus.'}\n\n## Setup\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\`\n\n---\n_Built with Morpheus. You own this code. No lock-in. No illusions._\n`);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug || 'construct'}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [currentProject]);

  const uploadToGithub = useCallback(async (repoName, isPrivate) => {
    if (!currentProject) return;
    const res = await base44.functions.invoke('uploadToGithub', { projectId: currentProject.id, repoName, isPrivate });
    return res.data;
  }, [currentProject]);

  const emailProjectFiles = useCallback(async (email) => {
    if (!currentProject) return;
    const allFiles = await base44.entities.ProjectFile.filter({ project_id: currentProject.id });
    const zip = new JSZip();
    allFiles.forEach(f => zip.file(f.path, f.content));
    const slug = currentProject.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!allFiles.find(f => f.path === 'package.json')) {
      zip.file('package.json', JSON.stringify({ name: slug, version: '1.0.0', description: currentProject.description || '', scripts: { start: 'node index.js' } }, null, 2));
    }
    if (!allFiles.find(f => f.path === 'README.md')) {
      zip.file('README.md', `# ${currentProject.name}\n\n${currentProject.description || 'Generated by Morpheus.'}\n\n## Setup\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\`\n\n---\n_Built with Morpheus. You own this code. No lock-in. No illusions._\n`);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], `${slug || 'construct'}.zip`, { type: 'application/zip' });
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    await base44.functions.invoke('emailProjectFiles', { fileUrl: file_url, projectName: currentProject.name, email });
  }, [currentProject]);

  const restoreSnapshot = useCallback(async (snapshotId) => {
    if (!currentProject) return;
    await base44.functions.invoke('restoreSnapshot', { snapshotId });
    await loadFiles(currentProject.id);
    await loadSnapshots(currentProject.id);
    setLastTouched({ paths: [], rev: 0 });
  }, [currentProject, loadFiles, loadSnapshots]);

  // Undo the most recent prompt: restore the latest snapshot (state before
  // the last build) and drop the last user/morpheus message pair from the log.
  const revertLastPrompt = useCallback(async () => {
    if (!currentProject || !snapshots.length) return;
    const latest = snapshots[0];
    await base44.functions.invoke('restoreSnapshot', { snapshotId: latest.id });
    await loadFiles(currentProject.id);
    await loadSnapshots(currentProject.id);
    setLastTouched({ paths: [], rev: 0 });
    const fresh = await base44.entities.ChatMessage.filter({ project_id: currentProject.id }, 'created_date', 200);
    const lastUserIdx = fresh.map(m => m.role).lastIndexOf('user');
    if (lastUserIdx >= 0) {
      const toDelete = fresh.slice(lastUserIdx);
      for (const m of toDelete) {
        if (m.id) await base44.entities.ChatMessage.delete(m.id);
      }
      setMessages(fresh.slice(0, lastUserIdx));
    } else {
      setMessages(fresh);
    }
  }, [currentProject, snapshots, loadFiles, loadSnapshots]);

  const importFromGithub = useCallback(async (repoInput, compileTarget) => {
    const res = await base44.functions.invoke('importFromGithub', { repoInput, compileTarget });
    await loadProjects();
    if (res.data?.projectId) {
      const project = (await base44.entities.Project.list('-created_date', 50)).find(p => p.id === res.data.projectId);
      if (project) await selectProject(project);
    }
    return res.data;
  }, [loadProjects, selectProject]);

  const generateTests = useCallback(async (spec) => {
    if (!currentProject) return;
    try {
      const res = await base44.functions.invoke('generateTests', { projectId: currentProject.id, spec });
      if (res.data?.fileOperations?.length > 0) {
        await loadFiles(currentProject.id);
        await loadSnapshots(currentProject.id);
      }
      const morpheusMsg = { id: 'tests-' + Date.now(), role: 'morpheus', content: '[TESTS] ' + res.data.reply, project_id: currentProject.id };
      setMessages(prev => [...prev, morpheusMsg]);
      return res.data;
    } catch (e) {
      setMessages(prev => [...prev, { id: 'e-' + Date.now(), role: 'morpheus', content: '// TEST GENERATION FAILURE: ' + e.message, project_id: currentProject.id }]);
      throw e;
    }
  }, [currentProject, loadFiles, loadSnapshots]);

  const runAutonomousStep = useCallback(async (spec) => {
    if (!currentProject) return;
    try {
      const res = await base44.functions.invoke('autonomousBuildStep', { projectId: currentProject.id, spec });
      const morpheusMsg = { id: 'auto-' + Date.now(), role: 'morpheus', content: '[AUTONOMOUS] ' + res.data.reply, project_id: currentProject.id };
      setMessages(prev => [...prev, morpheusMsg]);
      if (res.data.fileOperations?.length > 0) {
        await loadFiles(currentProject.id);
      }
      await loadSnapshots(currentProject.id);
      return res.data;
    } catch (e) {
      setMessages(prev => [...prev, { id: 'e-' + Date.now(), role: 'morpheus', content: '// AUTONOMOUS FAILURE: ' + e.message, project_id: currentProject.id }]);
      return { isComplete: true, error: e.message };
    }
  }, [currentProject, loadFiles, loadSnapshots]);

  const updateDependencies = useCallback(async () => {
    if (!currentProject) return;
    try {
      const res = await base44.functions.invoke('updateDependencies', { projectId: currentProject.id });
      const morpheusMsg = { id: 'deps-' + Date.now(), role: 'morpheus', content: res.data.reply, project_id: currentProject.id };
      setMessages(prev => [...prev, morpheusMsg]);
      if (res.data.fileOperations?.length > 0) {
        await loadFiles(currentProject.id);
        await loadSnapshots(currentProject.id);
      }
      return res.data;
    } catch (e) {
      setMessages(prev => [...prev, { id: 'e-' + Date.now(), role: 'morpheus', content: '// DEPENDENCY UPDATE FAILURE: ' + e.message, project_id: currentProject.id }]);
      throw e;
    }
  }, [currentProject, loadFiles, loadSnapshots]);

  const compileProject = useCallback(async () => {
    if (!currentProject) return;
    const res = await base44.functions.invoke('compileProject', { projectId: currentProject.id });
    return res.data;
  }, [currentProject]);

  // Dry-run preview: returns the scaffolded files, workflow YAML, and artifact
  // spec without pushing to GitHub. Lets the user catch misconfigurations before
  // spending a real GitHub Actions run.
  const previewCompile = useCallback(async () => {
    if (!currentProject) return;
    const res = await base44.functions.invoke('compileProject', { projectId: currentProject.id, dryRun: true });
    return res.data;
  }, [currentProject]);

  const checkCompileStatus = useCallback(async (repoFullName) => {
    if (!currentProject) return;
    const res = await base44.functions.invoke('getCompileStatus', { repoFullName, target: currentProject.compile_target });
    return res.data;
  }, [currentProject]);

  // After a successful compile, download the release artifacts and save them
  // as ProjectFile records under _compiled/ so they appear in the file tree
  // as downloadable packages alongside the source code.
  const saveCompiledArtifacts = useCallback(async (repoFullName) => {
    if (!currentProject) return;
    try {
      const res = await base44.functions.invoke('saveCompiledArtifacts', { projectId: currentProject.id, repoFullName, target: currentProject.compile_target });
      if (res.data?.saved > 0) {
        await loadFiles(currentProject.id);
      }
      return res.data;
    } catch (e) {
      console.error('Failed to save compiled artifacts:', e?.message || e);
      return { error: e?.message || 'Failed to save artifacts' };
    }
  }, [currentProject, loadFiles]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  return { projects, currentProject, files, selectedFile, messages, loading, pipelineStages, chatMode, setChatMode, webAccess, setWebAccess, snapshots, lastTouched, selectProject, deselectProject, deleteProject, createProject, updateCompileTarget, sendMessage, exportProject, uploadToGithub, emailProjectFiles, restoreSnapshot, revertLastPrompt, runAutonomousStep, generateTests, importFromGithub, setSelectedFile, loadProjects, loadSnapshots, loadFiles, compileProject, previewCompile, checkCompileStatus, saveCompiledArtifacts, updateDependencies, togglePolishUi };
}