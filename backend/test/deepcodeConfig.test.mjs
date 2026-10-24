// Tests for the file DeepCode reads before it will start, and for the two fields in it that are
// not preferences.
//
// This has a test file because of how it failed in practice. A config with a provider, a key and a
// correct model name is enough for DeepCode to boot, print `Resolved workflow LLM`, accept a task
// and make its first tool call -- and then die on the second request, because DeepSeek serves with
// thinking on and wants its `reasoning_content` echoed back, which DeepCode only does when an
// effort level is set. Nothing about the config looks wrong at the point where it breaks, and the
// symptom (a turn that ends with an `invalid_request_error` about thinking mode) names nothing in
// this repo. Asserting the fields here is the only cheap place to notice them going missing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

fs.chownSync = () => {}; // this suite is about file contents, not ownership
process.env.SESSION_SECRET = 'test-secret-for-deepcode-config';

const abs = (p) => 'file://' + path.resolve(p).split(path.sep).join('/');
const { writeSettings } = await import(abs('backend/src/settings.js'));
const { writeDeepcodeConfig, deepcodeConfigured, CONFIG_REL } = await import(abs('backend/src/deepcode.js'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codez-dc-'));
const user = { id: 'u1', uid: 1000, gid: 1000, homeDir: home, projectsDir: path.join(home, 'projects') };

let pass = 0,
  fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('PASS  ' + label);
  } else {
    fail++;
    console.log('FAIL  ' + label + (extra ? '  :: ' + extra : ''));
  }
};
const config = () => JSON.parse(fs.readFileSync(path.join(home, CONFIG_REL), 'utf8'));

// Nothing chosen: no file, and no half-written one either. DeepCode treats a config it cannot
// make sense of worse than no config at all.
check('writes nothing until a provider is chosen', writeDeepcodeConfig(user).written === false);
check('and reports itself unconfigured', deepcodeConfigured(user) === false);

writeSettings(user, { deepcodeProvider: 'deepseek', deepcodeKey: 'sk-not-a-real-key' });
const written = writeDeepcodeConfig(user);
check('writes a config once a provider is chosen', written.written === true && deepcodeConfigured(user));

const dc = config();
check('names the provider', dc.agents.defaults.provider === 'deepseek');
check('fills in a model the provider actually serves', dc.agents.defaults.model === 'deepseek-v4-pro');

// The key stays in the environment. A config file is world-readable-by-accident in a way an
// encrypted settings blob is not, and `${ENV_VAR}` is DeepCode's own documented indirection.
const raw = fs.readFileSync(path.join(home, CONFIG_REL), 'utf8');
check('refers to the key by env var', dc.providers.deepseek.apiKey === '${DEEPCODE_API_KEY}');
check('never writes the key itself into the file', !raw.includes('sk-not-a-real-key'));

// The two that are not preferences.
check(
  'sets an effort level, which is what disables thinking',
  dc.agents.defaults.reasoningEffort === 'minimal',
  JSON.stringify(dc.agents.defaults)
);
check(
  'raises the token budget above the 8192 that truncated a tool call',
  dc.agents.defaults.maxTokens === 16384,
  String(dc.agents.defaults.maxTokens)
);

// A provider with no measured quirks gets none invented for it -- an effort level sent to OpenAI
// outside its reasoning models is rejected outright, so a blanket default would break more than
// it fixed.
writeSettings(user, { deepcodeProvider: 'openai', deepcodeModel: '' });
writeDeepcodeConfig(user);
const oai = config();
check('leaves effort unset for a provider without a thinking switch', oai.agents.defaults.reasoningEffort === undefined);
check('leaves the token budget at DeepCode default too', oai.agents.defaults.maxTokens === undefined);
check('still names that provider and its model', oai.agents.defaults.provider === 'openai' && oai.agents.defaults.model === 'gpt-4o-mini');
check('and keeps only the chosen provider in the file', Object.keys(oai.providers).join() === 'openai');

// A local provider has a base URL and no key; writing an empty apiKey would send DeepCode looking
// for a secret that does not exist.
writeSettings(user, { deepcodeProvider: 'ollama', deepcodeBaseUrl: 'http://127.0.0.1:11434/v1', deepcodeModel: 'qwen2.5-coder' });
writeDeepcodeConfig(user);
const olla = config();
check('gives a local provider its base URL', olla.providers.ollama.apiBase === 'http://127.0.0.1:11434/v1');
check('and no apiKey at all', !('apiKey' in olla.providers.ollama));

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
