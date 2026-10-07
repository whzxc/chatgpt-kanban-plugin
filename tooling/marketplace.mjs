// Assemble the same dual-platform payload formerly hosted in a separate marketplace repository.
import { execFileSync } from 'node:child_process';
import { chmod,cp,copyFile,mkdir,mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const version=JSON.parse(await readFile('package.json','utf8')).version;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
const platforms=['darwin-aarch64','windows-x86_64'];
async function files(root,prefix='') {
  const out=[];
  for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})) {
    const name=path.posix.join(prefix,entry.name);
    if(entry.isDirectory()) out.push(...await files(root,name));
    else if(entry.isFile()) out.push(name); else throw new Error('Unexpected package entry: '+name);
  }
  return out.sort();
}
const [mode,source,output]=process.argv.slice(2);
if(mode==='assemble') {
  if(!source||!output) throw new Error('assemble <artifacts> <empty-output>');
  await mkdir(output,{recursive:true}); if((await readdir(output)).length) throw new Error('Output must be empty');
  const temp=await mkdtemp(path.join(tmpdir(),'kanban-marketplace-'));
  try {
    const roots=[]; const binaries={};
    for(const platform of platforms) {
      const name=`ChatGPT.Kanban_${version}_${platform}.zip`;
      const archive=path.join(source,name);
      const expected=(await readFile(archive+'.sha256','utf8')).trim().split(/\s+/)[0];
      if(hash(await readFile(archive))!==expected) throw new Error('ZIP checksum mismatch');
      const root=path.join(temp,platform);await mkdir(root);
      execFileSync('unzip',['-q',path.resolve(archive),'-d',root],{stdio:'inherit'});
      const binary=`chatgpt-kanban${platform.startsWith('windows')?'.exe':''}`;
      binaries[platform]=hash(await readFile(path.join(root,'plugins/kanban/bin',binary)));
      const configPath=path.join(root,'plugins/kanban/.mcp.json');
      const config=JSON.parse(await readFile(configPath,'utf8'));
      if(config.mcpServers.kanban.command!=='./bin/'+binary||config.mcpServers.kanban.env) throw new Error('Unexpected MCP configuration');
      config.mcpServers.kanban.command='./bin/chatgpt-kanban';await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
      const manifest=JSON.parse(await readFile(path.join(root,'plugins/kanban/.codex-plugin/plugin.json'),'utf8'));
      if(manifest.name!=='kanban'||manifest.version!==version) throw new Error('Plugin version mismatch');
      roots.push(root);
    }
    const common=(await files(roots[0])).filter(p=>!p.startsWith('plugins/kanban/bin/'));
    if(JSON.stringify(common)!==JSON.stringify((await files(roots[1])).filter(p=>!p.startsWith('plugins/kanban/bin/')))) throw new Error('Platform layouts differ');
    for(const file of common) if(!(await readFile(path.join(roots[0],file))).equals(await readFile(path.join(roots[1],file)))) throw new Error('Platform metadata differs: '+file);
    await cp(roots[0],output,{recursive:true});
    await copyFile(path.join(roots[1],'plugins/kanban/bin/chatgpt-kanban.exe'),path.join(output,'plugins/kanban/bin/chatgpt-kanban.exe'));
    await chmod(path.join(output,'plugins/kanban/bin/chatgpt-kanban'),0o755);
    await writeFile(path.join(output,'release.json'),JSON.stringify({version,sourceCommit:git('.','rev-parse','HEAD'),binaries},null,2)+'\n');
    await writeFile(path.join(output,'.gitattributes'),'* -text\nplugins/kanban/bin/* binary\n');
    await copyFile('docs/marketplace.md',path.join(output,'README.md'));
  } finally {await rm(temp,{recursive:true,force:true});}
} else if(mode==='publish') {
  if(!source) throw new Error('publish <assembled-marketplace>');
  const info=JSON.parse(await readFile(path.join(source,'release.json'),'utf8'));
  if(info.version!==version||info.sourceCommit!==git('.','rev-parse','HEAD')) throw new Error('Source identity mismatch');
  if(process.env.GITHUB_REF!==`refs/tags/v${version}`) throw new Error('Publishing requires the matching source version tag');
  const repository=process.env.GITHUB_REPOSITORY;
  if(repository!=='whzxc/chatgpt-kanban-plugin') throw new Error('Unexpected destination repository');
  const temp=await mkdtemp(path.join(tmpdir(),'kanban-publish-'));
  try {
    await cp(source,temp,{recursive:true});
    for(const platform of platforms) {
      const binary=`chatgpt-kanban${platform.startsWith('windows')?'.exe':''}`;
      if(hash(await readFile(path.join(temp,'plugins/kanban/bin',binary)))!==info.binaries[platform]) throw new Error('Binary checksum mismatch');
    }
    git(temp,'init','-b','stable');
    git(temp,'remote','add','origin',`https://github.com/${repository}.git`);
    const exists=git(temp,'ls-remote','origin','refs/heads/stable');
    if(exists) {git(temp,'fetch','origin','stable');git(temp,'reset','--soft','FETCH_HEAD');}
    git(temp,'config','user.name','github-actions[bot]');git(temp,'config','user.email','41898282+github-actions[bot]@users.noreply.github.com');
    git(temp,'add','-A');git(temp,'update-index','--chmod=+x','plugins/kanban/bin/chatgpt-kanban');
    git(temp,'commit','-m',`chore(marketplace): 发布看板插件 ${version}`);
    git(temp,'push','origin','HEAD:refs/heads/stable');
  } finally {await rm(temp,{recursive:true,force:true});}
} else throw new Error('Expected assemble or publish');
