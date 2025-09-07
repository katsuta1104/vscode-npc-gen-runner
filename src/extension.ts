// src/extension.ts (CSV を出力しない版)
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
    pythonPath: "python",
    genFilename: "gen.py",
    mainFilename: "main.py",
    timeoutMs: 30000,
    maxOutputBytes: 10 * 1000 * 1000,
    outputDir: ".",
    threads: 0, // 0 => use physical core count (or fallback)
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
function extractSeedsFromHtml($: cheerio.Root): string[] {
  const intRegex = /-?\d+/g;

  const seedPres = $("pre.seeds, pre[class*='seeds']");
  if (seedPres.length) {
    for (let i = 0; i < seedPres.length; i++) {
      const el = seedPres.eq(i);
      const htmlInner = el.html() || "";
      const withoutComments = htmlInner.replace(/<!--[\s\S]*?-->/g, " ");
      const decoded = he.decode(withoutComments).trim();
      const nums = decoded.match(intRegex);
      if (nums && nums.length) return nums;
    }
  }

  const h3nodes = $("h3").filter((i, el) => $(el).text().trim() === "seed値" || /seed値/.test($(el).text()));
  if (h3nodes.length) {
    for (let i = 0; i < h3nodes.length; i++) {
      const el = h3nodes.eq(i);
      let pre = el.nextAll("div.code-box").first().find("pre").first();
      if (pre.length && String(pre.text()).trim()) {
        const txt = he.decode(String(pre.text()).trim());
        const nums = txt.match(intRegex);
        if (nums && nums.length) return nums;
      }
      pre = el.nextAll("pre").first();
      if (pre.length && String(pre.text()).trim()) {
        const txt = he.decode(String(pre.text()).trim());
        const nums = txt.match(intRegex);
        if (nums && nums.length) return nums;
      }
      pre = el.parent().find("pre").first();
      if (pre.length && String(pre.text()).trim()) {
        const txt = he.decode(String(pre.text()).trim());
        const nums = txt.match(intRegex);
        if (nums && nums.length) return nums;
      }
    }
  }

  const pres = $("pre");
  for (let i = 0; i < pres.length; i++) {
    const raw = $(pres[i]).text();
    const txt = he.decode(String(raw)).trim();
    const nums = txt.match(intRegex);
    if (nums && nums.length) return nums;
  }
  return [];
}

function extractPythonFromHtml(html: string): { code: string; seeds: string[] } {
  const $ = cheerio.load(html);

  const byId = $("#code-block-py").text();
  if (byId && String(byId).trim().length > 0) {
    const decoded = he.decode(String(byId));
    return { code: decoded.trim(), seeds: extractSeedsFromHtml($) };
  }

  const varCodeMatch = html.match(/var\s+code\s*=\s*`([\s\S]*?)`;/);
  if (varCodeMatch && varCodeMatch[1]) {
    const decoded = he.decode(String(varCodeMatch[1]));
    return { code: decoded.trim(), seeds: extractSeedsFromHtml($) };
  }

  const pres = $("pre");
  for (let i = 0; i < pres.length; i++) {
    const raw = $(pres[i]).text();
    const decoded = he.decode(String(raw));
    if (/^\s*(class |def |import |from )/m.test(decoded)) {
      return { code: decoded.trim(), seeds: extractSeedsFromHtml($) };
    }
  }

  const pageText = he.decode(String($.root().text()));
  const genMatch = pageText.match(/def\s+generate[\s\S]*/);
  if (genMatch) {
    return { code: genMatch[0], seeds: extractSeedsFromHtml($) };
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
async function fetchGeneratorAndSave(urlOrShort: string, genPath: string): Promise<string[]> {
  const url = expandShortNotation(urlOrShort);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const html = await res.text();
  const { code, seeds } = extractPythonFromHtml(html);
  await writeFileAsync(genPath, code, { encoding: "utf8" });
  return seeds;
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

// runSingleSeed now accepts cfg and root; returns result including mainTimeMs
async function runSingleSeed(seed: string, cfg: any, root: string, outputDir: string, outputChannel: vscode.OutputChannel, timeoutMsOverride?: number): Promise<{ seed: string; ok: boolean; exitCode?: number; err?: string; stdout?: string; mainTimeMs?: number }> {
  const pythonPath = cfg.pythonPath || defaultCfg().pythonPath;
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

    // Run generator
    const genStdoutChunks: Buffer[] = [];
    let genStderr = "";
    let genExitCode: number | null = null;

    const genProc = spawn(pythonPath, [wrapperPath], { cwd: root });
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

    // Now run main (compile if C++)
    const mainFileRel = cfg.mainFilename || defaultCfg().mainFilename;
    const mainFile = path.join(root, String(mainFileRel));
    const isCpp = (mainFileRel as string).endsWith(".cpp");

    // helper to finalize
    const finish = (ok: boolean, code?: number, err?: string, outString?: string, mainTimeMs?: number) => {
      const outName = `out_${seedSafe}.txt`;
      try { if (outString !== undefined) fs.writeFileSync(path.join(outputsDir, outName), outString, "utf8"); } catch {}
      // keep the generator input also for debugging (already saved)
      return { seed, ok, exitCode: code, err, stdout: outString, mainTimeMs };
    };

    if (!fs.existsSync(mainFile)) {
      return finish(false, undefined, `Main file not found: ${mainFileRel}`);
    }

    if (isCpp) {
      const exeName = process.platform === "win32" ? "main_exec.exe" : "main_exec";
      const exePath = path.join(root, exeName);
      const compileProc = spawn("g++", ["-O2", "-std=c++17", path.basename(mainFile), "-o", exeName], { cwd: root });
      runningProcesses.get(seedSafe)?.push(compileProc);
      let compileErr = "";
      compileProc.stderr.on("data", (d: Buffer) => compileErr += d.toString());
      const compiled = await new Promise<boolean>((resolve) => {
        compileProc.on("close", (code) => resolve(code === 0));
        compileProc.on("error", () => resolve(false));
      });
      if (!compiled) return finish(false, undefined, `Compilation failed:\n${compileErr}`);
      // run executable, feeding file into stdin
      const mainProc = spawn(exePath, [], { cwd: root });
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
      // pipe file to stdin
      const rs = fs.createReadStream(inFile);
      rs.pipe(mainProc.stdin);
      // measure time for main only (from before piping until close)
      const start = Date.now();
      const timeout = setTimeout(() => { try { mainProc.kill(); } catch {} }, timeoutMs);
      const code = await new Promise<number | null>((resolve) => {
        mainProc.on("close", (c) => { clearTimeout(timeout); resolve(c ?? 0); });
        mainProc.on("error", () => { clearTimeout(timeout); resolve(-1); });
      });
      const end = Date.now();
      const outString = collected.toString("utf8");
      const mainTimeMs = end - start;
      if (exceeded) return finish(false, code ?? undefined, "Output exceeded limit", outString, mainTimeMs);
      if (code !== 0) return finish(false, code ?? undefined, `Main exited with code ${code}. stderr:\n${stderrAll}`, outString, mainTimeMs);
      return finish(true, code ?? undefined, undefined, outString, mainTimeMs);
    } else {
      // Python main
      const mainProc = spawn(pythonPath, [mainFileRel], { cwd: root });
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
      if (exceeded) return finish(false, code ?? undefined, "Output exceeded limit", outString, mainTimeMs);
      if (code !== 0) return finish(false, code ?? undefined, `Main exited with code ${code}. stderr:\n${stderrAll}`, outString, mainTimeMs);
      return finish(true, code ?? undefined, undefined, outString, mainTimeMs);
    }
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
          const seeds = await fetchGeneratorAndSave(input, path.join(root, String(genFilename)));
          outputChannel.appendLine(`Saved ${genFilename} to workspace.`);
          outputChannel.appendLine(`Seeds found: ${seeds.join(", ")}`);
          vscode.window.showInformationMessage(`gen.py saved. Seeds: ${seeds.join(", ")}`);
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
      };

      const urlOrShort = await vscode.window.showInputBox({ prompt: "Enter NPC short (NPC004B) or full URL (leave empty to use existing gen.py)" });
      let seeds: string[] = [];
      const genPath = path.join(root, String(cfg.genFilename));

      if (urlOrShort) {
        try {
          seeds = await fetchGeneratorAndSave(urlOrShort, genPath);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed to fetch generator: ${String(e.message || e)}`);
          return;
        }
      } else {
        if (await fileExists(genPath)) {
          // fallback - try to extract seeds from local gen.py comments (naive)
          // Leave seeds empty to ask user later if none found
        } else {
          vscode.window.showErrorMessage("No gen.py in workspace. Provide a URL or create gen.py first.");
          return;
        }
      }

      if (!seeds || seeds.length === 0) {
        const manual = await vscode.window.showInputBox({ prompt: "No seeds found automatically. Enter seeds separated by spaces or commas (e.g. 10 21 40)" });
        if (!manual) return;
        seeds = manual.split(/[\s,]+/).filter(s => s.trim().length > 0);
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
