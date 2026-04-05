#!/usr/bin/env node

/**
 * Diagnostic script for Agent Flow
 * Checks setup, hooks, and active sessions
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_SCRIPT = path.join(CLAUDE_DIR, 'agent-flow', 'hook.js');

console.log('\n🔍 Agent Flow Diagnostics\n');

// 1. Check if Claude directory exists
console.log('1️⃣  Claude Configuration');
console.log(`   ~/.claude exists: ${fs.existsSync(CLAUDE_DIR) ? '✅' : '❌'}`);
console.log(`   ~/.claude/projects exists: ${fs.existsSync(PROJECTS_DIR) ? '✅' : '❌'}`);

// 2. Check settings.json for hooks
if (fs.existsSync(SETTINGS_FILE)) {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  const hasHooks = settings.hooks && settings.hooks['agent-flow'];
  console.log(`\n2️⃣  Claude Code Hooks`);
  console.log(`   Hooks in settings.json: ${hasHooks ? '✅' : '❌'}`);

  if (hasHooks) {
    const hook = settings.hooks['agent-flow'];
    console.log(`   Hook bin: ${hook.bin}`);
    console.log(`   Hook args: ${JSON.stringify(hook.args)}`);
  }
} else {
  console.log(`\n2️⃣  Claude Code Hooks`);
  console.log(`   settings.json not found: ❌`);
  console.log(`   Run: pnpm run setup`);
}

// 3. Check hook script
console.log(`\n3️⃣  Hook Script`);
console.log(`   Hook script exists: ${fs.existsSync(HOOK_SCRIPT) ? '✅' : '❌'}`);

// 4. Find active sessions
console.log(`\n4️⃣  Active Sessions`);
if (fs.existsSync(PROJECTS_DIR)) {
  const projectDirs = fs.readdirSync(PROJECTS_DIR);
  let foundSessions = 0;

  for (const projDir of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, projDir);
    try {
      const files = fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(projPath, file);
        const stat = fs.statSync(filePath);
        const ageMs = Date.now() - stat.mtimeMs;
        const ageMinutes = (ageMs / 1000 / 60).toFixed(1);
        const sessionId = path.basename(file, '.jsonl');
        const isActive = ageMs < 10 * 60 * 1000; // 10 minutes

        console.log(`   ${isActive ? '🟢' : '⚪'} ${sessionId.slice(0, 8)}... (${ageMinutes}m ago, ${(stat.size / 1024).toFixed(1)}KB)`);
        foundSessions++;
      }
    } catch (e) {
      // Ignore
    }
  }

  if (foundSessions === 0) {
    console.log(`   No JSONL files found (run: claude "something")`);
  }
} else {
  console.log(`   PROJECTS_DIR not found: ❌`);
}

// 5. Check workspace
console.log(`\n5️⃣  Current Workspace`);
try {
  const cwd = process.cwd();
  console.log(`   Working directory: ${cwd}`);

  // Try to encode the path like Claude Code does
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const expectedDir = path.join(PROJECTS_DIR, encoded);
  const exists = fs.existsSync(expectedDir);

  console.log(`   Expected project dir: ${encoded}`);
  console.log(`   Workspace dir exists: ${exists ? '✅' : '❌'}`);

  if (exists) {
    const files = fs.readdirSync(expectedDir).filter(f => f.endsWith('.jsonl'));
    console.log(`   Sessions in workspace: ${files.length}`);
  }
} catch (e) {
  console.log(`   Error checking workspace: ${e.message}`);
}

// 6. Check Node.js version
console.log(`\n6️⃣  Dependencies`);
console.log(`   Node.js: ${process.version}`);

// 7. Hook connectivity (try to POST to port)
console.log(`\n7️⃣  Hook Server Connectivity`);
// We can't easily test this without starting the server, so skip

// Summary
console.log(`\n📋 Summary:\n`);
if (fs.existsSync(SETTINGS_FILE)) {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  if (settings.hooks && settings.hooks['agent-flow']) {
    console.log('✅ Hooks are configured. Next: Open Agent Flow and run: claude "test"');
  } else {
    console.log('⚠️  Hooks not configured. Run: pnpm run setup');
  }
} else {
  console.log('❌ settings.json not found. Run: pnpm run setup');
}

console.log('\n💡 Quick start:');
console.log('   Terminal 1: Open Agent Flow in Cursor (Cmd+Shift+P → "Agent Flow")');
console.log('   Terminal 2: cd <your-workspace> && claude "your prompt"');
console.log('\n');
