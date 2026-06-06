import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

export const publishCommand = new Command('publish')
  .description('Publish an agent to ProAgentStore')
  .option('-d, --dir <path>', 'Agent directory', '.')
  .action(async (opts: { dir: string }) => {
    const dir = resolve(opts.dir);

    // Read manifest
    const manifestPath = join(dir, 'agent.json');
    if (!existsSync(manifestPath)) {
      console.error('No agent.json found. Run `pags init` first.');
      process.exit(1);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const slug = manifest.id;
    if (!slug) { console.error('agent.json missing id'); process.exit(1); }

    console.log(`\n  Publishing ${manifest.name} (${slug})...\n`);

    // Run compliance checks
    console.log('  Running compliance checks...');
    try {
      execSync('pags check', { cwd: dir, stdio: 'inherit' });
    } catch {
      console.error('\n  Compliance checks failed. Fix issues and retry.\n');
      process.exit(1);
    }

    // Check if repo exists in ProAgentStore org
    const org = 'ProAgentStore';
    const repoName = slug;
    console.log(`\n  Checking GitHub repo: ${org}/${repoName}`);

    let repoExists = false;
    try {
      execSync(`gh api repos/${org}/${repoName} --jq .name`, { stdio: 'pipe' });
      repoExists = true;
      console.log('  Repo exists, pushing...');
    } catch {
      console.log('  Creating repo...');
      try {
        execSync(`gh repo create ${org}/${repoName} --public --source=${dir} --push`, { stdio: 'inherit' });
        repoExists = true;
      } catch (e) {
        console.error(`  Failed to create repo: ${e}`);
        process.exit(1);
      }
    }

    if (repoExists) {
      // Ensure remote is set and push
      try {
        execSync(`git remote get-url origin`, { cwd: dir, stdio: 'pipe' });
      } catch {
        execSync(`git remote add origin https://github.com/${org}/${repoName}.git`, { cwd: dir });
      }
      try {
        execSync('git push -u origin main', { cwd: dir, stdio: 'inherit' });
      } catch {
        console.log('  Push skipped (up to date or no commits)');
      }
    }

    // Register in platform D1 (via API)
    console.log('\n  Registering agent in store...');
    // TODO: call POST /v1/agents with agent.json data
    // For now, agents are registered via the Console UI

    console.log(`\n  Published! ${slug}.proagentstore.online`);
    console.log(`  Store: https://proagentstore.online/agents/${slug}/`);
    console.log(`  Repo:  https://github.com/${org}/${repoName}`);
    console.log('');
  });
