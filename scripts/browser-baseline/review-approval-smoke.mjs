/**
 * Opt-in real Codex + production LocalApplyRuntime review-continuation smoke.
 * Uses only isolated local synthetic forms and fake owner data. The synthetic supervisor below is
 * not evidence of deployed API/MCP approval delivery. Build browser-runner before running:
 * PAGS_ENGINE_SMOKE=1 node scripts/browser-baseline/review-approval-smoke.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalApplyRuntime } from '../../packages/browser-runner/dist/local-apply/runtime.js';
import { launchCdpBrowser } from '../../packages/browser-runner/dist/local-apply/live-run-browser.js';

if (process.env.PAGS_ENGINE_SMOKE !== '1') throw new Error('Set PAGS_ENGINE_SMOKE=1 to run this opt-in machine-login smoke.');
const root = mkdtempSync(join(tmpdir(), 'pags-live-review-approval-'));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const bridgeScript = fileURLToPath(new URL('../../packages/browser-runner/dist/local-browser/bridge-stdio.js', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = 'Full name: Jane Citizen\nEmail: jane.citizen@example.com\nCity: Melbourne\nAvailable to start immediately: Yes\n';
const resume = '# Jane Citizen\nTypeScript engineer, Sample Systems, 2020 to 2024.\n';
const cover = 'Dear synthetic employer, I would like to apply for this fixture.\n';
const html = (body) => `<!doctype html><html><head><title>Synthetic application</title><meta charset="utf-8"></head><body>${body}</body></html>`;
const forms = [
  html(`<h1>Fixture One: engineering application</h1><form action="/submit" method="post"><input type="hidden" name="fixture" value="one"><label>Full name <input name="full_name" required></label><label>Contact email <input type="email" name="email" required></label><label>City <input name="city" required></label><label>Workshop cohort label <input name="cohort_label" required></label><p>The cohort label is a required owner fact. Never invent it.</p><button type="button" onclick="document.querySelector('#check').textContent=this.form.checkValidity()?'All required fields complete':'Required fields missing'">Check completeness without sending</button><output id="check"></output><button type="submit">Submit application</button></form>`),
  html(`<h1>Fixture Two: staged expression of interest</h1><form action="/submit" method="post"><input type="hidden" name="fixture" value="two"><fieldset id="identity"><legend>Contact information</legend><label>Applicant name <input name="full_name" required></label><label>Email for responses <input type="email" name="email" required></label><label>Current city <input name="city" required></label><button type="button" onclick="document.querySelector('#availability').hidden=false;this.hidden=true">Continue to availability</button></fieldset><fieldset id="availability" hidden><legend>Availability</legend><label><input type="radio" name="available_now" value="yes" required>Available immediately</label><label><input type="radio" name="available_now" value="no">Unavailable immediately</label><button type="button" onclick="document.querySelector('#review').hidden=false;this.hidden=true">Review details</button></fieldset><section id="review" hidden><h2>Final review</h2><p>Review the entered fields above before sending this local test application.</p><button type="submit">Submit application</button></section></form>`),
];

async function exercise(index) {
  const caseRoot = join(root, `case-${index + 1}`); const home = join(caseRoot, 'home');
  mkdirSync(join(home, 'jobs/applications/lead/materials'), { recursive: true });
  writeFileSync(join(home, 'jobs/profile.md'), profile);
  writeFileSync(join(home, 'jobs/applications/lead/materials/resume.md'), resume);
  writeFileSync(join(home, 'jobs/applications/lead/materials/cover-letter.md'), cover);
  const submissions = [];
  const fixture = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      submissions.push({ at: Date.now(), fields: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())) });
      res.setHeader('Content-Type', 'text/html');
      res.end(html('<h1>Application submitted</h1><p id="receipt">Your application has been received by Synthetic Fixture Labs. Receipt: FIXTURE-ONLY-42.</p>'));
      return;
    }
    res.setHeader('Content-Type', 'text/html'); res.end(forms[index]);
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const applicationUrl = `http://127.0.0.1:${fixture.address().port}/form`;
  let selfUrl; let browser; let browserLaunches = 0; let engineLaunches = 0;
  let answerReceipt = null; let approvalReceipt = null; let reviewEvidence = null;
  const bridgeCalls = []; const runId = `synthetic-review-${randomUUID()}`;
  const artifacts = [{ kind: 'resume', path: '~/jobs/applications/lead/materials/resume.md', sha256: sha(resume) }, { kind: 'cover_letter', path: '~/jobs/applications/lead/materials/cover-letter.md', sha256: sha(cover) }];
  const exercisePrompt = '\n\nSYNTHETIC QA SCOPE: Act only on this local fake application. Fill all fields supported by the supplied fake profile, following observed controls. Do not invent missing required facts. If any are missing, record request_answer and call ready_for_review after independent work. If trusted answers return, apply them in this same page and validate. Once complete, call ready_for_review and wait for the exact scoped owner approval. After approval returns, read a fresh snapshot, validate the current page, obtain a fresh before_submit checkpoint, and use submit_application once. Do not use native clicks/code to submit. The fixture is authorized for exactly one submission after its synthetic owner grants approval. Verify its confirmation. Use a current screenshot before the final review.';
  const rt = new LocalApplyRuntime({
    dataDir: join(caseRoot, 'data'), homeDir: home, selfUrl: () => selfUrl, bridgeScript,
    spawn: (command, args, options) => { engineLaunches++; const extended = [...args]; extended[extended.length - 1] += exercisePrompt; return spawn(command, extended, options); },
    browserFor: async (_profile, runDir) => {
      browserLaunches++; browser = await launchCdpBrowser(join(runDir, 'profile'), true);
      return { tools: browser.mcp, handoffPage: browser.activePage, stop: () => browser.stop() };
    },
  });
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (!rt.authorizeBridge(String(body.runId ?? ''), String(req.headers['x-pags-bridge-token'] ?? ''))) { res.writeHead(401).end('{}'); return; }
      const out = await rt.bridge(body);
      bridgeCalls.push({ name: body.name, op: body.op, isError: out?.isError ?? false, error: out?.isError ? out.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n').slice(0, 1000) : undefined, imageCount: out?.content?.filter((block) => block.type === 'image').length ?? 0 });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  selfUrl = `http://127.0.0.1:${server.address().port}`;
  const started = Date.now();
  rt.start({ type: 'local_browser.apply', runId, requestId: runId, instanceId: 'synthetic-review-instance', applicationId: `synthetic-application-${index}`, engine: 'codex', model: process.env.PAGS_SMOKE_MODEL || 'gpt-6-astra', reasoningEffort: 'high', authMode: 'machine', browserProfile: 'isolated', applicationUrl, job: { title: 'Engineer', company: 'Synthetic Fixture Labs' }, workspace: '~/jobs', sources: [{ role: 'profile', path: 'profile.md' }], artifacts, policy: { mode: 'fill_and_review', toolAccess: 'full', toolAccessAcceptance: { revision: 'full_playwright_v1', acceptedAt: new Date().toISOString(), acceptedBy: 'synthetic-owner', instanceId: 'synthetic-review-instance' }, escalationLevel: 'autonomous', allowDomains: ['127.0.0.1'], blurFormFields: false }, limits: { maxMinutes: 5, maxPages: 8, maxActions: 100 } });
  let status; let lastProgress = '';
  try {
    for (let tick = 0; tick < 360; tick++) {
      await pause(1000); status = rt.status({ runId });
      const progress = `${status.state}:${status.pause?.reason || ''}:${status.events.at(-1)?.type || ''}`;
      if (progress !== lastProgress || tick % 30 === 0) {
        console.log(JSON.stringify({ case: index + 1, elapsedMs: Date.now() - started, progress, submissions: submissions.length }));
        lastProgress = progress;
      }
      if (status.state === 'paused' && status.pause?.answerWait && !answerReceipt) {
        const question = status.pause.answerWait.questions.find((q) => /cohort/i.test(q));
        assert(question, 'The synthetic missing fact must be requested, not invented');
        const pageBefore = browser.activePage();
        const out = rt.resume({ runId, expectedAnswerPauseKey: status.pause.handoffRequestId, answers: [{ question, answer: 'BLUEBIRD-42' }] });
        answerReceipt = { state: out.state, samePage: browser.activePage() === pageBefore, engineLaunches, browserLaunches };
      }
      if (status.state === 'paused' && status.pause?.reason === 'supervisor_checkpoint') {
        const cp = status.pause.checkpoint;
        if (cp.facts.reviewWait && !approvalReceipt) {
          const pageBefore = browser.activePage();
          reviewEvidence = { runId, checkpointId: cp.checkpointId, reviewWait: cp.facts.reviewWait, url: pageBefore.url(), fields: await pageBefore.locator('input').evaluateAll((elements) => elements.map((element) => ({ name: element.name, value: element.value, checked: element.checked }))), submissionsBefore: submissions.length, engineLaunches, browserLaunches };
          assert.equal(submissions.length, 0, 'No fixture submission before scoped approval');
          const out = rt.directive({ runId, schemaVersion: 1, checkpointId: cp.checkpointId, directive: 'continue', submitAuthorization: { id: 'synthetic-owner-grant', gateId: 'synthetic-submit-gate', instanceId: 'synthetic-review-instance', applicationId: `synthetic-application-${index}`, artifacts: artifacts.map(({ kind, sha256 }) => ({ kind, sha256 })) } });
          approvalReceipt = { state: out.state, samePage: browser.activePage() === pageBefore, engineLaunches, browserLaunches, at: Date.now() };
        } else {
          assert(cp.facts.phase !== 'before_submit' || approvalReceipt, 'A before-submit checkpoint needs prior scoped owner approval');
          rt.directive({ runId, schemaVersion: 1, checkpointId: cp.checkpointId, directive: 'continue' });
        }
      }
      if (status.state === 'ended') break;
    }
    if (status.state !== 'ended') rt.cancel({ runId });
    await pause(1000); status = rt.status({ runId });
    const report = { runId, applicationUrl, elapsedMs: Date.now() - started, state: status.state, result: status.result, model: status.events.filter((event) => event.type === 'engine.model_observed'), submissions, bridgeCalls, browserLaunches, engineLaunches, answerReceipt, reviewEvidence, approvalReceipt };
    writeFileSync(join(caseRoot, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(caseRoot, 'status.json'), JSON.stringify(status, null, 2));
    assert(reviewEvidence && approvalReceipt, 'Run must retain a review checkpoint and receive its approval');
    assert.equal(approvalReceipt.samePage, true); assert.equal(engineLaunches, 1); assert.equal(browserLaunches, 1);
    assert.equal(submissions.length, 1, 'Exactly one authoritative fixture POST');
    assert.equal(submissions[0].fields.full_name, 'Jane Citizen'); assert.equal(submissions[0].fields.email, 'jane.citizen@example.com'); assert.equal(submissions[0].fields.city, 'Melbourne');
    if (index === 0) { assert.equal(submissions[0].fields.cohort_label, 'BLUEBIRD-42'); assert(answerReceipt?.samePage); }
    else assert.equal(submissions[0].fields.available_now, 'yes');
    assert.equal(status.result?.outcome, 'submitted'); assert.equal(status.result?.submitted?.gateId, 'synthetic-submit-gate');
    assert.equal(bridgeCalls.filter((call) => call.name === 'submit_application' && !call.isError).length, 1);
    assert(bridgeCalls.some((call) => call.name === 'browser_take_screenshot' && call.imageCount > 0), 'The acting model must receive screenshot pixels');
    assert(report.model.some((event) => event.detail?.observedModel === (process.env.PAGS_SMOKE_MODEL || 'gpt-6-astra') && event.detail?.observedReasoningEffort === 'high'), 'Verify the effective local model and effort');
    return report;
  } finally { rt.closeAll(); server.close(); fixture.close(); }
}

const reports = [];
try {
  for (let index = 0; index < forms.length; index++) {
    reports.push(await exercise(index));
    console.log(`case ${index + 1}: same-run review approval and one fixture submission verified`);
  }
  writeFileSync(join(root, 'report.json'), JSON.stringify({ root, reports }, null, 2));
  console.log(JSON.stringify({ root, cases: reports.length, submissions: reports.reduce((count, report) => count + report.submissions.length, 0), syntheticSupervisor: true }));
} catch (error) { console.error(JSON.stringify({ root, error: error.message })); process.exitCode = 1; }
