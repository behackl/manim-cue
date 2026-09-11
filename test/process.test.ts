import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, Cancelled } from '../src/process';
const defaults = () => ({ cwd: process.cwd(), signal: new AbortController().signal, timeout: 5000 });

test('argument arrays preserve shell metacharacters; stdin closes', async () => {
  const output = await runProcess(process.execPath, ['-e', 'process.stdin.on("end",()=>console.log(process.argv[1]));process.stdin.resume()', 'a b; $(false)'], defaults());
  assert.equal(output.trim(), 'a b; $(false)');
});
test('failed processes report the executable and stderr rather than publishing success', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.error("primary failure");process.exit(3)'], defaults()),
    error => error instanceof Error && /Process exited with code 3/.test(error.message) && error.message.includes(process.execPath) && /primary failure/.test(error.message));
});
test('cancellation and timeout settle even with a waiting process', async () => {
  const controller = new AbortController();
  const job = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...defaults(), signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(job, Cancelled);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...defaults(), timeout: 100 }), /exceeded/);
});
test('a process that fails to start does not leave a pending job', async () => {
  await assert.rejects(runProcess('/no/such/python', [], defaults()), /ENOENT/);
});
