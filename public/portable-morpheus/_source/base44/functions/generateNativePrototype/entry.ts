import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { invokeAI } from '../../shared/aiUtils.ts';
import { logUsage } from '../../shared/projectUtils.ts';

const NATIVE_TARGETS = ['android-apk', 'ios-app', 'windows-exe', 'mac-app', 'linux-binary', 'python-package', 'rpi-distro', 'arduino-firmware'];

const SYSTEM_PROMPT = `You are a rapid prototyping engine inside Morpheus, a Matrix-themed dev environment.

Your job: given a NATIVE application's source code (Android, iOS, desktop, embedded, etc.), generate a single self-contained HTML document that serves as a VISUAL RAPID PROTOTYPE — a web-based mockup showing the exact look, feel, layout, colors, and logic flow of what the native app would look like when built and running.

This is NOT the actual app. It is a development aid so the operator can see and feel the UI before compiling the real binary.

RULES:
1. Output a COMPLETE, self-contained HTML document (<!DOCTYPE html>...</html>). All CSS inline in <style> tags. All JS inline in <script> tags. No external local files. You MAY use CDN URLs for fonts or icon libraries.
2. Match the target platform's visual conventions:
   - android-apk: Material Design aesthetic, phone-sized frame (max-width 390px, centered), Android-style status bar at top
   - ios-app: iOS Human Interface Guidelines aesthetic, phone-sized frame, iOS-style status bar, rounded cards
   - windows-exe: desktop window frame with title bar and window controls (minimize/maximize/close)
   - mac-app: macOS window frame with traffic-light buttons (red/yellow/green)
   - linux-binary: desktop window frame, neutral GTK/Qt style
   - python-package: terminal/console UI or simple tkinter-style window
   - rpi-distro: embedded/kiosk full-screen UI, no window chrome
   - arduino-firmware: hardware control panel / serial monitor / sensor dashboard style
3. Extract colors, layout, text, and structure from the source files. If the code defines specific colors (e.g. #FF9900, #000000), use them EXACTLY. If it defines text labels, use them verbatim.
4. Recreate the UI layout faithfully — button positions, text labels, background colors, arrangement, spacing.
5. Simulate logic flow: if a button has a click handler in the code, make the prototype's button do something visible (show an alert, update a display, toggle state, simulate a calculation, etc.). Match the actual logic from the code as closely as possible.
6. If the source code is incomplete or skeletal (e.g. just a skeleton with one button), INFER the intended full UI from the project name, description, and any available code. Fill in reasonable, polished defaults that match the app's theme and purpose. A calculator project should show a full calculator UI, not just one button.
7. Make it look polished and real — not a wireframe, but a believable mockup of the finished app that the operator can interact with.
8. The HTML must work standalone in an iframe sandbox with allow-scripts.
9. Return ONLY a JSON object with a single "html" key containing the complete HTML document as a string. No markdown fences, no extra text.`;

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId } = body;
    if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });

    const project = await base44.entities.Project.get(projectId);
    const target = project.compile_target || 'source';

    if (!NATIVE_TARGETS.includes(target)) {
      return Response.json({ error: 'Not a native target: ' + target }, { status: 400 });
    }

    const files = await base44.entities.ProjectFile.filter({ project_id: projectId });

    // Filter and limit files sent to LLM
    const MAX_FILE_SIZE = 6000;
    const MAX_FILES = 25;
    const SKIP_PATTERNS = ['node_modules', '.git/', 'package-lock', 'yarn.lock', 'gradle/wrapper', 'gradlew'];
    const relevantFiles = files
      .filter((f: any) => !SKIP_PATTERNS.some(p => f.path.includes(p)))
      .filter((f: any) => f.content && f.content.length < MAX_FILE_SIZE)
      .slice(0, MAX_FILES);

    const filesContext = relevantFiles
      .map((f: any) => `--- ${f.path} ---\n${f.content}`)
      .join('\n\n') || '(no files yet — project is empty)';

    const prompt = `${SYSTEM_PROMPT}

PROJECT NAME: ${project.name}
${project.description ? 'DESCRIPTION: ' + project.description : ''}
COMPILE TARGET: ${target}

SOURCE FILES:
${filesContext}

Generate the rapid prototype HTML now. Return ONLY a JSON object: { "html": "<!DOCTYPE html>...</html>" }`;

    const response = await invokeAI(base44, prompt, {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'Complete self-contained HTML document for the rapid prototype' }
      }
    }, undefined, 'planner');

    let html = response.result.html || '';

    // Strip markdown fences if the LLM added them despite instructions
    html = html.replace(/^```html?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    await logUsage(base44, 'native_prototype', projectId, project.name, { target, fileCount: relevantFiles.length });

    return Response.json({ html, target, fileCount: relevantFiles.length });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}