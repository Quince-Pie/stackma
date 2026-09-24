import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, release, totalmem } from 'node:os';

const version = (command, args = ['--version']) => execFileSync(command, args, {
  encoding: 'utf8', timeout: 15_000,
}).trim();
if (!process.env.FIREFOX) throw new Error('Set FIREFOX to the verified browser executable');
const report = {
  date: new Date().toISOString(),
  commit: version('git', ['rev-parse', 'HEAD']),
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  event: process.env.GITHUB_EVENT_NAME,
  architecture: arch(), kernel: release(), logicalCpus: cpus().length,
  memoryBytes: totalmem(), node: process.version,
  npm: version('npm'), nix: version('nix'),
  firefox: version(process.env.FIREFOX),
  geckodriver: version(process.env.GECKODRIVER ?? 'geckodriver'),
  actionlint: version('actionlint'), zizmor: version('zizmor'),
};
await mkdir('artifacts/ci', { recursive: true });
await writeFile('artifacts/ci/environment.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
