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
const vscode = __importStar(require("vscode"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const cheerio = __importStar(require("cheerio"));
const he = __importStar(require("he"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
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
    };
}
// ------------ HTML extraction helpers ------------
function extractSeedsFromHtml($) {
    const h3nodes = $("h3").filter((i, el) => $(el).text().trim() === "seed値" || /seed値/.test($(el).text()));
    if (h3nodes.length) {
        for (let i = 0; i < h3nodes.length; i++) {
            const el = h3nodes.eq(i);
            let pre = el.nextAll("div.code-box").first().find("pre").first();
            if (pre.length && String(pre.text()).trim()) {
                const txt = he.decode(String(pre.text()).trim());
                const nums = txt.match(/\d+/g);
                if (nums && nums.length)
                    return nums;
            }
            pre = el.nextAll("pre").first();
            if (pre.length && String(pre.text()).trim()) {
                const txt = he.decode(String(pre.text()).trim());
                const nums = txt.match(/\d+/g);
                if (nums && nums.length)
                    return nums;
            }
            pre = el.parent().find("pre").first();
            if (pre.length && String(pre.text()).trim()) {
                const txt = he.decode(String(pre.text()).trim());
                const nums = txt.match(/\d+/g);
                if (nums && nums.length)
                    return nums;
            }
        }
    }
    const pres = $("pre");
    for (let i = 0; i < pres.length; i++) {
        const raw = $(pres[i]).text();
        const txt = he.decode(String(raw)).trim();
        const nums = txt.match(/\d+/g);
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
async function runSingleSeed(seed, cfg, root, outputChannel) {
    var _a, _b, _c, _d;
    const pythonPath = cfg.pythonPath || defaultCfg().pythonPath;
    const timeoutMs = (_a = cfg.timeoutMs) !== null && _a !== void 0 ? _a : defaultCfg().timeoutMs;
    const maxOutputBytes = (_b = cfg.maxOutputBytes) !== null && _b !== void 0 ? _b : defaultCfg().maxOutputBytes;
    const outputDir = path.resolve(root, String((_c = cfg.outputDir) !== null && _c !== void 0 ? _c : defaultCfg().outputDir));
    if (!fs.existsSync(outputDir))
        fs.mkdirSync(outputDir, { recursive: true });
    const wrapperName = `__npc_wrapper_seed_${seed}.py`;
    const wrapperPath = path.join(root, wrapperName);
    await writeFileAsync(wrapperPath, makeWrapperContent(seed), { encoding: "utf8" });
    const genProc = (0, child_process_1.spawn)(pythonPath, [wrapperPath], { cwd: root });
    let genErr = "";
    (_d = genProc.stderr) === null || _d === void 0 ? void 0 : _d.on("data", (d) => { genErr += d.toString(); });
    return new Promise((resolve) => {
        const mainFile = path.join(root, cfg.mainFilename || defaultCfg().mainFilename);
        const isCpp = cfg.mainFilename && cfg.mainFilename.endsWith(".cpp");
        const finish = (ok, code, err, outString) => {
            const outName = `out_${seed}.txt`;
            try {
                if (outString !== undefined)
                    fs.writeFileSync(path.join(outputDir, outName), outString, "utf8");
            }
            catch (e) { }
            try {
                fs.unlinkSync(wrapperPath);
            }
            catch { }
            resolve({ seed, ok, exitCode: code, err: err, stdout: outString });
        };
        const spawnAndPipe = (execPath, args, mainProcSpawnOpts) => {
            const mainProc = (0, child_process_1.spawn)(execPath, args, mainProcSpawnOpts);
            let stderrAll = "";
            let collected = Buffer.alloc(0);
            let exceeded = false;
            if (mainProc.stderr)
                mainProc.stderr.on("data", d => { stderrAll += d.toString(); });
            if (mainProc.stdout) {
                mainProc.stdout.on("data", (chunk) => {
                    collected = Buffer.concat([collected, chunk]);
                    if (collected.length > maxOutputBytes) {
                        exceeded = true;
                        killProcessSafe(mainProc);
                    }
                });
            }
            if (genProc.stdout && mainProc.stdin) {
                genProc.stdout.pipe(mainProc.stdin);
            }
            const timeout = setTimeout(() => {
                killProcessSafe(genProc);
                killProcessSafe(mainProc);
            }, timeoutMs + 500);
            mainProc.on("close", (code) => {
                clearTimeout(timeout);
                const outString = collected.toString("utf8");
                if (exceeded) {
                    finish(false, code !== null && code !== void 0 ? code : undefined, "Output exceeded limit", outString);
                }
                else if (code !== 0) {
                    const errMsg = `Main exited with code ${code}. stderr:\n${stderrAll}\nGenerator stderr:\n${genErr}`;
                    finish(false, code !== null && code !== void 0 ? code : undefined, errMsg, outString);
                }
                else {
                    finish(true, code !== null && code !== void 0 ? code : undefined, undefined, outString);
                }
            });
            mainProc.on("error", (e) => {
                clearTimeout(timeout);
                const errMsg = `Failed to start main process: ${String(e)}; generator stderr:\n${genErr}`;
                finish(false, undefined, errMsg);
            });
            genProc.on("error", (e) => {
                clearTimeout(timeout);
                const errMsg = `Failed to run generator: ${String(e)}`;
                killProcessSafe(mainProc);
                finish(false, undefined, errMsg);
            });
        };
        (async () => {
            var _a;
            try {
                const mainFileExists = await fileExists(path.join(root, cfg.mainFilename || defaultCfg().mainFilename));
                if (!mainFileExists) {
                    let gOut = "";
                    (_a = genProc.stdout) === null || _a === void 0 ? void 0 : _a.on("data", (d) => { gOut += d.toString(); });
                    genProc.on("close", (gcode) => {
                        const errMsg = `Main file not found: ${cfg.mainFilename || defaultCfg().mainFilename}. Generator output:\n${gOut}\nGenerator stderr:\n${genErr}`;
                        finish(false, undefined, errMsg);
                    });
                    return;
                }
                if (isCpp) {
                    const exeName = process.platform === "win32" ? "main_exec.exe" : "main_exec";
                    const gpp = "g++";
                    const compileArgs = ["-O2", "-std=c++17", cfg.mainFilename, "-o", exeName];
                    const compileProc = (0, child_process_1.spawn)(gpp, compileArgs, { cwd: root });
                    let compileErr = "";
                    compileProc.stderr.on("data", d => { compileErr += d.toString(); });
                    compileProc.on("close", (code) => {
                        if (code !== 0) {
                            finish(false, code !== null && code !== void 0 ? code : undefined, `Compilation failed:\n${compileErr}`);
                            killProcessSafe(genProc);
                        }
                        else {
                            spawnAndPipe(path.join(root, exeName), [], { cwd: root });
                        }
                    });
                    compileProc.on("error", (e) => {
                        finish(false, undefined, `g++ not found or failed to start: ${String(e)}`);
                        killProcessSafe(genProc);
                    });
                }
                else {
                    spawnAndPipe(pythonPath, [cfg.mainFilename || defaultCfg().mainFilename], { cwd: root });
                }
            }
            catch (e) {
                const errMsg = `Internal runner error: ${String(e)}`;
                finish(false, undefined, errMsg);
            }
        })();
    });
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
        var _a, _b, _c;
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
                    // fallback - ask user if no seeds found
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
            const results = [];
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Running tests with generator(s)", cancellable: false }, async (progress) => {
                const total = seeds.length;
                for (let i = 0; i < seeds.length; i++) {
                    const s = seeds[i];
                    progress.report({ message: `Running seed ${s} (${i + 1}/${total})`, increment: (100 / total) });
                    outputChannel.appendLine(`=== Seed ${s} ===`);
                    const r = await runSingleSeed(s, cfg, root, outputChannel);
                    results.push(r);
                    if (r.ok) {
                        outputChannel.appendLine(`Seed ${s}: OK`);
                    }
                    else {
                        outputChannel.appendLine(`Seed ${s}: FAILED - ${r.err}`);
                    }
                }
            });
            try {
                const outdir = path.resolve(root, String((_c = cfg.outputDir) !== null && _c !== void 0 ? _c : defaultCfg().outputDir));
                const combinedPath = path.join(outdir, "out.txt");
                const parts = [];
                for (const r of results) {
                    const fn = path.join(outdir, `out_${r.seed}.txt`);
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
        }
        catch (e) {
            vscode.window.showErrorMessage(String(e.message || e));
        }
    });
    context.subscriptions.push(fetchCommand, runCommand);
}
exports.activate = activate;
function deactivate() { }
exports.deactivate = deactivate;
