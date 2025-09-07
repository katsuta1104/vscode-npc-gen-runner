"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
// src/extension.ts (CSV を出力しない版)
const vscode = __importStar(require("vscode"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const cheerio = __importStar(require("cheerio"));
const he = __importStar(require("he"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const os = __importStar(require("os"));
const crypto_1 = require("crypto");
const writeFileAsync = (0, util_1.promisify)(fs.writeFile);
const readFileAsync = (0, util_1.promisify)(fs.readFile);
const accessAsync = (0, util_1.promisify)(fs.access);
function getConfig() {
    return vscode.workspace.getConfiguration("npc");
}
function getWorkspaceRoot() {
    const ws = vscode.workspace.workspaceFolders;
    if (!ws || ws.length === 0)
        return undefined;
    return ws[0].uri.fsPath;
}
function ensureWorkspace() {
    const root = getWorkspaceRoot();
    if (!root)
        throw new Error("Workspace is not opened. Please open a folder first.");
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
function safeFilenamePart(s) {
    return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_");
}
// Try to determine *physical* core count in a cross-platform way.
// Fallback: os.cpus().length
function getPhysicalCoreCount() {
    var _a;
    try {
        const platform = process.platform;
        if (platform === "linux") {
            const data = fs.readFileSync("/proc/cpuinfo", "utf8");
            const physCorePairs = new Set();
            const blocks = data.split(/\n\n+/);
            for (const b of blocks) {
                const mPhys = b.match(/^physical id\s*:\s*(\d+)/m);
                const mCore = b.match(/^core id\s*:\s*(\d+)/m);
                if (mPhys && mCore) {
                    physCorePairs.add(`${mPhys[1]}-${mCore[1]}`);
                }
            }
            if (physCorePairs.size > 0)
                return physCorePairs.size;
        }
        else if (platform === "darwin") {
            const out = (0, child_process_1.execSync)("sysctl -n hw.physicalcpu", { encoding: "utf8" }).trim();
            const n = Number(out);
            if (Number.isFinite(n) && n > 0)
                return Math.max(1, Math.floor(n));
        }
        else if (platform === "win32") {
            try {
                const out = (0, child_process_1.execSync)('wmic cpu get NumberOfCores /value', { encoding: "utf8" });
                const matches = Array.from(out.matchAll(/NumberOfCores=(\d+)/g));
                if (matches && matches.length) {
                    const sum = matches.reduce((acc, m) => acc + Number(m[1] || 0), 0);
                    if (sum > 0)
                        return sum;
                }
            }
            catch (e) { }
        }
    }
    catch (e) { }
    const logical = ((_a = os.cpus()) === null || _a === void 0 ? void 0 : _a.length) || 1;
    return Math.max(1, Math.floor(logical));
}
// ------------ HTML extraction helpers ------------
function extractSeedsFromHtml($) {
    const intRegex = /-?\d+/g;
    const seedPres = $("pre.seeds, pre[class*='seeds']");
    if (seedPres.length) {
        for (let i = 0; i < seedPres.length; i++) {
            const el = seedPres.eq(i);
            const htmlInner = el.html() || "";
            const withoutComments = htmlInner.replace(/<!--[\s\S]*?-->/g, " ");
            const decoded = he.decode(withoutComments).trim();
            const nums = decoded.match(intRegex);
            if (nums && nums.length)
                return nums;
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
                if (nums && nums.length)
                    return nums;
            }
            pre = el.nextAll("pre").first();
            if (pre.length && String(pre.text()).trim()) {
                const txt = he.decode(String(pre.text()).trim());
                const nums = txt.match(intRegex);
                if (nums && nums.length)
                    return nums;
            }
            pre = el.parent().find("pre").first();
            if (pre.length && String(pre.text()).trim()) {
                const txt = he.decode(String(pre.text()).trim());
                const nums = txt.match(intRegex);
                if (nums && nums.length)
                    return nums;
            }
        }
    }
    const pres = $("pre");
    for (let i = 0; i < pres.length; i++) {
        const raw = $(pres[i]).text();
        const txt = he.decode(String(raw)).trim();
        const nums = txt.match(intRegex);
        if (nums && nums.length)
            return nums;
    }
    return [];
}
function extractPythonFromHtml(html) {
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
function expandShortNotation(input) {
    const trimmed = input.trim();
    const npcMatch = trimmed.match(/^NPC0*(\d+)([A-Za-z])$/i);
    if (npcMatch) {
        const num = npcMatch[1];
        const letter = npcMatch[2].toLowerCase();
        const pad = String(num).padStart(3, "0");
        return `https://sites.google.com/view/nanyocompetitiveprogramming/%E3%82%B3%E3%83%B3%E3%83%86%E3%82%B9%E3%83%88%E4%B8%80%E8%A6%A7/contest${pad}/problems/${letter}`;
    }
    if (/^https?:\/\//i.test(trimmed))
        return trimmed;
    return trimmed;
}
// ---- fetch & save generator ----
async function fetchGeneratorAndSave(urlOrShort, genPath) {
    const url = expandShortNotation(urlOrShort);
    const res = await (0, node_fetch_1.default)(url);
    if (!res.ok)
        throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    const html = await res.text();
    const { code, seeds } = extractPythonFromHtml(html);
    await writeFileAsync(genPath, code, { encoding: "utf8" });
    return seeds;
}
// ---- runner helpers ----
function killProcessSafe(proc) {
    try {
        if (!proc)
            return;
        proc.kill();
    }
    catch (e) { }
}
async function fileExists(p) {
    try {
        await accessAsync(p, fs.constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
function makeWrapperContent(seed) {
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
const runningProcesses = new Map();
// runSingleSeed now accepts cfg and root; returns result including mainTimeMs
async function runSingleSeed(seed, cfg, root, outputDir, outputChannel, timeoutMsOverride) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const pythonPath = cfg.pythonPath || defaultCfg().pythonPath;
    const timeoutMs = timeoutMsOverride !== null && timeoutMsOverride !== void 0 ? timeoutMsOverride : ((_a = cfg.timeoutMs) !== null && _a !== void 0 ? _a : defaultCfg().timeoutMs);
    const maxOutputBytes = (_b = cfg.maxOutputBytes) !== null && _b !== void 0 ? _b : defaultCfg().maxOutputBytes;
    // wrapper in temp dir
    const wrapperName = `__npc_wrapper_${safeFilenamePart(seed)}_${(0, crypto_1.randomBytes)(6).toString("hex")}.py`;
    const wrapperPath = path.join(os.tmpdir(), wrapperName);
    const seedSafe = safeFilenamePart(seed);
    // ensure process list entry
    runningProcesses.set(seedSafe, []);
    try {
        await writeFileAsync(wrapperPath, makeWrapperContent(seed), { encoding: "utf8" });
        // Run generator
        const genStdoutChunks = [];
        let genStderr = "";
        let genExitCode = null;
        const genProc = (0, child_process_1.spawn)(pythonPath, [wrapperPath], { cwd: root });
        (_c = runningProcesses.get(seedSafe)) === null || _c === void 0 ? void 0 : _c.push(genProc);
        (_d = genProc.stdout) === null || _d === void 0 ? void 0 : _d.on("data", (b) => genStdoutChunks.push(b));
        (_e = genProc.stderr) === null || _e === void 0 ? void 0 : _e.on("data", (d) => { genStderr += d.toString(); });
        // wait for generator to finish (or timeout)
        const genPromise = new Promise((resolve) => {
            const genTimeout = setTimeout(() => {
                try {
                    genProc.kill();
                }
                catch { }
                genExitCode = -1;
                resolve();
            }, timeoutMs);
            genProc.on("close", (code) => {
                clearTimeout(genTimeout);
                genExitCode = code !== null && code !== void 0 ? code : 0;
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
        if (!fs.existsSync(inputsDir))
            fs.mkdirSync(inputsDir, { recursive: true });
        if (!fs.existsSync(outputsDir))
            fs.mkdirSync(outputsDir, { recursive: true });
        // write generator output for debugging
        try {
            fs.writeFileSync(path.join(outputsDir, `out_gen_${seedSafe}.txt`), genOutput + "\n", "utf8");
        }
        catch { }
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
        try {
            fs.writeFileSync(inFile, genOutput, "utf8");
        }
        catch (e) {
            return { seed, ok: false, err: `Failed to write generator input file: ${String(e)}` };
        }
        // Now run main (compile if C++)
        const mainFileRel = cfg.mainFilename || defaultCfg().mainFilename;
        const mainFile = path.join(root, String(mainFileRel));
        const isCpp = mainFileRel.endsWith(".cpp");
        // helper to finalize
        const finish = (ok, code, err, outString, mainTimeMs) => {
            const outName = `out_${seedSafe}.txt`;
            try {
                if (outString !== undefined)
                    fs.writeFileSync(path.join(outputsDir, outName), outString, "utf8");
            }
            catch { }
            // keep the generator input also for debugging (already saved)
            return { seed, ok, exitCode: code, err, stdout: outString, mainTimeMs };
        };
        if (!fs.existsSync(mainFile)) {
            return finish(false, undefined, `Main file not found: ${mainFileRel}`);
        }
        if (isCpp) {
            const exeName = process.platform === "win32" ? "main_exec.exe" : "main_exec";
            const exePath = path.join(root, exeName);
            const compileProc = (0, child_process_1.spawn)("g++", ["-O2", "-std=c++17", path.basename(mainFile), "-o", exeName], { cwd: root });
            (_f = runningProcesses.get(seedSafe)) === null || _f === void 0 ? void 0 : _f.push(compileProc);
            let compileErr = "";
            compileProc.stderr.on("data", (d) => compileErr += d.toString());
            const compiled = await new Promise((resolve) => {
                compileProc.on("close", (code) => resolve(code === 0));
                compileProc.on("error", () => resolve(false));
            });
            if (!compiled)
                return finish(false, undefined, `Compilation failed:\n${compileErr}`);
            // run executable, feeding file into stdin
            const mainProc = (0, child_process_1.spawn)(exePath, [], { cwd: root });
            (_g = runningProcesses.get(seedSafe)) === null || _g === void 0 ? void 0 : _g.push(mainProc);
            let collected = Buffer.alloc(0);
            let stderrAll = "";
            let exceeded = false;
            if (mainProc.stderr)
                mainProc.stderr.on("data", d => { stderrAll += d.toString(); });
            if (mainProc.stdout) {
                mainProc.stdout.on("data", (chunk) => {
                    collected = Buffer.concat([collected, chunk]);
                    if (collected.length > maxOutputBytes) {
                        exceeded = true;
                        try {
                            mainProc.kill();
                        }
                        catch { }
                    }
                });
            }
            // pipe file to stdin
            const rs = fs.createReadStream(inFile);
            rs.pipe(mainProc.stdin);
            // measure time for main only (from before piping until close)
            const start = Date.now();
            const timeout = setTimeout(() => { try {
                mainProc.kill();
            }
            catch { } }, timeoutMs);
            const code = await new Promise((resolve) => {
                mainProc.on("close", (c) => { clearTimeout(timeout); resolve(c !== null && c !== void 0 ? c : 0); });
                mainProc.on("error", () => { clearTimeout(timeout); resolve(-1); });
            });
            const end = Date.now();
            const outString = collected.toString("utf8");
            const mainTimeMs = end - start;
            if (exceeded)
                return finish(false, code !== null && code !== void 0 ? code : undefined, "Output exceeded limit", outString, mainTimeMs);
            if (code !== 0)
                return finish(false, code !== null && code !== void 0 ? code : undefined, `Main exited with code ${code}. stderr:\n${stderrAll}`, outString, mainTimeMs);
            return finish(true, code !== null && code !== void 0 ? code : undefined, undefined, outString, mainTimeMs);
        }
        else {
            // Python main
            const mainProc = (0, child_process_1.spawn)(pythonPath, [mainFileRel], { cwd: root });
            (_h = runningProcesses.get(seedSafe)) === null || _h === void 0 ? void 0 : _h.push(mainProc);
            let collected = Buffer.alloc(0);
            let stderrAll = "";
            let exceeded = false;
            if (mainProc.stderr)
                mainProc.stderr.on("data", d => { stderrAll += d.toString(); });
            if (mainProc.stdout) {
                mainProc.stdout.on("data", (chunk) => {
                    collected = Buffer.concat([collected, chunk]);
                    if (collected.length > maxOutputBytes) {
                        exceeded = true;
                        try {
                            mainProc.kill();
                        }
                        catch { }
                    }
                });
            }
            const rs = fs.createReadStream(inFile);
            // measure main time
            const start = Date.now();
            rs.pipe(mainProc.stdin);
            const timeout = setTimeout(() => { try {
                mainProc.kill();
            }
            catch { } }, timeoutMs);
            const code = await new Promise((resolve) => {
                mainProc.on("close", (c) => { clearTimeout(timeout); resolve(c !== null && c !== void 0 ? c : 0); });
                mainProc.on("error", () => { clearTimeout(timeout); resolve(-1); });
            });
            const end = Date.now();
            const outString = collected.toString("utf8");
            const mainTimeMs = end - start;
            if (exceeded)
                return finish(false, code !== null && code !== void 0 ? code : undefined, "Output exceeded limit", outString, mainTimeMs);
            if (code !== 0)
                return finish(false, code !== null && code !== void 0 ? code : undefined, `Main exited with code ${code}. stderr:\n${stderrAll}`, outString, mainTimeMs);
            return finish(true, code !== null && code !== void 0 ? code : undefined, undefined, outString, mainTimeMs);
        }
    }
    finally {
        // cleanup wrapper and runningProcesses entry
        try {
            if (fs.existsSync(wrapperPath))
                fs.unlinkSync(wrapperPath);
        }
        catch { }
        runningProcesses.delete(seedSafe);
    }
}
// Helper to kill all running processes (for cancellation)
function killAllRunning() {
    for (const [seed, procs] of Array.from(runningProcesses.entries())) {
        for (const p of procs) {
            try {
                p.kill();
            }
            catch { }
        }
    }
    runningProcesses.clear();
}
function activate(context) {
    const outputChannel = vscode.window.createOutputChannel("NPC Runner");
    context.subscriptions.push(outputChannel);
    const fetchCommand = vscode.commands.registerCommand("npc.fetchGenerator", async () => {
        try {
            const root = ensureWorkspace();
            const config = getConfig();
            const genFilename = config.get("genFilename") || defaultCfg().genFilename;
            const input = await vscode.window.showInputBox({ prompt: "Enter NPC short (e.g. NPC004B) or full URL" });
            if (!input)
                return;
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Fetching generator..." }, async (progress) => {
                progress.report({ message: "Downloading..." });
                try {
                    const seeds = await fetchGeneratorAndSave(input, path.join(root, String(genFilename)));
                    outputChannel.appendLine(`Saved ${genFilename} to workspace.`);
                    outputChannel.appendLine(`Seeds found: ${seeds.join(", ")}`);
                    vscode.window.showInformationMessage(`gen.py saved. Seeds: ${seeds.join(", ")}`);
                    const doc = await vscode.workspace.openTextDocument(path.join(root, String(genFilename)));
                    await vscode.window.showTextDocument(doc);
                }
                catch (e) {
                    outputChannel.appendLine(`Error fetching generator: ${String(e)}`);
                    vscode.window.showErrorMessage(`Failed to fetch generator: ${String(e.message || e)}`);
                }
            });
        }
        catch (e) {
            vscode.window.showErrorMessage(String(e.message || e));
        }
    });
    const runCommand = vscode.commands.registerCommand("npc.runWithGenerators", async () => {
        var _a, _b, _c, _d;
        try {
            const root = ensureWorkspace();
            const config = getConfig();
            const cfg = {
                pythonPath: config.get("pythonPath") || defaultCfg().pythonPath,
                genFilename: config.get("genFilename") || defaultCfg().genFilename,
                mainFilename: config.get("mainFilename") || defaultCfg().mainFilename,
                timeoutMs: (_a = config.get("timeoutMs")) !== null && _a !== void 0 ? _a : defaultCfg().timeoutMs,
                maxOutputBytes: (_b = config.get("maxOutputBytes")) !== null && _b !== void 0 ? _b : defaultCfg().maxOutputBytes,
                outputDir: config.get("outputDir") || defaultCfg().outputDir,
                threads: (_c = config.get("threads")) !== null && _c !== void 0 ? _c : defaultCfg().threads,
            };
            const urlOrShort = await vscode.window.showInputBox({ prompt: "Enter NPC short (NPC004B) or full URL (leave empty to use existing gen.py)" });
            let seeds = [];
            const genPath = path.join(root, String(cfg.genFilename));
            if (urlOrShort) {
                try {
                    seeds = await fetchGeneratorAndSave(urlOrShort, genPath);
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed to fetch generator: ${String(e.message || e)}`);
                    return;
                }
            }
            else {
                if (await fileExists(genPath)) {
                    // fallback - try to extract seeds from local gen.py comments (naive)
                    // Leave seeds empty to ask user later if none found
                }
                else {
                    vscode.window.showErrorMessage("No gen.py in workspace. Provide a URL or create gen.py first.");
                    return;
                }
            }
            if (!seeds || seeds.length === 0) {
                const manual = await vscode.window.showInputBox({ prompt: "No seeds found automatically. Enter seeds separated by spaces or commas (e.g. 10 21 40)" });
                if (!manual)
                    return;
                seeds = manual.split(/[\s,]+/).filter(s => s.trim().length > 0);
            }
            outputChannel.appendLine(`Running seeds: ${seeds.join(", ")}`);
            // prepare outputDir and subdirs
            const outdir = path.resolve(root, String((_d = cfg.outputDir) !== null && _d !== void 0 ? _d : defaultCfg().outputDir));
            if (!fs.existsSync(outdir))
                fs.mkdirSync(outdir, { recursive: true });
            const inputsDir = path.join(outdir, "inputs");
            const outputsDir = path.join(outdir, "outputs");
            if (!fs.existsSync(inputsDir))
                fs.mkdirSync(inputsDir, { recursive: true });
            if (!fs.existsSync(outputsDir))
                fs.mkdirSync(outputsDir, { recursive: true });
            const results = [];
            // determine threads: if user gave <=0, use physical cores
            let threads = Number(cfg.threads) || 0;
            if (threads <= 0)
                threads = getPhysicalCoreCount();
            outputChannel.appendLine(`Using threads: ${threads} (physical cores)`);
            // concurrency queue
            let cancelled = false;
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running tests with generator(s) — threads: ${threads}`, cancellable: true }, async (progress, token) => {
                const total = seeds.length;
                let completed = 0;
                const queue = [];
                let idx = 0;
                token.onCancellationRequested(() => {
                    cancelled = true;
                    outputChannel.appendLine("Cancellation requested — killing running processes...");
                    killAllRunning();
                });
                // worker function
                const worker = async () => {
                    var _a;
                    while (true) {
                        if (cancelled)
                            return;
                        const myIndex = idx;
                        idx++;
                        if (myIndex >= seeds.length)
                            return;
                        const s = seeds[myIndex];
                        progress.report({ message: `Running seed ${s} (${myIndex + 1}/${total})`, increment: (100 / total) });
                        outputChannel.appendLine(`=== Seed ${s} ===`);
                        try {
                            const r = await runSingleSeed(s, cfg, root, outdir, outputChannel);
                            results[myIndex] = r;
                            if (r.ok) {
                                outputChannel.appendLine(`Seed ${s}: OK (${(_a = r.mainTimeMs) !== null && _a !== void 0 ? _a : "N/A"} ms)`);
                            }
                            else {
                                outputChannel.appendLine(`Seed ${s}: FAILED - ${r.err}`);
                            }
                        }
                        catch (e) {
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
                const parts = [];
                for (let i = 0; i < seeds.length; i++) {
                    const s = seeds[i];
                    const sf = safeFilenamePart(s);
                    const fn = path.join(outdir, "outputs", `out_${sf}.txt`);
                    if (fs.existsSync(fn))
                        parts.push(fs.readFileSync(fn, "utf8"));
                }
                fs.writeFileSync(combinedPath, parts.join("\n"), "utf8");
                vscode.window.showInformationMessage(`Run completed. Combined output written to ${combinedPath}`);
                outputChannel.appendLine(`Combined output written to ${combinedPath}`);
            }
            catch (e) {
                outputChannel.appendLine(`Failed to combine outputs: ${String(e)}`);
            }
            // produce summary Markdown only (no CSV)
            try {
                const summaryMdPath = path.join(outdir, "summary.md");
                const mdLines = [];
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
                        mdLines.push(`| ${i + 1} | ${s} | false |  |  | no result | ${outFile} |`);
                    }
                    else {
                        mdLines.push(`| ${i + 1} | ${s} | ${r.ok ? "true" : "false"} | ${typeof r.exitCode === "number" ? r.exitCode : ""} | ${typeof r.mainTimeMs === "number" ? r.mainTimeMs : "N/A"} | ${r.err ? r.err.replace(/\|/g, '\\|') : ""} | ${outFile} |`);
                    }
                }
                fs.writeFileSync(summaryMdPath, mdLines.join("\n"), "utf8");
                outputChannel.appendLine(`Summary written to ${summaryMdPath}`);
                // open the markdown summary in editor for quick view
                try {
                    const doc = await vscode.workspace.openTextDocument(summaryMdPath);
                    await vscode.window.showTextDocument(doc, { preview: true });
                }
                catch { }
            }
            catch (e) {
                outputChannel.appendLine(`Failed to write summary: ${String(e)}`);
            }
        }
        catch (e) {
            vscode.window.showErrorMessage(String(e.message || e));
        }
    });
    context.subscriptions.push(fetchCommand, runCommand);
}
exports.activate = activate;
function deactivate() {
    try {
        killAllRunning();
    }
    catch { }
}
exports.deactivate = deactivate;
