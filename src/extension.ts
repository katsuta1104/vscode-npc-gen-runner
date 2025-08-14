import * as vscode from 'vscode';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';

/**
 * VSCode 拡張: 主なコマンド
 * - npc.fetchGen: URL or short (NPC004B) -> fetch page -> extract python generator -> save as gen.py and open
 * - npc.runWithGen: use gen.py (or fetch+save first) -> extract seeds (fixed format) -> for each seed:
 *      - create temp gen with `seed = <n>`
 *      - run python temp_gen -> pipe stdout to main (python or compiled C++ exec)
 *      - enforce timeout and max output bytes, save out_<seed>.txt
 *    finally combine out_*.txt -> out.txt
 */

/* ----------------------- site-specific url builder ----------------------- */
/* Accepts full URL or short like NPC004B */
function buildUrlFromShort(short: string): string {
  const m = short.match(/NPC(\d+)([A-Za-z])/i);
  if (!m) throw new Error('短縮形式が不正です。例: NPC004B');
  const contest = 'contest' + m[1].padStart(3, '0');
  const prob = m[2].toLowerCase();
  return `https://sites.google.com/view/nanyocompetitiveprogramming/%E3%82%B3%E3%83%B3%E3%83%86%E3%82%B9%E3%83%88%E4%B8%80%E8%A6%A7/${contest}/problems/${prob}`;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP status ${res.status}`);
  return await res.text();
}

/* ----------------------- FIXED-FORMAT seed extractor -----------------------
   Assumption (guaranteed by user):
     <h3>seed値</h3>
     <div class="code-box"><pre>10 21 40 575 1103</pre></div>

   This function finds <h3> whose text is exactly 'seed値' and then reads the
   following div.code-box > pre (or a next sibling pre) and returns numeric tokens.
------------------------------------------------------------------------- */
function extractSeedsFromHtml($: cheerio.Root): string[] {
  const h3nodes = $('h3').filter((i, el) => $(el).text().trim() === 'seed値');
  if (!h3nodes.length) return [];

  const h3 = h3nodes.first();

  // prefer: next div.code-box > pre
  let pre = h3.nextAll('div.code-box').first().find('pre').first();
  if (!pre.length) {
    // fallback: next pre sibling
    pre = h3.nextAll('pre').first();
  }
  if (!pre.length) return [];

  const text = pre.text().trim();
  const m = text.match(/\d+/g);
  return m ? m : [];
}

/* ----------------------- Python extraction (generator) ------------------- */
function extractPythonFromHtml(html: string): { code: string; seeds: string[] } {
  const $ = cheerio.load(html);

  // 1) id="code-block-py"
  const byId = $('#code-block-py').text().trim();
  if (byId) return { code: byId, seeds: extractSeedsFromHtml($) };

  // 2) var code = `...` pattern
  const m = html.match(/var\s+code\s*=\s*`([\s\S]*?)`;/);
  if (m) return { code: m[1], seeds: extractSeedsFromHtml($) };

  // 3) first pre that looks like python
  const pres = $('pre');
  for (let i = 0; i < pres.length; i++) {
    const text = $(pres[i]).text();
    if (/^\s*(def |class |import |from )/m.test(text)) return { code: text.trim(), seeds: extractSeedsFromHtml($) };
  }

  throw new Error('Python generator を HTML から見つけられませんでした。');
}

/* ----------------------- workspace file helpers --------------------------- */
async function saveGenToWorkspace(code: string, filename: string): Promise<vscode.Uri> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('ワークスペースが開かれていません');
  const uri = vscode.Uri.joinPath(ws.uri, filename);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(code, 'utf8'));
  return uri;
}

function replaceOrAppendSeed(code: string, seed: string): string {
  if (/^\s*seed\s*=\s*\d+/m.test(code)) {
    return code.replace(/^\s*seed\s*=\s*\d+/m, `seed = ${seed}`);
  } else {
    return code + `\nseed = ${seed}\n`;
  }
}

function runChildWithTimeout(p: ChildProcess, timeoutMs: number, onKill?: () => void) {
  const to = setTimeout(() => {
    try { p.kill('SIGKILL'); } catch (e) {}
    if (onKill) onKill();
  }, timeoutMs);
  return () => clearTimeout(to);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/* ----------------------- Core: run generator -> main --------------------- */
async function runGeneratorAndMain(
  genPath: string,
  mainPath: string,
  seed: string | null,
  timeoutMs: number,
  maxOutputBytes: number,
  outputDir: string
): Promise<void> {
  const tempGen = seed ? path.join(path.dirname(genPath), `__gen_temp_seed_${seed}.py`) : path.join(path.dirname(genPath), `__gen_temp_default.py`);
  let genCode = await fsp.readFile(genPath, 'utf8');
  if (seed) genCode = replaceOrAppendSeed(genCode, seed);
  await fsp.writeFile(tempGen, genCode, 'utf8');

  // determine execution for main
  const mainExt = path.extname(mainPath);
  let execPath = mainPath;
  if (mainExt === '.cpp') {
    const exe = path.join(path.dirname(mainPath), 'main_exec');
    await new Promise<void>((resolve, reject) => {
      const compile = spawn('g++', ['-O2', '-std=c++17', mainPath, '-o', exe]);
      const killed = runChildWithTimeout(compile, Math.max(10000, timeoutMs));
      let serr = '';
      compile.stderr.on('data', d => serr += d.toString());
      compile.on('close', (code) => {
        killed();
        if (code === 0) resolve(); else reject(new Error('compile failed: ' + serr));
      });
      compile.on('error', e => { killed(); reject(e); });
    });
    execPath = path.join(path.dirname(mainPath), 'main_exec');
  }

  const cfg = vscode.workspace.getConfiguration('npc');
  const pythonPath = cfg.get<string>('pythonPath', 'python3');
  const genProc = spawn(pythonPath, [tempGen], { stdio: ['ignore', 'pipe', 'pipe'] });

  let mainProc: ChildProcess;
  if (path.extname(execPath) === '.py') {
    mainProc = spawn(pythonPath, [execPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    mainProc = spawn(execPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  // timeouts & kill logic
  let killed = false;
  const killBoth = () => { try { genProc.kill('SIGKILL'); } catch {} try { mainProc.kill('SIGKILL'); } catch {} killed = true; };
  const clearGenTo = runChildWithTimeout(genProc, timeoutMs, killBoth);
  const clearMainTo = runChildWithTimeout(mainProc, timeoutMs, killBoth);

  // forward gen stdout -> main stdin (with forward limit)
  let totalForwarded = 0;
  genProc.stdout.on('data', (chunk: Buffer) => {
    totalForwarded += chunk.length;
    if (totalForwarded > maxOutputBytes) { killBoth(); return; }
    try { mainProc.stdin?.write(chunk); } catch {}
  });
  genProc.on('close', () => { try { mainProc.stdin?.end(); } catch {} });

// collect main stdout (with limit)
let collected = Buffer.alloc(0);
let exceeded = false;
if (mainProc.stdout) {
  mainProc.stdout.on('data', (chunk: Buffer) => {
    collected = Buffer.concat([collected, chunk]);
    if (collected.length > maxOutputBytes) { exceeded = true; killBoth(); }
  });
}

let stderrAll = '';
if (mainProc.stderr) {
  mainProc.stderr.on('data', d => { stderrAll += d.toString(); });
}


  await new Promise<void>((resolve, reject) => {
    mainProc.on('close', (code) => {
      clearGenTo(); clearMainTo();
      if (killed) return reject(new Error('Killed due to timeout or output limit'));
      if (exceeded) return reject(new Error('Output limit exceeded'));
      if (code !== 0) return reject(new Error('main exited with code ' + code + '\n' + stderrAll));
      resolve();
    });
    genProc.on('error', e => { clearGenTo(); clearMainTo(); reject(e); });
    mainProc.on('error', e => { clearGenTo(); clearMainTo(); reject(e); });
  });

  const outFn = path.join(outputDir, `out_${seed ?? '0'}.txt`);
  await fsp.writeFile(outFn, collected);
}

/* ----------------------- Commands registration --------------------------- */
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('npc.fetchGen', async () => {
    try {
      const input = await vscode.window.showInputBox({ prompt: 'URL か NPC 短縮 (例 NPC004B) を入力' });
      if (!input) return;
      const url = /^https?:\/\//i.test(input) ? input : buildUrlFromShort(input);
      const html = await fetchHtml(url);
      const { code, seeds } = extractPythonFromHtml(html);
      const genFilename = vscode.workspace.getConfiguration('npc').get<string>('genFilename', 'gen.py')!;
      const uri = await saveGenToWorkspace(code, genFilename);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`gen.py を保存しました (seeds: ${seeds.join(', ') || 'none'})`);
    } catch (e: any) {
      vscode.window.showErrorMessage(String(e.message || e));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('npc.runWithGen', async () => {
    try {
      const input = await vscode.window.showInputBox({ prompt: 'URL か NPC 短縮 (任意。空なら workspace の gen.py を使用)' });
      let seeds: string[] = [];
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) throw new Error('ワークスペースが開かれていません');
      const genFilename = vscode.workspace.getConfiguration('npc').get<string>('genFilename', 'gen.py')!;
      const genPath = path.join(ws.uri.fsPath, genFilename);

      if (input) {
        const url = /^https?:\/\//i.test(input) ? input : buildUrlFromShort(input);
        const html = await fetchHtml(url);
        const res = extractPythonFromHtml(html);
        await saveGenToWorkspace(res.code, path.basename(genPath));
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(genPath));
        await vscode.window.showTextDocument(doc);
        seeds = res.seeds;
      }

      if (!seeds || seeds.length === 0) {
        const seedInput = await vscode.window.showInputBox({ prompt: 'カンマ区切りで seed を指定（例: 10,21,40）。空なら単発実行）' });
        if (seedInput && seedInput.trim() !== '') seeds = seedInput.split(/[\s,]+/).filter(s => /^\d+$/.test(s));
      }

      if (!seeds || seeds.length === 0) seeds = [null as unknown as string];

      const timeoutMs = vscode.workspace.getConfiguration('npc').get<number>('timeoutMs', 30000)!;
      const maxOutputBytes = vscode.workspace.getConfiguration('npc').get<number>('maxOutputBytes', 10000000)!;
      const mainFilename = vscode.workspace.getConfiguration('npc').get<string>('mainFilename', 'main.py')!;
      const mainPath = path.join(ws.uri.fsPath, mainFilename);
      const outputDir = ws.uri.fsPath;

      if (!(await fileExists(mainPath))) {
        vscode.window.showErrorMessage(`main file not found: ${mainPath}`);
        return;
      }

      const consent = await vscode.window.showWarningMessage('実行を開始します。続けますか？ (timeout と output limit を適用します)', { modal: true }, '実行する');
      if (consent !== '実行する') return;

      for (const s of seeds) {
        if (s !== null && s !== undefined && s !== '' && !/^\d+$/.test(s)) {
          vscode.window.showWarningMessage(`スキップ: seed が不正です: ${s}`);
          continue;
        }
        try {
          await runGeneratorAndMain(genPath, mainPath, s ?? null, timeoutMs, maxOutputBytes, outputDir);
          vscode.window.showInformationMessage(`seed=${s ?? 'default'} 実行完了`);
        } catch (e: any) {
          vscode.window.showErrorMessage(`seed=${s ?? 'default'} 実行失敗: ${e.message || e}`);
        }
      }

      // combine outputs
      const files = fs.readdirSync(outputDir).filter(f => f.startsWith('out_') && f.endsWith('.txt'));
      let combined = '';
      for (const f of files.sort()) combined += fs.readFileSync(path.join(outputDir, f), 'utf8') + '\n';
      fs.writeFileSync(path.join(outputDir, 'out.txt'), combined, 'utf8');
      vscode.window.showInformationMessage('out.txt を作成しました。');

    } catch (e: any) {
      vscode.window.showErrorMessage(String(e.message || e));
    }
  }));
}

export function deactivate() {}
