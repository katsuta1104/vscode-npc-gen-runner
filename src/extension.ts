// src/extension.ts (CSV を出力しない版) - updated for v0.1.6
import * as vscode from "vscode";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import * as he from "he";
import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess, execSync } from "child_process";
import { promisify } from "util";
import * as os from "os";
import { randomBytes } from "crypto";

const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);
const accessAsync = promisify(fs.access);

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("npc");
}
function getWorkspaceRoot(): string | undefined {
  const ws = vscode.workspace.workspaceFolders;
  if (!ws || ws.length === 0) return undefined;
  return ws[0].uri.fsPath;
}
function ensureWorkspace(): string {
  const root = getWorkspaceRoot();
  if (!root) throw new Error("Workspace is not opened. Please open a folder first.");
  return root;
}
function defaultCfg() {
  return {
    pythonPath: "py",
    genFilename: "gen.py",
    mainFilename: "main.py",
    timeoutMs: 30000,
    maxOutputBytes: 10 * 1000 * 1000,
    outputDir: ".",
    threads: 0, // 0 => use physical core count (or fallback)
    genCommand: "py {wrapper}",
    mainBuildCommand: "g++ main.cpp -o {out}",
    mainRunCommand: "py {main}",
    mainExec: "main_exec",
  };
}

// Utility safe filename part
function safeFilenamePart(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

// Try to determine *physical* core count in a cross-platform way.
// Fallback: os.cpus().length
function getPhysicalCoreCount(): number {
  try {
    const platform = process.platform;
    if (platform === "linux") {
      const data = fs.readFileSync("/proc/cpuinfo", "utf8");
      const physCorePairs = new Set<string>();
      const blocks = data.split(/\n\n+/);
      for (const b of blocks) {
        const mPhys = b.match(/^physical id\s*:\s*(\d+)/m);
        const mCore = b.match(/^core id\s*:\s*(\d+)/m);
        if (mPhys && mCore) {
          physCorePairs.add(`${mPhys[1]}-${mCore[1]}`);
        }
      }
      if (physCorePairs.size > 0) return physCorePairs.size;
    } else if (platform === "darwin") {
      const out = execSync("sysctl -n hw.physicalcpu", { encoding: "utf8" }).trim();
      const n = Number(out);
      if (Number.isFinite(n) && n > 0) return Math.max(1, Math.floor(n));
    } else if (platform === "win32") {
      try {
        const out = execSync('wmic cpu get NumberOfCores /value', { encoding: "utf8" });
        const matches = Array.from(out.matchAll(/NumberOfCores=(\d+)/g));
        if (matches && matches.length) {
          const sum = matches.reduce((acc, m) => acc + Number(m[1] || 0), 0);
          if (sum > 0) return sum;
        }
      } catch (e) {}
    }
  } catch (e) {}
  const logical = os.cpus()?.length || 1;
  return Math.max(1, Math.floor(logical));
}

// ------------ HTML extraction helpers ------------
// We keep python extraction to fetch code, but we NO LONGER auto-extract seeds.
function extractPythonFromHtml(html: string): { code: string; seeds: string[] } {
  const $ = cheerio.load(html);

  const byId = $("#code-block-py").text();
  if (byId && String(byId).trim().length > 0) {
    const decoded = he.decode(String(byId));
    return { code: decoded.trim(), seeds: [] };
  }

  const varCodeMatch = html.match(/var\s+code\s*=\s*`([\s\S]*?)`;/);
  if (varCodeMatch && varCodeMatch[1]) {
    const decoded = he.decode(String(varCodeMatch[1]));
    return { code: decoded.trim(), seeds: [] };
  }

  const pres = $("pre");
  for (let i = 0; i < pres.length; i++) {
    const raw = $(pres[i]).text();
    const decoded = he.decode(String(raw));
    if (/^\s*(class |def |import |from )/m.test(decoded)) {
      return { code: decoded.trim(), seeds: [] };
    }
  }

  const pageText = he.decode(String($.root().text()));
  const genMatch = pageText.match(/def\s+generate[\s\S]*/);
  if (genMatch) {
    return { code: genMatch[0], seeds: [] };
  }
  throw new Error("Python generator を HTML から見つけられませんでした。");
}

// ---- URL helper ----
function expandShortNotation(input: string): string {
  const trimmed = input.trim();
  const npcMatch = trimmed.match(/^NPC0*(\d+)([A-Za-z])$/i);
  if (npcMatch) {
    const num = npcMatch[1];
    const letter = npcMatch[2].toLowerCase();
    const pad = String(num).padStart(3, "0");
    return `https://sites.google.com/view/nanyocompetitiveprogramming/%E3%82%B3%E3%83%B3%E3%83%86%E3%82%B9%E3%83%88%E4%B8%80%E8%A6%A7/contest${pad}/problems/${letter}`;
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return trimmed;
}

// ---- fetch & save generator ----
// NOTE: seed 自動抽出を廃止。戻り値は空配列（手入力を必須にする）。
async function fetchGeneratorAndSave(urlOrShort: string, genPath: string): Promise<string[]> {
  const url = expandShortNotation(urlOrShort);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const html = await res.text();
  const { code } = extractPythonFromHtml(html);
  await writeFileAsync(genPath, code, { encoding: "utf8" });
  return []; // no automatic seeds
}

// ---- runner helpers ----
function killProcessSafe(proc: ChildProcess | undefined) {
  try {
    if (!proc) return;
    proc.kill();
  } catch (e) {}
}
async function fileExists(p: string): Promise<boolean> {
  try {
    await accessAsync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
function makeWrapperContent(seed: string): string {
  return `
import sys, io, traceback, re
src = open('gen.py','r',encoding='utf-8').read()
# seed を固定代入している行（先頭〜末尾の空白を含む）は削除
src = re.sub(r'(?m)^\\s*seed\\s*=\\s*\\d+\\s*$', '', src)
g = {'__name__': '__main__', 'seed': ${seed}}
buf = io.StringIO()
old = sys.stdout
sys.stdout = buf
try:
    exec(src, g)
except Exception as e:
    sys.stdout = old
    traceback.print_exc(file=sys.stderr)
    sys.exit(3)
finally:
    sys.stdout = old
out = buf.getvalue()
if not out.strip():
    sys.stderr.write('Generator produced no stdout. Ensure gen.py prints the input format.\\n')
    sys.exit(2)
sys.stdout.write(out)
`;
}

// Map to track running child processes for cancellation
const runningProcesses = new Map<string, ChildProcess[]>();

// runSingleSeed now uses configurable commands (genCommand, mainRunCommand)
async function runSingleSeed(seed: string, cfg: any, root: string, outputDir: string, outputChannel: vscode.OutputChannel, timeoutMsOverride?: number): Promise<{ seed: string; ok: boolean; exitCode?: number; err?: string; stdout?: string; mainTimeMs?: number }> {
  const timeoutMs = timeoutMsOverride ?? (cfg.timeoutMs ?? defaultCfg().timeoutMs);
  const maxOutputBytes = cfg.maxOutputBytes ?? defaultCfg().maxOutputBytes;

  // wrapper in temp dir
  const wrapperName = `__npc_wrapper_${safeFilenamePart(seed)}_${randomBytes(6).toString("hex")}.py`;
  const wrapperPath = path.join(os.tmpdir(), wrapperName);
  const seedSafe = safeFilenamePart(seed);

  // ensure process list entry
  runningProcesses.set(seedSafe, []);

  try {
    await writeFileAsync(wrapperPath, makeWrapperContent(seed), { encoding: "utf8" });

    // Run generator using user-provided shell command (replace {wrapper})
    const genCommandTemplate = cfg.genCommand || defaultCfg().genCommand;
    const genCommand = genCommandTemplate.replace(/\{wrapper\}/g, `"${wrapperPath}"`);
    const genStdoutChunks: Buffer[] = [];
    let genStderr = "";
    let genExitCode: number | null = null;

    const genProc = spawn(genCommand, { cwd: root, shell: true });
    runningProcesses.get(seedSafe)?.push(genProc);

    genProc.stdout?.on("data", (b: Buffer) => genStdoutChunks.push(b));
    genProc.stderr?.on("data", (d: Buffer) => { genStderr += d.toString(); });

    // wait for generator to finish (or timeout)
    const genPromise = new Promise<void>((resolve) => {
      const genTimeout = setTimeout(() => {
        try { genProc.kill(); } catch { }
        genExitCode = -1;
        resolve();
      }, timeoutMs);

      genProc.on("close", (code) => {
        clearTimeout(genTimeout);
        genExitCode = code ?? 0;
        resolve();
      });

      genProc.on("error", () => {
        clearTimeout(genTimeout);
        genExitCode = -1;
        resolve();
      });
    });

    await genPromise;
    const genOutput = Buffer.concat(genStdoutChunks).toString("utf8");

    // If generator failed or produced no stdout -> return failure
    const inputsDir = path.join(outputDir, "inputs");
    const outputsDir = path.join(outputDir, "outputs");
    if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir, { recursive: true });
    if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

    // write generator output for debugging
    try { fs.writeFileSync(path.join(outputsDir, `out_gen_${seedSafe}.txt`), genOutput + "\n", "utf8"); } catch {}

    if (genExitCode !== 0) {
      const errMsg = `Generator failed (exit ${genExitCode}). stderr:\n${genStderr}`;
      return { seed, ok: false, exitCode: typeof genExitCode === "number" ? genExitCode : undefined, err: errMsg, stdout: genOutput };
    }
    if (!genOutput || !genOutput.trim()) {
      const errMsg = `Generator produced no stdout. stderr:\n${genStderr}`;
      return { seed, ok: false, err: errMsg, stdout: genOutput };
    }

    // Save generator output to inputs/
    const inFile = path.join(inputsDir, `in_${seedSafe}.txt`);
    try { fs.writeFileSync(inFile, genOutput, "utf8"); } catch (e:any) { return { seed, ok: false, err: `Failed to write generator input file: ${String(e)}` }; }

    // Now run main using user-provided run command (assumes build was done separately if needed)
    const mainRunTemplate = cfg.mainRunCommand || defaultCfg().mainRunCommand;
    const mainFilename = cfg.mainFilename || defaultCfg().mainFilename;
    const mainExec = cfg.mainExec || defaultCfg().mainExec;

    // replace placeholders: {main} and {exe}
    const runCommand = mainRunTemplate.replace(/\{main\}/g, `"${mainFilename}"`).replace(/\{exe\}/g, `"${mainExec}"`);

    const mainProc = spawn(runCommand, { cwd: root, shell: true });
    runningProcesses.get(seedSafe)?.push(mainProc);
    let collected = Buffer.alloc(0);
    let stderrAll = "";
    let exceeded = false;
    if (mainProc.stderr) mainProc.stderr.on("data", d => { stderrAll += d.toString(); });
    if (mainProc.stdout) {
      mainProc.stdout.on("data", (chunk: Buffer) => {
        collected = Buffer.concat([collected, chunk]);
        if (collected.length > maxOutputBytes) { exceeded = true; try { mainProc.kill(); } catch {} }
      });
    }
    const rs = fs.createReadStream(inFile);
    // measure main time
    const start = Date.now();
    rs.pipe(mainProc.stdin);

    const timeout = setTimeout(() => { try { mainProc.kill(); } catch {} }, timeoutMs);
    const code = await new Promise<number | null>((resolve) => {
      mainProc.on("close", (c) => { clearTimeout(timeout); resolve(c ?? 0); });
      mainProc.on("error", () => { clearTimeout(timeout); resolve(-1); });
    });
    const end = Date.now();
    const outString = collected.toString("utf8");
    const mainTimeMs = end - start;
    if (exceeded) {
      const outName = `out_${seedSafe}.txt`;
      try { fs.writeFileSync(path.join(outputsDir, outName), outString, "utf8"); } catch {}
      return { seed, ok: false, exitCode: code ?? undefined, err: "Output exceeded limit", stdout: outString, mainTimeMs };
    }
    if (code !== 0) {
      const outName = `out_${seedSafe}.txt`;
      try { fs.writeFileSync(path.join(outputsDir, outName), outString, "utf8"); } catch {}
      return { seed, ok: false, exitCode: code ?? undefined, err: `Main exited with code ${code}. stderr:\n${stderrAll}`, stdout: outString, mainTimeMs };
    }
    // success -> save output
    const outName = `out_${seedSafe}.txt`;
    try { fs.writeFileSync(path.join(outputsDir, outName), outString, "utf8"); } catch {}
    return { seed, ok: true, exitCode: code ?? undefined, stdout: outString, mainTimeMs };
  } finally {
    // cleanup wrapper and runningProcesses entry
    try { if (fs.existsSync(wrapperPath)) fs.unlinkSync(wrapperPath); } catch {}
    runningProcesses.delete(seedSafe);
  }
}

// Helper to kill all running processes (for cancellation)
function killAllRunning() {
  for (const [seed, procs] of Array.from(runningProcesses.entries())) {
    for (const p of procs) {
      try { p.kill(); } catch {}
    }
  }
  runningProcesses.clear();
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("NPC Runner");
  context.subscriptions.push(outputChannel);

  const fetchCommand = vscode.commands.registerCommand("npc.fetchGenerator", async () => {
    try {
      const root = ensureWorkspace();
      const config = getConfig();
      const genFilename = config.get("genFilename") || defaultCfg().genFilename;
      const input = await vscode.window.showInputBox({ prompt: "Enter NPC short (e.g. NPC004B) or full URL" });
      if (!input) return;

      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Fetching generator..." }, async (progress) => {
        progress.report({ message: "Downloading..." });
        try {
          // fetch and save, but do not auto-detect seeds
          await fetchGeneratorAndSave(input, path.join(root, String(genFilename)));
          outputChannel.appendLine(`Saved ${genFilename} to workspace.`);
          vscode.window.showInformationMessage(`gen.py saved. (Seed auto-extraction disabled — please enter seeds manually when running.)`);
          const doc = await vscode.workspace.openTextDocument(path.join(root, String(genFilename)));
          await vscode.window.showTextDocument(doc);
        } catch (e: any) {
          outputChannel.appendLine(`Error fetching generator: ${String(e)}`);
          vscode.window.showErrorMessage(`Failed to fetch generator: ${String(e.message || e)}`);
        }
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(String(e.message || e));
    }
  });

  const runCommand = vscode.commands.registerCommand("npc.runWithGenerators", async () => {
    try {
      const root = ensureWorkspace();
      const config = getConfig();
      const cfg = {
        pythonPath: config.get("pythonPath") || defaultCfg().pythonPath,
        genFilename: config.get("genFilename") || defaultCfg().genFilename,
        mainFilename: config.get("mainFilename") || defaultCfg().mainFilename,
        timeoutMs: config.get("timeoutMs") ?? defaultCfg().timeoutMs,
        maxOutputBytes: config.get("maxOutputBytes") ?? defaultCfg().maxOutputBytes,
        outputDir: config.get("outputDir") || defaultCfg().outputDir,
        threads: config.get("threads") ?? defaultCfg().threads,
        genCommand: config.get("genCommand") || defaultCfg().genCommand,
        mainBuildCommand: config.get("mainBuildCommand") || defaultCfg().mainBuildCommand,
        mainRunCommand: config.get("mainRunCommand") || defaultCfg().mainRunCommand,
        mainExec: config.get("mainExec") || defaultCfg().mainExec,
      };

      const urlOrShort = await vscode.window.showInputBox({ prompt: "Enter NPC short (NPC004B) or full URL to fetch generator (leave empty to use existing gen.py)" });
      const genPath = path.join(root, String(cfg.genFilename));

      if (urlOrShort) {
        try {
          await fetchGeneratorAndSave(urlOrShort, genPath);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to fetch generator: ${String(e.message || e)}`);
          return;
        }
      } else {
        if (!(await fileExists(genPath))) {
          vscode.window.showErrorMessage("No gen.py in workspace. Provide a URL or create gen.py first.");
          return;
        }
      }

      // Always require manual seed input (automatic extraction was removed)
      const manual = await vscode.window.showInputBox({ prompt: "Enter seeds separated by spaces or commas (e.g. 10 21 40)" });
      if (!manual) return;
      const seeds = manual.split(/[\s,]+/).filter(s => s.trim().length > 0);
      if (seeds.length === 0) {
        vscode.window.showErrorMessage("No seeds provided.");
        return;
      }

      outputChannel.appendLine(`Running seeds: ${seeds.join(", ")}`);

      // prepare outputDir and subdirs
      const outdir = path.resolve(root, String(cfg.outputDir ?? defaultCfg().outputDir));
      if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });
      const inputsDir = path.join(outdir, "inputs");
      const outputsDir = path.join(outdir, "outputs");
      if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir, { recursive: true });
      if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

      const results: Array<{ seed: string; ok: boolean; exitCode?: number; err?: string; stdout?: string; mainTimeMs?: number }> = [];

      // determine threads: if user gave <=0, use physical cores
      let threads = Number(cfg.threads) || 0;
      if (threads <= 0) threads = getPhysicalCoreCount();

      outputChannel.appendLine(`Using threads: ${threads} (physical cores)`);

      // If a build command is specified, run it once before seed loop
      if (cfg.mainBuildCommand && String(cfg.mainBuildCommand).trim().length > 0) {
        outputChannel.appendLine(`Running build: ${cfg.mainBuildCommand}`);
        try {
          const buildCommandStr = String(cfg.mainBuildCommand);
          const buildProc = spawn(buildCommandStr, { cwd: root, shell: true });
          let buildErr = "";
          buildProc.stderr?.on("data", (d: Buffer) => { buildErr += d.toString(); });
          const buildExit = await new Promise<number>((resolve) => {
            buildProc.on("close", (c) => resolve(c ?? 0));
            buildProc.on("error", () => resolve(-1));
          });
          if (buildExit !== 0) {
            outputChannel.appendLine(`Build failed (exit ${buildExit}): ${buildErr}`);
            vscode.window.showErrorMessage(`Build failed (exit ${buildExit}). See output channel for details.`);
            return;
          }
          outputChannel.appendLine("Build succeeded.");
        } catch (e:any) {
          outputChannel.appendLine(`Build exception: ${String(e)}`);
          vscode.window.showErrorMessage(`Build failed: ${String(e)}`);
          return;
        }
      }

      // concurrency queue
      let cancelled = false;

      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running tests with generator(s) — threads: ${threads}`, cancellable: true }, async (progress, token) => {
        const total = seeds.length;
        let completed = 0;
        const queue: Promise<void>[] = [];
        let idx = 0;

        token.onCancellationRequested(() => {
          cancelled = true;
          outputChannel.appendLine("Cancellation requested — killing running processes...");
          killAllRunning();
        });

        // worker function
        const worker = async () => {
          while (true) {
            if (cancelled) return;
            const myIndex = idx;
            idx++;
            if (myIndex >= seeds.length) return;
            const s = seeds[myIndex];
            progress.report({ message: `Running seed ${s} (${myIndex + 1}/${total})`, increment: (100 / total) });
            outputChannel.appendLine(`=== Seed ${s} ===`);
            try {
              const r = await runSingleSeed(s, cfg, root, outdir, outputChannel);
              results[myIndex] = r;
              if (r.ok) { outputChannel.appendLine(`Seed ${s}: OK (${r.mainTimeMs ?? "N/A"} ms)`); } else { outputChannel.appendLine(`Seed ${s}: FAILED - ${r.err}`); }
            } catch (e:any) {
              outputChannel.appendLine(`Seed ${s}: Exception - ${String(e)}`);
              results[myIndex] = { seed: s, ok: false, err: String(e) };
            }
            completed++;
            progress.report({ message: `Completed ${completed}/${total}`, increment: (100 / total) });
          }
        };

        // start workers
        for (let i = 0; i < threads; i++) {
          queue.push(worker());
        }
        await Promise.all(queue);
      });

      // After run - write combined out.txt preserving seed order
      try {
        const combinedPath = path.join(outdir, "out.txt");
        const parts: string[] = [];
        for (let i = 0; i < seeds.length; i++) {
          const s = seeds[i];
          const sf = safeFilenamePart(s);
          const fn = path.join(outdir, "outputs", `out_${sf}.txt`);
          if (fs.existsSync(fn)) parts.push(fs.readFileSync(fn, "utf8"));
        }
        fs.writeFileSync(combinedPath, parts.join("\n"), "utf8");
        vscode.window.showInformationMessage(`Run completed. Combined output written to ${combinedPath}`);
        outputChannel.appendLine(`Combined output written to ${combinedPath}`);
      } catch (e: any) {
        outputChannel.appendLine(`Failed to combine outputs: ${String(e)}`);
      }

      // produce summary Markdown only (no CSV)
      try {
        const summaryMdPath = path.join(outdir, "summary.md");
        const mdLines: string[] = [];
        mdLines.push(`# NPC Run Summary`);
        mdLines.push("");
        mdLines.push(`**Workspace:** ${root}`);
        mdLines.push(`**Date:** ${new Date().toISOString()}`);
        mdLines.push(`**Threads used:** ${threads}`);
        mdLines.push("");
        mdLines.push("| # | seed | ok | exitCode | mainTimeMs (ms) | err | outputFile |");
        mdLines.push("|---:|---:|:---:|:---:|---:|---|---|");

        for (let i = 0; i < seeds.length; i++) {
          const s = seeds[i];
          const r = results[i];
          const sf = safeFilenamePart(s);
          const outFile = path.join("outputs", `out_${sf}.txt`);
          if (!r) {
            mdLines.push(`| ${i+1} | ${s} | false |  |  | no result | ${outFile} |`);
          } else {
            mdLines.push(`| ${i+1} | ${s} | ${r.ok ? "true":"false"} | ${typeof r.exitCode === "number" ? r.exitCode : ""} | ${typeof r.mainTimeMs === "number" ? r.mainTimeMs : "N/A"} | ${r.err ? r.err.replace(/\|/g,'\\|') : ""} | ${outFile} |`);
          }
        }
        fs.writeFileSync(summaryMdPath, mdLines.join("\n"), "utf8");
        outputChannel.appendLine(`Summary written to ${summaryMdPath}`);
        // open the markdown summary in editor for quick view
        try {
          const doc = await vscode.workspace.openTextDocument(summaryMdPath);
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {}
      } catch (e:any) {
        outputChannel.appendLine(`Failed to write summary: ${String(e)}`);
      }

    } catch (e: any) {
      vscode.window.showErrorMessage(String(e.message || e));
    }
  });

  context.subscriptions.push(fetchCommand, runCommand);
}

export function deactivate() {
  try { killAllRunning(); } catch {}
}
