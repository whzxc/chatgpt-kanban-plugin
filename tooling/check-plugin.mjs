import { readFile, stat, mkdtemp, rm, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = path.resolve(process.argv[2] || 'dist/package/darwin-aarch64/plugins/kanban');
const manifest = JSON.parse(await readFile(path.join(directory, '.codex-plugin/plugin.json'), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (manifest.name !== 'kanban' || manifest.version !== pkg.version || manifest.mcpServers !== './.mcp.json' || manifest.apps) throw new Error('Plugin identity/version/standalone entry mismatch');
for (const file of ['LICENSE','assets/icon.svg']) await access(path.join(directory, file));
const config = JSON.parse(await readFile(path.join(directory, '.mcp.json'), 'utf8'));
const server = config.mcpServers.kanban;
const commands = process.platform === 'win32' ? ['./bin/chatgpt-kanban.exe', './bin/chatgpt-kanban'] : ['./bin/chatgpt-kanban'];
if (Object.keys(config.mcpServers).length !== 1 || server.cwd !== '.' || !commands.includes(server.command) || server.args.join() !== 'mcp') throw new Error('Plugin must use its own relative executable');
const binary = path.resolve(directory, server.command + (process.platform === 'win32' && !server.command.endsWith('.exe') ? '.exe' : ''));
const mode = (await stat(binary)).mode;
if (process.platform !== 'win32' && !(mode & 0o111)) throw new Error('Plugin binary is not executable');
if (execFileSync(binary, ['--version'], { encoding:'utf8' }).trim() !== pkg.version) throw new Error('Plugin binary version mismatch');
const state = await mkdtemp(path.join(tmpdir(), 'kanban-plugin-check-'));
const client = new Client({ name:'kanban-artifact-check', version:pkg.version });
try {
  await client.connect(new StdioClientTransport({ command:binary, args:['mcp'], cwd:directory, env:{ ...process.env, CHATGPT_KANBAN_STATE_DIR:state, CODEX_HOME:path.join(state,"codex"), CHATGPT_KANBAN_DEV_HTML:'' }, stderr:'inherit' }));
  const tools = await client.listTools();
  for (const name of ['kanban','kanban_update','kanban_execute','agents','agent_tasks','agent_read']) {
    if (!tools.tools.some(tool => tool.name === name)) throw new Error(`Missing plugin tool: ${name}`);
  }
  if (tools.tools.length !== 6) throw new Error('Kanban plugin must expose only its six panel tools');
  const resources = await client.listResources();
  if (resources.resources.length !== 1) throw new Error('Native UI resources do not match build features');
  const resource = await client.readResource({ uri:resources.resources[0].uri });
  const html = resource.contents[0].text;
  if (typeof html !== 'string' || !html.includes('<div id="root">') || /<script[^>]+src=/.test(html)) throw new Error('Release UI must be embedded and self-contained');
  if (html !== await readFile(new URL('../dist/plugin/app.html',import.meta.url),'utf8')) throw new Error('Bundled UI differs from this source build; rebuild the native executable.');
  const overview=await client.callTool({name:'kanban',arguments:{}});
  if(!Array.isArray(overview.structuredContent?.result?.cards))throw new Error('Standalone board unavailable');
  console.log(`Standalone plugin verified: v${pkg.version}, ${tools.tools.length} tools, embedded UI, independent backend.`);
} finally {
  await client.close();
  for(let attempt=0;attempt<200;attempt++){try{await access(path.join(state,'web/native.json'));}catch{break;}await new Promise(resolve=>setTimeout(resolve,100));}
  await rm(state, {recursive:true,force:true});
}
