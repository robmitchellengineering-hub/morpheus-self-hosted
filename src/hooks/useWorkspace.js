import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import JSZip from 'jszip';
import { exportPlan } from '@/lib/exportPromise';

export function useWorkspace() {
  const [projects, setProjects] = useState([]);
  // A failed project load used to be invisible: loadProjects had no catch, so a
  // rejected request left `projects` as [] and the Workspace rendered "The
  // Matrix is empty. Create your first." — which reads as DATA LOSS. That is
  // exactly how the missing projects.synced_commit column (H11, 2026-09-19)
  // presented itself to Rob, who reasonably concluded his constructs were gone
  // when the real problem was a failing SELECT. An empty list and a broken list
  // must never look the same.
  const [loadError, setLoadError] = useState(null);
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
  // before a build or context turn. Persisted per-project like chatMode.
  // Free sources (Wikipedia / arXiv / llms.txt / direct fetch) always work; a
  // Gemini key adds grounded search. Defaults on for self-dev (set in
  // selectProject), off elsewhere.
  const [webAccess, setWebAccessState] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      const data = await base44.entities.Project.list('-created_date', 50);
      setProjects(data);
      setLoadError(null);
    } catch (e) {
      // Deliberately does not rethrow: callers `await loadProjects()` after
      // creating or importing a construct, and a failed *refresh* should
      // surface as a banner rather than blow up the action that just succeeded.
      setLoadError(e?.message || 'Could not load your constructs.');
    }
  }, []);

  const loadFiles = useCallback(async (projectId) => {
    const data = await base44.entities.ProjectFile.filter({ project_id: projectId }, 'path');
    setFiles(data.filter(f => !f.path.startsWith('backend/') && !f.path.startsWith('external/')));
  }, []);

  const loadMessages = useCallback(async (projectId) => {
    // Ascending sort + a limit fetches the OLDEST N rows, not the most
    // recent — the backend is a plain `orderBy` then `take` (see
    // entities.js), same as any SQL LIMIT. Past 100 total messages (any
    // actively-used project, self-dev fastest of all) this was silently
    // showing a stale, ancient slice of the conversation on every reload
    // instead of what actually just happened. Sort descending, take the
    // newest 100, then reverse back to chronological order for display —
    // same fix already applied server-side in chatWithMorpheus.js's own
    // history read, and in getChatHistory.js for the widget.
    const data = await base44.entities.ChatMessage.filter({ project_id: projectId }, '-created_date', 100);
    setMessages(data.reverse());
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
      // Self-dev defaults web research ON (it routinely needs current
      // library/API docs); other projects default off. An explicit saved
      // choice always wins.
      const savedWeb = localStorage.getItem(`morpheus_web_access_${project.id}`);
      setWebAccessState(savedWeb === '1' ? true : savedWeb === '0' ? false : project.project_type === 'self_dev');
    } catch { setChatModeState('build'); setWebAccessState(project.project_type === 'self_dev'); }
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

  // Renaming a construct. A new account's website construct is named from their
  // own name, so this is the first thing they may want to change — and it is a
  // plain field update, no backend work.
  const renameProject = useCallback(async (name) => {
    if (!currentProject) return null;
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean || clean === currentProject.name) return null;
    await base44.entities.Project.update(currentProject.id, { name: clean });
    setCurrentProject(prev => ({ ...prev, name: clean }));
    setProjects(prev => prev.map(p => (p.id === currentProject.id ? { ...p, name: clean } : p)));
    return clean;
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
    // A dropped connection (the phone's network blipping, a backend redeploy
    // restarting the API pod mid-request, or — the common real case — the
    // tab getting backgrounded, which suspends the streaming read and kills
    // the connection before the final line ever arrives) surfaces as a raw
    // error with no `.status`/`.data` — invokeStream never got a real
    // response to parse one from. That's different from the server actually
    // answering with an error (a real exception, insufficient credits, a
    // syntax-gate rejection), which always carries one or the other.
    //
    // Critically: chatWithMorpheus.js SAVES both messages to the DB (and
    // writes any files) BEFORE it ever streams the final line back — so a
    // connection dropped at exactly the wrong moment often means the turn
    // actually succeeded and only the client never heard about it. Retrying
    // blind risks a second full build (duplicate PR, doubled credit spend).
    // So on this failure, check reality first: reload the real message list
    // from the server, and only retry if it confirms nothing landed.
    const isBareNetworkFailure = (e) => !e?.status && !e?.data;
    const sentAt = Date.now();
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
      const attempt = () => base44.functions.invokeStream('chatWithMorpheus', { projectId: currentProject.id, message: text, fileUrls: fileUrls || [], focusPaths: focusPaths || [], mode: chatMode, webAccess }, onStage);
      // Reload the real message list and, if a reply newer than what was
      // just sent is already sitting there, recover it — no error, no
      // retry. Same reality-check the catch block below uses; pulled out
      // so the "tab was backgrounded" path can poll it patiently instead
      // of only checking once.
      const tryRecover = async () => {
        const freshMessagesDesc = await base44.entities.ChatMessage.filter({ project_id: currentProject.id }, '-created_date', 100);
        const recovered = freshMessagesDesc[0];
        if (recovered?.role === 'morpheus' && new Date(recovered.created_date).getTime() >= sentAt) {
          await loadFiles(currentProject.id); // a build turn's file writes, if any
          setMessages(freshMessagesDesc.reverse());
          return true;
        }
        return false;
      };
      let res;
      try {
        res = await attempt();
      } catch (e) {
        if (!isBareNetworkFailure(e)) throw e;
        // Browsers throttle or outright kill a background tab's streaming
        // fetch (battery/data saving) — switching tabs while a turn runs is
        // completely normal and shouldn't ever surface as an error. If the
        // tab is hidden right now, retrying the actual call immediately is
        // pointless (it would likely die the same way while the operator
        // is still elsewhere) and risky (chatWithMorpheus.js saves the
        // reply — and writes any files — before it streams the final line
        // back, so the first attempt may still be genuinely in flight
        // server-side; resending too early could duplicate a real build).
        // Wait for them to come back, then check reality patiently instead
        // of guessing: poll for a few seconds rather than only once, since
        // a build turn in progress when they return needs a moment to
        // actually finish.
        if (document.hidden) {
          await new Promise((resolve) => {
            const onVisible = () => {
              if (!document.hidden) {
                document.removeEventListener('visibilitychange', onVisible);
                resolve();
              }
            };
            document.addEventListener('visibilitychange', onVisible);
          });
          for (let i = 0; i < 8; i++) {
            if (await tryRecover()) return; // recovered — done, no error, no retry
            await new Promise(r => setTimeout(r, 2500));
          }
          // ~20s of patient polling since they came back and still nothing
          // — fall through to the same one-retry-then-give-up path below.
        } else if (await tryRecover()) {
          return; // reply already landed, tab was never hidden — no error, no retry
        }
        // Confirmed (as best it can be) nothing reached the server — safe
        // to retry once, quiet (the existing loading/thinking UI already
        // covers the wait).
        await new Promise(r => setTimeout(r, 1200));
        res = await attempt();
      }
      const morpheusMsg = { id: 'm-' + Date.now(), role: 'morpheus', content: res.data.reply, project_id: currentProject.id };
      setMessages(prev => [...prev, morpheusMsg]);
      // `changedPaths` is the server's answer to "what actually changed" (defect 4). This used to map every
      // entry of `fileOperations`, which is a MIXED list — refusals, skips and failed edits included — so a
      // build in which every operation was refused still reloaded the tree and highlighted each refused file
      // as just-touched. A file that was never written must not read as changed.
      const changed = res.data.changedPaths || [];
      if (changed.length > 0) {
        await loadFiles(currentProject.id);
        setLastTouched(prev => ({ paths: changed, rev: prev.rev + 1 }));
      }
    } catch (e) {
      const prefix = isBareNetworkFailure(e) ? '// SYSTEM FAILURE: connection dropped twice — ' : '// SYSTEM FAILURE: ';
      setMessages(prev => [...prev, { id: 'e-' + Date.now(), role: 'morpheus', content: prefix + e.message, project_id: currentProject.id }]);
    } finally {
      setLoading(false);
      setPipelineStages([]);
    }
  }, [currentProject, loading, loadFiles, chatMode]);

  const exportProject = useCallback(async () => {
    if (!currentProject) return null;
    const allFiles = await base44.entities.ProjectFile.filter({ project_id: currentProject.id });
    // What ships, and whether it runs, are decided in ONE place — `src/lib/exportPromise.js`.
    //
    // This used to invent files: with no package.json in the project it added one claiming
    // `scripts: { start: 'node index.js' }`, and with no README.md it added one saying
    // `npm install && npm start`. Two independent guesses that could disagree with the real app, and
    // for a Python, static or compiled project they were simply false. A zip that LOOKS runnable is
    // worse than one that is honestly incomplete, so the export adds nothing and returns a verdict
    // the caller can show. The plan file (`backend/.plan.json`) is Morpheus's own bookkeeping and is
    // dropped here rather than shipped as part of someone's app.
    const plan = exportPlan(allFiles);
    const slug = currentProject.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const zip = new JSZip();
    plan.files.forEach(f => zip.file(f.path, f.content));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug || 'construct'}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return plan.verdict;
  }, [currentProject]);

  const uploadToGithub = useCallback(async (repoName, isPrivate) => {
    if (!currentProject) return;
    const res = await base44.functions.invoke('uploadToGithub', { projectId: currentProject.id, repoName, isPrivate });
    // Reflect the new connection immediately (uploadToGithub persisted
    // Project.github_repo server-side) so the UI can switch into "synced"
    // state without a reload — every chat turn from now on auto-syncs here.
    if (res.data?.repoUrl) {
      const match = res.data.repoUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
      if (match) setCurrentProject(prev => (prev ? { ...prev, github_repo: match[1] } : prev));
    }
    return res.data;
  }, [currentProject]);

  // Detach a project from its synced repo — clears Project.github_repo only
  // (setProjectGithub.js with repo:'' ), never deletes the actual repo on
  // GitHub. Reversible: reconnecting is just "push to GitHub" again.
  const disconnectGithub = useCallback(async () => {
    if (!currentProject) return;
    await base44.functions.invoke('setProjectGithub', { projectId: currentProject.id, repo: '' });
    setCurrentProject(prev => (prev ? { ...prev, github_repo: null } : prev));
  }, [currentProject]);

  // The reverse of uploadToGithub/auto-sync: pulls the repo's current HEAD
  // back into this project's files. Chat edits auto-push to GitHub, but
  // nothing pulls the other way — an edit made directly against the repo
  // (a manual push, another tool) is invisible to Morpheus until this runs,
  // and the next compile would otherwise silently overwrite it right back
  // out to GitHub (compileProject.js always pushes ProjectFile → GitHub).
  // See KNOWN-HAZARDS.md H9 for the same gap on self-dev's own sync button.
  const syncFromGithub = useCallback(async () => {
    if (!currentProject) return;
    const res = await base44.functions.invoke('syncProjectFromGithub', { projectId: currentProject.id });
    if (res.data?.fileCount > 0) {
      await loadFiles(currentProject.id);
    }
    return res.data;
  }, [currentProject, loadFiles]);

  // User-Choice Cloud Storage (Feature Backlog #12, Phase 1). setStorageMode
  // flips Project.storage_mode via a dedicated function (not a raw entity
  // update, unlike togglePolishUi) since switching to "drive" has a real
  // precondition (a connected GoogleDriveConnection) and side effect (an
  // initial push) — see server/src/functions/setProjectStorageMode.js.
  const setStorageMode = useCallback(async (storageMode) => {
    if (!currentProject) return;
    const res = await base44.functions.invoke('setProjectStorageMode', { projectId: currentProject.id, storageMode });
    setCurrentProject(prev => (prev ? { ...prev, storage_mode: storageMode } : prev));
    return res.data;
  }, [currentProject]);

  const pushToDrive = useCallback(async () => {
    if (!currentProject) return;
    const res = await base44.functions.invoke('pushProjectToDrive', { projectId: currentProject.id });
    return res.data;
  }, [currentProject]);

  const pullFromDrive = useCallback(async () => {
    if (!currentProject) return;
    const res = await base44.functions.invoke('pullProjectFromDrive', { projectId: currentProject.id });
    if (res.data?.fetched > 0 || res.data?.removed > 0) {
      await loadFiles(currentProject.id);
    }
    return res.data;
  }, [currentProject, loadFiles]);

  const emailProjectFiles = useCallback(async (email) => {
    if (!currentProject) return null;
    const allFiles = await base44.entities.ProjectFile.filter({ project_id: currentProject.id });
    // The THIRD place the same two files were invented, found by the guard rather than by reading —
    // `exportProject` above and `downloadZip` in BackendPanel.jsx were the other two. An emailed ZIP is
    // the one nobody can inspect before it arrives, so a fabricated manifest is worst here.
    const plan = exportPlan(allFiles);
    const slug = currentProject.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const zip = new JSZip();
    plan.files.forEach(f => zip.file(f.path, f.content));
    const blob = await zip.generateAsync({ type: 'blob' });
    const file = new File([blob], `${slug || 'construct'}.zip`, { type: 'application/zip' });
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    const res = await base44.functions.invoke('emailProjectFiles', {
      fileUrl: file_url,
      projectName: currentProject.name,
      email,
      // The recipient has no button to look under, so the command goes in the email itself.
      runNote: plan.verdict.summary,
    });
    return { ...plan.verdict, sent: res?.data ?? null };
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
    // Descending + reverse, not ascending + limit — see loadMessages'
    // comment for why the latter silently fetches the OLDEST 200 once a
    // project passes that count, which would make this revert act on some
    // ancient turn instead of the one the operator actually just made.
    const freshDesc = await base44.entities.ChatMessage.filter({ project_id: currentProject.id }, '-created_date', 200);
    const lastUserIdxDesc = freshDesc.findIndex(m => m.role === 'user'); // first hit scanning from newest = the most recent user message
    if (lastUserIdxDesc >= 0) {
      const toDelete = freshDesc.slice(0, lastUserIdxDesc + 1); // that message and everything newer (its reply)
      for (const m of toDelete) {
        if (m.id) await base44.entities.ChatMessage.delete(m.id);
      }
      setMessages(freshDesc.slice(lastUserIdxDesc + 1).reverse());
    } else {
      setMessages(freshDesc.reverse());
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
      if ((res.data?.changedPaths || []).length > 0) {
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
      if ((res.data.changedPaths || []).length > 0) {
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
      if ((res.data.changedPaths || []).length > 0) {
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
  const saveCompiledArtifacts = useCallback(async (repoFullName, assets) => {
    if (!currentProject) return;
    try {
      const body = { projectId: currentProject.id, repoFullName, target: currentProject.compile_target };
      if (assets) body.assets = assets;
      const res = await base44.functions.invoke('saveCompiledArtifacts', body);
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

  return { projects, currentProject, files, selectedFile, messages, loading, loadError, pipelineStages, chatMode, setChatMode, webAccess, setWebAccess, snapshots, lastTouched, selectProject, deselectProject, deleteProject, createProject, updateCompileTarget, sendMessage, exportProject, uploadToGithub, disconnectGithub, syncFromGithub, setStorageMode, pushToDrive, pullFromDrive, emailProjectFiles, restoreSnapshot, revertLastPrompt, runAutonomousStep, generateTests, importFromGithub, setSelectedFile, loadProjects, loadSnapshots, loadFiles, compileProject, previewCompile, checkCompileStatus, saveCompiledArtifacts, updateDependencies, renameProject, togglePolishUi };
}