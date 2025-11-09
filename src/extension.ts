// src/extension.ts
// Full reworked extension.ts implementing:
// - fetchGenerator (no auto seed extraction)
// - runWithGenerators (generator -> main; supports build and placeholders)
// - runHeuristic (generator -> main -> scorer; sharedVars supported via outputs/shared_<seed>.json)
// - Windows and POSIX timing (cpuTimeMs and realTimeMs), with robust PowerShell wrapper on Windows
// - scorer: parsed -1 => WA
// - summary.md with aggregates: avg score, sum score, max CPU/real, AC count A/B
// - Opens output channel on build/scorer-build failures and other important logs

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
    threads: 0,
    genCommand: "py {wrapper}",
    mainBuildCommand: "g++ main.cpp -o {out}",
    mainRunCommand: "py {main}",
    mainExec: "main_exec",
    scorerFilename: "scorer.py",
    scorerRunCommand: "py {scorer}",
    scorerExec: "scorer_exec",
    scorerBuildCommand: "g++ scorer.cpp -o {out}",
    sharedVars: ""
  };
}

function safeFilenamePart(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

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
          const sum = matches.reduce((acc: number, m: any) => acc + Number(m[1] || 0), 0);
          if (sum > 0) return sum;
        }
      } catch (e) {}
    }
  } catch (e) {}
  const logical = os.cpus()?.length || 1;
  return Math.max(1, Math.floor(logical));
}

// ------------ HTML extraction helpers ------------
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
async function fetchGeneratorAndSave(urlOrShort: string, genPath: string, outputChannel?: vscode.OutputChannel): Promise<string[]> {
  const url = expandShortNotation(urlOrShort);
  const res = await fetch(url);
  if (!res.ok) {
    if (outputChannel) {
      outputChannel.appendLine(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
      outputChannel.show(true);
    }
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const { code } = extractPythonFromHtml(html);
  await writeFileAsync(genPath, code, { encoding: "utf8" });
  return []; // no auto seeds
}

// ---- wrapper content for generator ----
function makeWrapperContent(seed: string, sharedVars: string[] = [], sharedFilePath?: string): string {
  const sharedVarsJson = JSON.stringify(sharedVars || []);
  const sharedFilePathJson = sharedFilePath ? JSON.stringify(sharedFilePath) : "None";
  return `
import sys, io, traceback, re, json, os
src = open('gen.py','r',encoding='utf-8').read()
# remove seed assignment lines to allow wrapper to set seed variable
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
_shared_vars = ${sharedVarsJson}
_shared_path = ${sharedFilePathJson}
if _shared_path is not None:
    try:
        data = {}
        for _k in _shared_vars:
            if _k in g:
                try:
                    json.dumps(g[_k])
                    data[_k] = g[_k]
                except:
                    data[_k] = str(g[_k])
        d = os.path.dirname(_shared_path)
        if d and not os.path.exists(d):
            try:
                os.makedirs(d, exist_ok=True)
            except:
                pass
        with open(_shared_path, 'w', encoding='utf-8') as _f:
            json.dump(data, _f)
    except Exception:
        try:
            traceback.print_exc(file=sys.stderr)
        except:
            pass
`;
}

// Map for running processes
const runningProcesses = new Map<string, ChildProcess[]>();

async function fileExists(p: string): Promise<boolean> {
  try {
    await accessAsync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// runCommandCapture: returns exitCode, stdout, stderr, cpuTimeMs?, realTimeMs?
async function runCommandCapture(runCommand: string, cwd: string, stdinStream: fs.ReadStream | null, timeoutMs: number, maxOutputBytes: number, seedSafeForTracking: string, outputChannel?: vscode.OutputChannel): Promise<{ exitCode: number | null; stdout: string; stderr: string; cpuTimeMs?: number; realTimeMs?: number }> {
  if (process.platform !== "win32") {
    // POSIX branch (unchanged)
    const timePath = "/usr/bin/time";
    const useTime = fs.existsSync(timePath);
    const cpuFile = useTime ? path.join(os.tmpdir(), `npc_cpu_${seedSafeForTracking}_${randomBytes(6).toString("hex")}.txt`) : "";
    let wrappedCmd = runCommand;
    if (useTime) {
      wrappedCmd = `${timePath} -f "%U %S" -o ${JSON.stringify(cpuFile)} sh -c ${JSON.stringify(runCommand)}`;
    } else {
      wrappedCmd = `sh -c ${JSON.stringify(runCommand)}`;
    }

    return new Promise((resolve) => {
      const proc = spawn(wrappedCmd, { cwd, shell: true });
      runningProcesses.set(seedSafeForTracking, (runningProcesses.get(seedSafeForTracking) || []).concat([proc]));

      let collected = Buffer.alloc(0);
      let stderrAll = "";
      if (proc.stderr) proc.stderr.on("data", d => { stderrAll += d.toString(); });
      if (proc.stdout) {
        proc.stdout.on("data", (chunk: Buffer) => {
          collected = Buffer.concat([collected, chunk]);
          if (collected.length > maxOutputBytes) { try { proc.kill(); } catch {} }
        });
      }

      if (stdinStream && proc.stdin) {
        stdinStream.pipe(proc.stdin);
      } else if (proc.stdin) {
        try { proc.stdin.end(); } catch {}
      }

      const start = Date.now();
      const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timer);
        const end = Date.now();
        const realMs = end - start;
        const outStr = collected.toString("utf8");
        if (useTime) {
          try {
            const cpuText = fs.existsSync(cpuFile) ? fs.readFileSync(cpuFile, "utf8").trim() : "";
            if (cpuText) {
              const parts = cpuText.trim().split(/\s+/);
              if (parts.length >= 2) {
                const user = parseFloat(parts[0]) || 0;
                const sys = parseFloat(parts[1]) || 0;
                const cpuMs = Math.round((user + sys) * 1000);
                try { fs.unlinkSync(cpuFile); } catch {}
                const arr = runningProcesses.get(seedSafeForTracking) || [];
                runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
                resolve({ exitCode: code ?? 0, stdout: outStr, stderr: stderrAll, cpuTimeMs: cpuMs, realTimeMs: realMs });
                return;
              }
            }
          } catch (e) {
            if (outputChannel) { outputChannel.appendLine(`Warning reading cpu file: ${String(e)}`); outputChannel.show(true); }
          }
        }
        const arr = runningProcesses.get(seedSafeForTracking) || [];
        runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
        resolve({ exitCode: code ?? 0, stdout: outStr, stderr: stderrAll, realTimeMs: realMs });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        const arr = runningProcesses.get(seedSafeForTracking) || [];
        runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
        resolve({ exitCode: -1, stdout: collected.toString("utf8"), stderr: (err && String(err)) || "" });
      });
    });
  } else {
    // Windows: improved wrapper that tries to run the executable directly when the command is "simple".
    // If the command contains shell metacharacters, fallback to cmd.exe /c.
    const psPath = path.join(os.tmpdir(), `npc_win_wrapper_${seedSafeForTracking}_${randomBytes(6).toString("hex")}.ps1`);
    const psContent = `
param([string] $cmd)
# read stdin (if any)
try {
  $stdinData = [Console]::In.ReadToEnd()
} catch {
  $stdinData = ""
}
$sw = [System.Diagnostics.Stopwatch]::StartNew()

function EmitResult($cpu, $real, $out, $err, $exit) {
  $res = @{ cpu = $cpu; real = $real; stdout = $out; stderr = $err; exit = $exit }
  $res | ConvertTo-Json -Compress
}

# detect if command is simple (no pipes/redirs/etc)
if ($cmd -match '[\\|&<>;*?^()|]') {
  $useCmd = $true
} else {
  $useCmd = $false
}

try {
  if (-not $useCmd) {
    # naive tokenization: split respecting quoted tokens (double or single)
    $m = [regex]'"([^"]*)"|''([^'']*)''|([^\\s]+)'
    $parts = @()
    foreach ($mm in $m.Matches($cmd)) {
      if ($mm.Groups[1].Success) { $parts += $mm.Groups[1].Value }
      elseif ($mm.Groups[2].Success) { $parts += $mm.Groups[2].Value }
      else { $parts += $mm.Groups[3].Value }
    }
    if ($parts.Count -ge 1) {
      $file = $parts[0]
      $args = ""
      if ($parts.Count -gt 1) {
        $args = ($parts[1..($parts.Count-1)] | ForEach-Object { $_ }) -join ' '
      }
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $file
      $psi.Arguments = $args
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError  = $true
      $psi.RedirectStandardInput = $true
      $psi.UseShellExecute = $false
      $psi.CreateNoWindow = $true

      $p = New-Object System.Diagnostics.Process
      $p.StartInfo = $psi
      $started = $p.Start()
      if ($stdinData -ne $null -and $stdinData.Length -gt 0) {
        try { $p.StandardInput.Write($stdinData) } catch {}
      }
      try { $p.StandardInput.Close() } catch {}
      $out = $p.StandardOutput.ReadToEnd()
      $err = $p.StandardError.ReadToEnd()
      $p.WaitForExit()
      $sw.Stop()
      $realMs = [int]$sw.ElapsedMilliseconds
      $cpuMainMs = 0
      try { $cpuMainMs = [int]([math]::Round($p.TotalProcessorTime.TotalMilliseconds)) } catch {}
      EmitResult $cpuMainMs $realMs $out $err $p.ExitCode
      exit 0
    } else {
      # fallback
      $useCmd = $true
    }
  }

  if ($useCmd) {
    $psi2 = New-Object System.Diagnostics.ProcessStartInfo
    $psi2.FileName = "cmd.exe"
    $psi2.Arguments = "/c " + $cmd
    $psi2.RedirectStandardOutput = $true
    $psi2.RedirectStandardError  = $true
    $psi2.RedirectStandardInput = $true
    $psi2.UseShellExecute = $false
    $psi2.CreateNoWindow = $true

    $p2 = New-Object System.Diagnostics.Process
    $p2.StartInfo = $psi2
    $p2.Start() | Out-Null
    if ($stdinData -ne $null -and $stdinData.Length -gt 0) {
      try { $p2.StandardInput.Write($stdinData) } catch {}
    }
    try { $p2.StandardInput.Close() } catch {}
    $out2 = $p2.StandardOutput.ReadToEnd()
    $err2 = $p2.StandardError.ReadToEnd()
    $p2.WaitForExit()
    $sw.Stop()
    $realMs2 = [int]$sw.ElapsedMilliseconds
    $cpuMainMs2 = 0
    try { $cpuMainMs2 = [int]([math]::Round($p2.TotalProcessorTime.TotalMilliseconds)) } catch {}
    EmitResult $cpuMainMs2 $realMs2 $out2 $err2 $p2.ExitCode
    exit 0
  }
} catch {
  $sw.Stop()
  $e = $_.Exception.ToString()
  EmitResult 0 ([int]$sw.ElapsedMilliseconds) "" $e -1
  exit 0
}
`;
    try {
      fs.writeFileSync(psPath, psContent, "utf8");
    } catch (e) {
      if (outputChannel) { outputChannel.appendLine(`Failed to write PowerShell wrapper: ${String(e)}`); outputChannel.show(true); }
      // fallback naive spawn (real time only)
      return new Promise((resolve) => {
        const proc = spawn(runCommand, { cwd, shell: true });
        runningProcesses.set(seedSafeForTracking, (runningProcesses.get(seedSafeForTracking) || []).concat([proc]));
        let collected = Buffer.alloc(0);
        let stderrAll = "";
        if (proc.stdout) proc.stdout.on("data", (b: Buffer) => { collected = Buffer.concat([collected, b]); if (collected.length > maxOutputBytes) try { proc.kill(); } catch {} });
        if (proc.stderr) proc.stderr.on("data", (d: Buffer) => { stderrAll += d.toString(); });
        if (stdinStream && proc.stdin) { stdinStream.pipe(proc.stdin); } else if (proc.stdin) { try { proc.stdin.end(); } catch {} }
        const start = Date.now();
        const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
        proc.on("close", (code) => {
          clearTimeout(timer);
          const end = Date.now();
          const realMs = end - start;
          const arr = runningProcesses.get(seedSafeForTracking) || [];
          runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
          resolve({ exitCode: code ?? 0, stdout: collected.toString("utf8"), stderr: stderrAll, realTimeMs: realMs });
        });
        proc.on("error", (err) => {
          clearTimeout(timer);
          const arr = runningProcesses.get(seedSafeForTracking) || [];
          runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
          resolve({ exitCode: -1, stdout: collected.toString("utf8"), stderr: (err && String(err)) || "" });
        });
      });
    }

    return new Promise((resolve) => {
      const proc = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath, runCommand], { cwd, stdio: ["pipe","pipe","pipe"] });
      runningProcesses.set(seedSafeForTracking, (runningProcesses.get(seedSafeForTracking) || []).concat([proc]));

      let collected = Buffer.alloc(0);
      let stderrAll = "";
      if (proc.stdout) proc.stdout.on("data", (b: Buffer) => { collected = Buffer.concat([collected, b]); if (collected.length > maxOutputBytes) try { proc.kill(); } catch {} });
      if (proc.stderr) proc.stderr.on("data", (d: Buffer) => { stderrAll += d.toString(); });

      // pipe stdinStream into powershell wrapper
      if (stdinStream && proc.stdin) {
        stdinStream.pipe(proc.stdin);
      } else if (proc.stdin) {
        try { proc.stdin.end(); } catch {}
      }

      const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timer);
        const arr = runningProcesses.get(seedSafeForTracking) || [];
        runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
        const txt = collected.toString("utf8").trim();
        try {
          if (txt) {
            const obj = JSON.parse(txt);
            const cpu = typeof obj.cpu === "number" ? obj.cpu : undefined;
            const real = typeof obj.real === "number" ? obj.real : undefined;
            const stdout = typeof obj.stdout === "string" ? obj.stdout : "";
            const stderrFrom = typeof obj.stderr === "string" ? obj.stderr : "";
            const stderrAllCombined = stderrAll + (stderrFrom ? ("\n" + stderrFrom) : "");
            try { fs.unlinkSync(psPath); } catch {}
            resolve({ exitCode: obj.exit ?? code ?? 0, stdout: stdout, stderr: stderrAllCombined, cpuTimeMs: cpu, realTimeMs: real });
            return;
          } else {
            try { fs.unlinkSync(psPath); } catch {}
            resolve({ exitCode: code ?? 0, stdout: "", stderr: stderrAll });
            return;
          }
        } catch (e) {
          if (outputChannel) { outputChannel.appendLine(`Failed to parse PowerShell wrapper output: ${String(e)}`); outputChannel.show(true); }
          try { fs.unlinkSync(psPath); } catch {}
          resolve({ exitCode: code ?? 0, stdout: txt, stderr: stderrAll });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        const arr = runningProcesses.get(seedSafeForTracking) || [];
        runningProcesses.set(seedSafeForTracking, arr.filter(p => p !== proc));
        try { fs.unlinkSync(psPath); } catch {}
        resolve({ exitCode: -1, stdout: collected.toString("utf8"), stderr: (err && String(err)) || "" });
      });
    });
  }
}


// ---- runSingleSeed: generator -> main ----
async function runSingleSeed(seed: string, cfg: any, root: string, outputDir: string, outputChannel: vscode.OutputChannel, timeoutMsOverride?: number): Promise<{ seed: string; ok: boolean; exitCode?: number; err?: string; stdout?: string; mainTimeMs?: number; realTimeMs?: number }> {
  const timeoutMs = timeoutMsOverride ?? (cfg.timeoutMs ?? defaultCfg().timeoutMs);
  const maxOutputBytes = cfg.maxOutputBytes ?? defaultCfg().maxOutputBytes;

  const wrapperName = `__npc_wrapper_${safeFilenamePart(seed)}_${randomBytes(6).toString("hex")}.py`;
  const wrapperPath = path.join(os.tmpdir(), wrapperName);
  const seedSafe = safeFilenamePart(seed);

  runningProcesses.set(seedSafe, []);
  const outputsDir = path.join(outputDir, "outputs");
  if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });
  const sharedFilePath = path.join(outputsDir, `shared_${seedSafe}.json`);
  const sharedVars: string[] = (cfg.sharedVars && String(cfg.sharedVars).trim().length > 0) ? String(cfg.sharedVars).split(/\s*,\s*/).map((s:string)=>s.trim()).filter(Boolean) : [];

  try {
    await writeFileAsync(wrapperPath, makeWrapperContent(seed, sharedVars, sharedVars.length > 0 ? sharedFilePath : undefined), { encoding: "utf8" });

    // run generator
    const genCommandTemplate = cfg.genCommand || defaultCfg().genCommand;
    const genCommand = genCommandTemplate.replace(/\{wrapper\}/g, `"${wrapperPath}"`).replace(/\{out\}/g, `"${cfg.mainExec || defaultCfg().mainExec}"`);
    const genStdoutChunks: Buffer[] = [];
    let genStderr = "";
    let genExitCode: number | null = null;
    const genProc = spawn(genCommand, { cwd: root, shell: true });
    runningProcesses.get(seedSafe)?.push(genProc);
    genProc.stdout?.on("data", (b: Buffer) => genStdoutChunks.push(b));
    genProc.stderr?.on("data", (d: Buffer) => { genStderr += d.toString(); });

    const genPromise = new Promise<void>((resolve) => {
      const genTimeout = setTimeout(() => { try { genProc.kill(); } catch {} genExitCode = -1; resolve(); }, timeoutMs);
      genProc.on("close", (code) => { clearTimeout(genTimeout); genExitCode = code ?? 0; resolve(); });
      genProc.on("error", () => { clearTimeout(genTimeout); genExitCode = -1; resolve(); });
    });
    await genPromise;
    const genOutput = Buffer.concat(genStdoutChunks).toString("utf8");

    const inputsDir = path.join(outputDir, "inputs");
    if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir, { recursive: true });

    try { fs.writeFileSync(path.join(outputsDir, `out_gen_${seedSafe}.txt`), genOutput + "\n", "utf8"); } catch {}

    if (genExitCode !== 0) {
      const msg = `Generator failed (exit ${genExitCode}). stderr:\n${genStderr}`;
      return { seed, ok: false, exitCode: typeof genExitCode === "number" ? genExitCode : undefined, err: msg, stdout: genOutput };
    }
    if (!genOutput || !genOutput.trim()) {
      const msg = `Generator produced no stdout. stderr:\n${genStderr}`;
      return { seed, ok: false, err: msg, stdout: genOutput };
    }

    // write input file
    const inFile = path.join(inputsDir, `in_${seedSafe}.txt`);
    try { fs.writeFileSync(inFile, genOutput, "utf8"); } catch (e:any) { return { seed, ok: false, err: `Failed to write generator input file: ${String(e)}` }; }

    // run main
    const mainRunTemplate = cfg.mainRunCommand || defaultCfg().mainRunCommand;
    const mainFilename = cfg.mainFilename || defaultCfg().mainFilename;
    const mainExec = cfg.mainExec || defaultCfg().mainExec;
    let runCommand = String(mainRunTemplate)
      .replace(/\{main\}/g, `${mainFilename}`)
      .replace(/\{exe\}/g, `${mainExec}`)
      .replace(/\{out\}/g, `${mainExec}`);

    // Keep quoting behavior simple — wrapper handles shell on Windows
    if (!/^\s*["']/.test(runCommand) && runCommand.includes(" ")) {
      // leave as is; shell=true will handle it
    }

    let rs: fs.ReadStream | null = null;
    try { rs = fs.createReadStream(inFile); } catch { rs = null; }

    const runResult = await runCommandCapture(runCommand, root, rs, timeoutMs, maxOutputBytes, seedSafe, outputChannel);
    const outString = runResult.stdout ?? "";
    const code = runResult.exitCode ?? -1;
    const cpuMs = runResult.cpuTimeMs;
    const realMs = runResult.realTimeMs;

    if (outString && outString.length > 0) {
      try { fs.writeFileSync(path.join(outputsDir, `out_${seedSafe}.txt`), outString, "utf8"); } catch {}
    }

    if (code !== 0) {
      return { seed, ok: false, exitCode: code ?? undefined, err: `Main exited with code ${code}. stderr:\n${runResult.stderr}`, stdout: outString, mainTimeMs: cpuMs, realTimeMs: realMs };
    }

    return { seed, ok: true, exitCode: code ?? undefined, stdout: outString, mainTimeMs: cpuMs, realTimeMs: realMs };
  } finally {
    try { if (fs.existsSync(wrapperPath)) fs.unlinkSync(wrapperPath); } catch {}
    runningProcesses.delete(seedSafe);
  }
}

// ---- runScorer: runs scorer with NPC_SHARED_FILE env var; parse numeric score; -1 => WA ----
async function runScorer(seed: string, cfg: any, root: string, outputDir: string, outputChannel: vscode.OutputChannel, timeoutMsOverride?: number): Promise<{ ok: boolean; exitCode?: number; err?: string; stdout?: string; parsedScore?: number }> {
  const timeoutMs = timeoutMsOverride ?? (cfg.timeoutMs ?? defaultCfg().timeoutMs);
  const maxOutputBytes = cfg.maxOutputBytes ?? defaultCfg().maxOutputBytes;
  const seedSafe = safeFilenamePart(seed);
  const outputsDir = path.join(outputDir, "outputs");
  const mainOutFile = path.join(outputsDir, `out_${seedSafe}.txt`);
  if (!fs.existsSync(mainOutFile)) {
    return { ok: false, err: "Main output file not found for scorer." };
  }

  const scorerRunTemplate = cfg.scorerRunCommand || defaultCfg().scorerRunCommand;
  const scorerFilename = cfg.scorerFilename || defaultCfg().scorerFilename;
  const scorerExec = cfg.scorerExec || defaultCfg().scorerExec;
  let runCommand = String(scorerRunTemplate)
    .replace(/\{scorer\}/g, `${scorerFilename}`)
    .replace(/\{exe\}/g, `${scorerExec}`)
    .replace(/\{out\}/g, `${scorerExec}`);

  runningProcesses.set(seedSafe, []);
  try {
    const proc = spawn(runCommand, { cwd: root, shell: true, env: { ...process.env, NPC_SHARED_FILE: path.join(outputsDir, `shared_${seedSafe}.json`) } });
    runningProcesses.get(seedSafe)?.push(proc);

    let collected = Buffer.alloc(0);
    let stderrAll = "";
    let exceeded = false;
    if (proc.stderr) proc.stderr.on("data", d => { stderrAll += d.toString(); });
    if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        collected = Buffer.concat([collected, chunk]);
        if (collected.length > maxOutputBytes) { exceeded = true; try { proc.kill(); } catch {} }
      });
    }

    const rs = fs.createReadStream(mainOutFile);
    rs.pipe(proc.stdin);

    const timeout = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    const code = await new Promise<number | null>((resolve) => {
      proc.on("close", (c) => { clearTimeout(timeout); resolve(c ?? 0); });
      proc.on("error", () => { clearTimeout(timeout); resolve(-1); });
    });
    const outString = collected.toString("utf8");

    if (exceeded) {
      return { ok: false, exitCode: code ?? undefined, err: "Scorer output exceeded limit", stdout: outString };
    }
    if (code !== 0) {
      return { ok: false, exitCode: code ?? undefined, err: `Scorer exited with code ${code}. stderr:\n${stderrAll}`, stdout: outString };
    }

    // parse numeric score (first number)
    let parsed: number | undefined = undefined;
    const sTrim = outString.trim();
    if (sTrim.length > 0) {
      const m = sTrim.match(/-?\d+(\.\d+)?/);
      if (m) parsed = Number(m[0]);
    }

    if (typeof parsed === "number" && parsed === -1) {
      return { ok: false, exitCode: code ?? undefined, err: "Scorer returned -1 (WA)", stdout: outString, parsedScore: parsed };
    }

    return { ok: true, exitCode: code ?? undefined, stdout: outString, parsedScore: parsed };
  } finally {
    runningProcesses.delete(seedSafe);
  }
}

// ---- kill helpers ----
function killAllRunning() {
  for (const [seed, procs] of Array.from(runningProcesses.entries())) {
    for (const p of procs) {
      try { p.kill(); } catch {}
    }
  }
  runningProcesses.clear();
}

// ---- Summary writer helper with aggregates ----
function writeSummaryWithStats(outdir: string, seeds: string[], results: any[], threads: number, root: string, outputChannel: vscode.OutputChannel, title: string = "NPC Run Summary") {
  const summaryMdPath = path.join(outdir, "summary.md");
  const mdLines: string[] = [];
  mdLines.push(`# ${title}`);
  mdLines.push("");
  mdLines.push(`**Workspace:** ${root}`);
  mdLines.push(`**Date:** ${new Date().toISOString()}`);
  mdLines.push(`**Threads used:** ${threads}`);
  mdLines.push("");
  mdLines.push("| # | seed | status | err | score | maintime(ms) | realtime(ms) |");
  mdLines.push("|---:|:---|:---:|:---|:---:|---:|---:|");

  // collect values for aggregates
  const scores: number[] = [];
  const cpuTimes: number[] = [];
  const realTimes: number[] = [];
  let scorerPresent = false;
  let acScorerCount = 0;
  let okMainCount = 0;

  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    const r = results[i];
    if (!r) {
      mdLines.push(`| ${i+1} | ${s} | NO_RESULT |  |  |  |  |`);
      continue;
    }

    let status = "";
    let errStr = "";
    let scoreVal: number | null = null;
    let cpuVal: number | null = null;
    let realVal: number | null = null;

    if (typeof r.main_ok !== "undefined" || typeof r.scorer_ok !== "undefined") {
      // heuristic-style
      const main_ok = r.main_ok === true;
      const scorer_ok = r.scorer_ok === true ? true : (r.scorer_ok === false ? false : undefined);
      if (!main_ok) {
        if (r.main_err && (/kill|timed|Time|timeout/i.test(r.main_err) || /Output exceeded limit/.test(r.main_err))) status = "TLE/ERR";
        else status = "MAIN_FAIL";
      } else {
        if (scorer_ok === true) status = "AC";
        else if (scorer_ok === false) status = "WA";
        else status = "NO_SCORER";
      }
      errStr = (r.scorer_err ? String(r.scorer_err) : (r.main_err ? String(r.main_err) : "")).replace(/\|/g,'\\|').replace(/\n/g,' ');
      if (typeof r.scorer_score === "number") { scoreVal = r.scorer_score; scorerPresent = true; }
      else if (typeof r.scorer_score === "string" && r.scorer_score.trim() !== "" && !isNaN(Number(r.scorer_score))) { scoreVal = Number(r.scorer_score); scorerPresent = true; }
      if (typeof r.mainTimeMs === "number") cpuVal = r.mainTimeMs;
      if (typeof r.realTimeMs === "number") realVal = r.realTimeMs;

      if (scorer_ok === true) acScorerCount++;
      if (main_ok) okMainCount++;
    } else {
      // simple runWithGenerators result
      const ok = r.ok === true;
      if (!ok) {
        if (r.err && (/kill|timed|Time|timeout/i.test(r.err) || /Output exceeded limit/.test(r.err))) status = "TLE/ERR";
        else status = "MAIN_FAIL";
      } else {
        status = "OK";
      }
      errStr = r.err ? String(r.err).replace(/\|/g,'\\|').replace(/\n/g,' ') : "";
      if (typeof r.scorer_score === "number") { scoreVal = r.scorer_score; scorerPresent = true; }
      if (typeof r.parsedScore === "number") { scoreVal = r.parsedScore; scorerPresent = true; }
      if (typeof r.mainTimeMs === "number") cpuVal = r.mainTimeMs;
      if (typeof r.realTimeMs === "number") realVal = r.realTimeMs;

      if (ok) okMainCount++;
    }

    if (typeof scoreVal === "number" && Number.isFinite(scoreVal)) scores.push(scoreVal);
    if (typeof cpuVal === "number" && Number.isFinite(cpuVal)) cpuTimes.push(cpuVal);
    if (typeof realVal === "number" && Number.isFinite(realVal)) realTimes.push(realVal);

    const scoreStr = (typeof scoreVal === "number") ? String(scoreVal) : "";
    const timeStr = (typeof cpuVal === "number" && cpuVal > 0) ? String(cpuVal) : "-";
    const realStr = (typeof realVal === "number" && realVal > 0) ? String(realVal) : "-";

    mdLines.push(`| ${i+1} | ${s} | ${status} | ${errStr} | ${scoreStr} | ${timeStr} | ${realStr} |`);
  }

  // aggregates
  const totalSeeds = seeds.length;
  const sumScore = scores.reduce((a,b) => a + b, 0);
  const avgScore = scores.length > 0 ? (sumScore / scores.length) : null;
  const maxCpu = cpuTimes.length > 0 ? Math.max(...cpuTimes) : null;
  const maxReal = realTimes.length > 0 ? Math.max(...realTimes) : null;

  mdLines.push("");
  mdLines.push("## Aggregates");
  mdLines.push("");
  mdLines.push(`- **平均スコア (平均 over scored seeds):** ${avgScore !== null ? avgScore.toFixed(3) : "-"}`);
  mdLines.push(`- **総合スコア (sum over scored seeds):** ${scores.length > 0 ? String(sumScore) : "-"}`);
  mdLines.push(`- **最大 maintime (ms):** ${maxCpu !== null ? String(maxCpu) : "-"}`);
  mdLines.push(`- **最大 realtime (ms):** ${maxReal !== null ? String(maxReal) : "-"}`);

  let acCountStr = "-";
  if (scorerPresent) {
    acCountStr = `${acScorerCount}/${totalSeeds}`;
  } else {
    acCountStr = `${okMainCount}/${totalSeeds}`;
  }
  mdLines.push(`- **AC数 (A/B):** ${acCountStr}`);

  try {
    fs.writeFileSync(summaryMdPath, mdLines.join("\n"), "utf8");
    outputChannel.appendLine(`Summary written to ${summaryMdPath}`);
  } catch (e:any) {
    outputChannel.appendLine(`Failed to write summary: ${String(e)}`);
  }
}

// ---- activation / commands ----
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
          await fetchGeneratorAndSave(input, path.join(root, String(genFilename)), outputChannel);
          outputChannel.appendLine(`Saved ${genFilename} to workspace.`);
          vscode.window.showInformationMessage(`gen.py saved. (Seed auto-extraction disabled — please enter seeds manually when running.)`);
          const doc = await vscode.workspace.openTextDocument(path.join(root, String(genFilename)));
          await vscode.window.showTextDocument(doc);
        } catch (e: any) {
          outputChannel.appendLine(`Error fetching generator: ${String(e)}`);
          outputChannel.show(true);
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
        sharedVars: config.get("sharedVars") ?? defaultCfg().sharedVars
      };

      const urlOrShort = await vscode.window.showInputBox({ prompt: "Enter NPC short (NPC004B) or full URL to fetch generator (leave empty to use existing gen.py)" });
      const genPath = path.join(root, String(cfg.genFilename));
      if (urlOrShort) {
        try {
          await fetchGeneratorAndSave(urlOrShort, genPath, outputChannel);
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

      const manual = await vscode.window.showInputBox({ prompt: "Enter seeds separated by spaces or commas (e.g. 10 21 40)" });
      if (!manual) return;
      const seeds = manual.split(/[\s,]+/).filter(s => s.trim().length > 0);
      if (seeds.length === 0) {
        vscode.window.showErrorMessage("No seeds provided.");
        return;
      }

      outputChannel.appendLine(`Running seeds: ${seeds.join(", ")}`);

      const outdir = path.resolve(root, String(cfg.outputDir ?? defaultCfg().outputDir));
      if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });
      const inputsDir = path.join(outdir, "inputs");
      const outputsDir = path.join(outdir, "outputs");
      if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir, { recursive: true });
      if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

      const results: Array<any> = [];

      let threads = Number(cfg.threads) || 0;
      if (threads <= 0) threads = getPhysicalCoreCount();

      outputChannel.appendLine(`Using threads: ${threads} (physical cores)`);

      // Build main if specified
      if (cfg.mainBuildCommand && String(cfg.mainBuildCommand).trim().length > 0) {
        outputChannel.appendLine(`Running build: ${cfg.mainBuildCommand}`);
        try {
          let buildCommandStr = String(cfg.mainBuildCommand).replace(/\{out\}/g, `${cfg.mainExec}`);
          const buildProc = spawn(buildCommandStr, { cwd: root, shell: true });
          runningProcesses.set("build", [buildProc]);
          let buildErr = "";
          buildProc.stderr?.on("data", (d: Buffer) => { buildErr += d.toString(); });
          const buildExit = await new Promise<number>((resolve) => {
            buildProc.on("close", (c) => resolve(c ?? 0));
            buildProc.on("error", () => resolve(-1));
          });
          runningProcesses.delete("build");
          if (buildExit !== 0) {
            outputChannel.appendLine(`Build failed (exit ${buildExit}): ${buildErr}`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`Build failed (exit ${buildExit}). See output channel for details.`);
            return;
          }
          outputChannel.appendLine("Build succeeded.");
        } catch (e:any) {
          outputChannel.appendLine(`Build exception: ${String(e)}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`Build failed: ${String(e)}`);
          return;
        }
      }

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
              if (r.ok) { outputChannel.appendLine(`Seed ${s}: OK (cpu=${r.mainTimeMs ?? "N/A"} ms realtime=${r.realTimeMs ?? "N/A"} ms)`); } else { outputChannel.appendLine(`Seed ${s}: FAILED - ${r.err}`); }
            } catch (e:any) {
              outputChannel.appendLine(`Seed ${s}: Exception - ${String(e)}`);
              results[myIndex] = { seed: s, ok: false, err: String(e) };
            }
            completed++;
            progress.report({ message: `Completed ${completed}/${total}`, increment: (100 / total) });
          }
        };

        for (let i = 0; i < threads; i++) {
          queue.push(worker());
        }
        await Promise.all(queue);
      });

      // combine outputs
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

      // write summary with stats
      try {
        writeSummaryWithStats(outdir, seeds, results, threads, root, outputChannel, "NPC Run Summary");
        try {
          const doc = await vscode.workspace.openTextDocument(path.join(outdir, "summary.md"));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {}
      } catch (e:any) {
        outputChannel.appendLine(`Failed to write summary: ${String(e)}`);
      }

    } catch (e: any) {
      vscode.window.showErrorMessage(String(e.message || e));
    }
  });

  // heuristic command (gen -> main -> scorer)
  const runHeuristicCommand = vscode.commands.registerCommand("npc.runHeuristic", async () => {
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
        scorerFilename: config.get("scorerFilename") || defaultCfg().scorerFilename,
        scorerRunCommand: config.get("scorerRunCommand") || defaultCfg().scorerRunCommand,
        scorerExec: config.get("scorerExec") || defaultCfg().scorerExec,
        scorerBuildCommand: config.get("scorerBuildCommand") || defaultCfg().scorerBuildCommand,
        sharedVars: config.get("sharedVars") ?? defaultCfg().sharedVars,
      };

      const urlOrShort = await vscode.window.showInputBox({ prompt: "Enter NPC short (NPC004B) or full URL to fetch generator (leave empty to use existing gen.py)" });
      const genPath = path.join(root, String(cfg.genFilename));
      if (urlOrShort) {
        try {
          await fetchGeneratorAndSave(urlOrShort, genPath, outputChannel);
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

      const mainPath = path.join(root, String(cfg.mainFilename));
      if (!(await fileExists(mainPath))) {
        const ok = await vscode.window.showWarningMessage("main file not found in workspace. Continue without main build/run?", "Cancel");
        if (ok === "Cancel") return;
      }
      const scorerPath = path.join(root, String(cfg.scorerFilename));
      if (!(await fileExists(scorerPath))) {
        const ok = await vscode.window.showWarningMessage("scorer file not found in workspace. Continue without scorer (just run main)?", "Continue", "Cancel");
        if (ok !== "Continue") return;
      }

      const manual = await vscode.window.showInputBox({ prompt: "Enter seeds separated by spaces or commas (e.g. 10 21 40)" });
      if (!manual) return;
      const seeds = manual.split(/[\s,]+/).filter(s => s.trim().length > 0);
      if (seeds.length === 0) {
        vscode.window.showErrorMessage("No seeds provided.");
        return;
      }

      outputChannel.appendLine(`Heuristic run seeds: ${seeds.join(", ")}`);

      const outdir = path.resolve(root, String(cfg.outputDir ?? defaultCfg().outputDir));
      if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });
      const inputsDir = path.join(outdir, "inputs");
      const outputsDir = path.join(outdir, "outputs");
      if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir, { recursive: true });
      if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

      const results: Array<any> = [];

      let threads = Number(cfg.threads) || 0;
      if (threads <= 0) threads = getPhysicalCoreCount();
      outputChannel.appendLine(`Using threads: ${threads} (physical cores)`);

      // build main
      if (cfg.mainBuildCommand && String(cfg.mainBuildCommand).trim().length > 0) {
        outputChannel.appendLine(`Running build: ${cfg.mainBuildCommand}`);
        try {
          let buildCommandStr = String(cfg.mainBuildCommand).replace(/\{out\}/g, `${cfg.mainExec}`);
          const buildProc = spawn(buildCommandStr, { cwd: root, shell: true });
          runningProcesses.set("build", [buildProc]);
          let buildErr = "";
          buildProc.stderr?.on("data", (d: Buffer) => { buildErr += d.toString(); });
          const buildExit = await new Promise<number>((resolve) => {
            buildProc.on("close", (c) => resolve(c ?? 0));
            buildProc.on("error", () => resolve(-1));
          });
          runningProcesses.delete("build");
          if (buildExit !== 0) {
            outputChannel.appendLine(`Build failed (exit ${buildExit}): ${buildErr}`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`Build failed (exit ${buildExit}). See output channel for details.`);
            return;
          }
          outputChannel.appendLine("Build succeeded.");
        } catch (e:any) {
          outputChannel.appendLine(`Build exception: ${String(e)}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`Build failed: ${String(e)}`);
          return;
        }
      }

      // build scorer
      if ((cfg.scorerBuildCommand && String(cfg.scorerBuildCommand).trim().length > 0) && (await fileExists(path.join(root, String(cfg.scorerFilename))))) {
        outputChannel.appendLine(`Running scorer build: ${cfg.scorerBuildCommand}`);
        try {
          let buildCommandStr = String(cfg.scorerBuildCommand).replace(/\{out\}/g, `${cfg.scorerExec}`);
          const buildProc = spawn(buildCommandStr, { cwd: root, shell: true });
          runningProcesses.set("scorer_build", [buildProc]);
          let buildErr = "";
          buildProc.stderr?.on("data", (d: Buffer) => { buildErr += d.toString(); });
          const buildExit = await new Promise<number>((resolve) => {
            buildProc.on("close", (c) => resolve(c ?? 0));
            buildProc.on("error", () => resolve(-1));
          });
          runningProcesses.delete("scorer_build");
          if (buildExit !== 0) {
            outputChannel.appendLine(`Scorer build failed (exit ${buildExit}): ${buildErr}`);
            outputChannel.show(true);
            vscode.window.showErrorMessage(`Scorer build failed (exit ${buildExit}). See output channel for details.`);
            return;
          }
          outputChannel.appendLine("Scorer build succeeded.");
        } catch (e:any) {
          outputChannel.appendLine(`Scorer build exception: ${String(e)}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`Scorer build failed: ${String(e)}`);
          return;
        }
      }

      let cancelled = false;

      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Heuristic run — threads: ${threads}`, cancellable: true }, async (progress, token) => {
        const total = seeds.length;
        let completed = 0;
        const queue: Promise<void>[] = [];
        let idx = 0;

        token.onCancellationRequested(() => {
          cancelled = true;
          outputChannel.appendLine("Cancellation requested — killing running processes...");
          killAllRunning();
        });

        const worker = async () => {
          while (true) {
            if (cancelled) return;
            const myIndex = idx;
            idx++;
            if (myIndex >= seeds.length) return;
            const s = seeds[myIndex];
            progress.report({ message: `Running seed ${s} (${myIndex + 1}/${total})`, increment: (100 / total) });
            outputChannel.appendLine(`=== Heuristic Seed ${s} ===`);
            try {
              const r = await runSingleSeed(s, cfg, root, outdir, outputChannel);
              const resObj: any = {
                seed: s,
                main_ok: r.ok ?? false,
                main_exitCode: r.exitCode,
                main_err: r.err,
                main_stdout: r.stdout,
                mainTimeMs: r.mainTimeMs,
                realTimeMs: r.realTimeMs,
                scorer_ok: null,
                scorer_exitCode: null,
                scorer_err: null,
                scorer_stdout: null,
                scorer_score: null
              };

              if (r.ok) {
                outputChannel.appendLine(`Seed ${s}: main OK (cpu=${r.mainTimeMs ?? "N/A"} ms realtime=${r.realTimeMs ?? "N/A"} ms) — running scorer...`);
                if (await fileExists(path.join(root, String(cfg.scorerFilename)))) {
                  try {
                    const sc = await runScorer(s, cfg, root, outdir, outputChannel);
                    resObj.scorer_ok = sc.ok;
                    resObj.scorer_exitCode = sc.exitCode;
                    resObj.scorer_err = sc.err;
                    resObj.scorer_stdout = sc.stdout;
                    resObj.scorer_score = sc.parsedScore ?? null;
                    if (sc.ok) {
                      outputChannel.appendLine(`Seed ${s}: scorer OK (score: ${sc.parsedScore ?? "N/A"})`);
                    } else {
                      outputChannel.appendLine(`Seed ${s}: scorer FAILED - ${sc.err}`);
                    }
                  } catch (e:any) {
                    resObj.scorer_ok = false;
                    resObj.scorer_err = String(e);
                    outputChannel.appendLine(`Seed ${s}: scorer exception - ${String(e)}`);
                  }
                } else {
                  outputChannel.appendLine(`Seed ${s}: scorer not found — skipping scorer.`);
                }
              } else {
                outputChannel.appendLine(`Seed ${s}: main FAILED - ${r.err} (skip scorer)`);
              }

              results[myIndex] = resObj;
            } catch (e:any) {
              outputChannel.appendLine(`Seed ${s}: Exception - ${String(e)}`);
              results[myIndex] = { seed: s, main_ok: false, main_err: String(e) };
            }
            completed++;
            progress.report({ message: `Completed ${completed}/${total}`, increment: (100 / total) });
          }
        };

        for (let i = 0; i < threads; i++) {
          queue.push(worker());
        }
        await Promise.all(queue);
      });

      // combine outputs
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
        vscode.window.showInformationMessage(`Heuristic run completed. Combined output written to ${combinedPath}`);
        outputChannel.appendLine(`Combined output written to ${combinedPath}`);
      } catch (e: any) {
        outputChannel.appendLine(`Failed to combine outputs: ${String(e)}`);
      }

      // write summary with stats
      try {
        writeSummaryWithStats(outdir, seeds, results, threads, root, outputChannel, "NPC Heuristic Run Summary");
        try {
          const doc = await vscode.workspace.openTextDocument(path.join(outdir, "summary.md"));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {}
      } catch (e:any) {
        outputChannel.appendLine(`Failed to write heuristic summary: ${String(e)}`);
      }

    } catch (e: any) {
      vscode.window.showErrorMessage(String(e.message || e));
    }
  });

  context.subscriptions.push(fetchCommand, runCommand, runHeuristicCommand);
}

export function deactivate() {
  try { killAllRunning(); } catch {}
}
